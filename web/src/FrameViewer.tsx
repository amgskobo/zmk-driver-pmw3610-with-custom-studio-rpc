import { useContext, useEffect, useRef, useState } from "react";
import {
  ZMKCustomSubsystem,
  ZMKAppContext,
} from "@cormoran/zmk-studio-react-hook";
import {
  FrameStreamChunk,
  Notification as PMW3610Notification,
  Request,
  Response,
} from "./proto/cormoran/pmw3610/pmw3610";
import {
  assembleFrame,
  chunkOffsets,
  createFrameAssembler,
  frameToRgba,
  isValidPixelByte,
  PixelFormat,
  type FrameChunk,
} from "./frame";
import { isUnlockRequiredError } from "./useStudioLockState";
import { callPmw3610Request, PeripheralResponseCorrelator } from "./relay";

export const PMW3610_SUBSYSTEM_IDENTIFIER = "cormoran__pmw3610";

const SIDE_OPTIONS = [19, 20, 21, 22];
const DEFAULT_SIDE = 22;
const PIXEL_SCALE = 12; // px per sensor pixel on <canvas>

interface AdvancedOptions {
  maxInvalidRetries: string;
}

interface FrameSession {
  active: boolean;
  operation: "capture" | "start" | "stop" | null;
  retired: boolean;
  generation: number;
  side: number;
  source: number;
  correlator: PeripheralResponseCorrelator;
  stop?: () => Promise<boolean>;
}

const DEFAULT_ADVANCED: AdvancedOptions = {
  maxInvalidRetries: "",
};

export interface FrameViewerProps {
  /** True while ZMK Studio is locked -- disables capture/streaming
   * controls (the underlying RPC calls would fail with UNLOCK_REQUIRED
   * anyway). Any active stream is stopped firmware-side automatically on
   * lock (see src/studio/pmw3610_handler.c's lock listener), so the UI
   * state is reset to match when this flips to true. */
  locked?: boolean;
}

export function FrameViewer({ locked = false }: FrameViewerProps = {}) {
  const zmkApp = useContext(ZMKAppContext);
  const subsystem = zmkApp?.findSubsystem(PMW3610_SUBSYSTEM_IDENTIFIER);
  const connection = zmkApp?.state.connection;

  const [side, setSide] = useState(DEFAULT_SIDE);
  const [deviceIndex, setDeviceIndex] = useState(0);
  // 0 = this device's own local PMW3610s; 1+ = a split peripheral's, relayed
  // asynchronously (see DESIGN.md Phase F / web/src/relay.ts).
  const [source, setSource] = useState(0);
  const [advanced, setAdvanced] = useState<AdvancedOptions>(DEFAULT_ADVANCED);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [streamState, setStreamState] = useState({
    streaming: false,
    changing: false,
  });
  const { streaming: isStreaming, changing: isStreamChanging } = streamState;
  const [invalidCount, setInvalidCount] = useState<number | null>(null);
  const [pixelCount, setPixelCount] = useState<number | null>(null);
  const [complete, setComplete] = useState<boolean | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [streamSource, setStreamSource] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameCountRef = useRef(0);
  const fpsWindowStartRef = useRef(0);
  const sessionRef = useRef<FrameSession | null>(null);
  // Per-frame_id incremental assembler, keyed so a late chunk from a
  // previous frame_id (should not happen, but notifications are
  // best-effort/unordered in principle) cannot corrupt the current frame.
  const assemblersRef = useRef(
    new Map<number, ReturnType<typeof createFrameAssembler>>()
  );

  useEffect(() => {
    const session: FrameSession = {
      active: false,
      operation: null,
      retired: false,
      generation: 0,
      side: DEFAULT_SIDE,
      source: 0,
      correlator: new PeripheralResponseCorrelator(),
    };
    sessionRef.current = session;
    // Reset controls when the external connection/subsystem changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStreamState({ streaming: false, changing: false });
    setIsCapturing(false);
    return () => {
      session.retired = true;
      // Retire a pending start as well as an active stream. A pending stop
      // already targets this connection; do not issue it twice.
      if (session.operation !== "stop") {
        void session.stop?.().catch(() => undefined);
      }
      session.active = false;
      session.correlator.clear("Subsystem changed or component unmounted");
    };
  }, [connection, subsystem?.index]);

  const callRequest = async (
    request: Request,
    session: FrameSession
  ): Promise<Response> => {
    if (!connection || !subsystem) {
      throw new Error("PMW3610 subsystem is not available");
    }
    const service = new ZMKCustomSubsystem(connection, subsystem.index);
    const payload = Request.encode(request).finish();
    return callPmw3610Request(service, payload, session.correlator);
  };

  const captureOnce = async (
    session: FrameSession,
    generation: number
  ): Promise<void> => {
    const current = () => !session.retired && session.generation === generation;
    const pixelCountRequested = side * side;
    const captureResp = await callRequest(
      Request.create({
        captureFrame: {
          deviceIndex,
          source,
          pixelCount: pixelCountRequested,
          maxInvalidRetries: advanced.maxInvalidRetries
            ? Number.parseInt(advanced.maxInvalidRetries, 10)
            : 0,
        },
      }),
      session
    );
    if (!current()) return;
    if (captureResp.error) {
      throw new Error(captureResp.error.message);
    }
    const captureFrame = captureResp.captureFrame;
    if (!captureFrame) {
      throw new Error("CaptureFrame response missing capture_frame field");
    }

    const chunkSize = captureFrame.chunkSize || 128;
    const totalLength = captureFrame.pixelCount;
    const offsets = chunkOffsets(totalLength, chunkSize);
    const chunks: FrameChunk[] = [];
    for (const offset of offsets) {
      const chunkResp = await callRequest(
        Request.create({
          getFrameChunk: { frameId: captureFrame.frameId, offset, source },
        }),
        session
      );
      if (!current()) return;
      if (chunkResp.error) {
        throw new Error(chunkResp.error.message);
      }
      const chunk = chunkResp.getFrameChunk;
      if (!chunk) {
        throw new Error("GetFrameChunk response missing get_frame_chunk field");
      }
      chunks.push({ offset: chunk.offset, data: chunk.data });
    }

    // Old firmware never sets `format`, which decodes to the enum's zero
    // value -- PIXEL_FORMAT_PG7, already the desired default.
    const format = captureFrame.format ?? PixelFormat.PIXEL_FORMAT_PG7;
    const assembled = assembleFrame(chunks, totalLength, format);
    renderFrame(assembled.bytes, side, format);
    setInvalidCount(assembled.invalidCount);
    setPixelCount(totalLength);
    setComplete(captureFrame.complete);
    setDurationMs(captureFrame.durationMs);
  };

  const renderFrame = (
    bytes: Uint8Array,
    sideLength: number,
    format: PixelFormat = PixelFormat.PIXEL_FORMAT_PG7
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = sideLength * PIXEL_SCALE;
    canvas.height = sideLength * PIXEL_SCALE;

    const rgba = frameToRgba(bytes, format);
    // Draw at 1x onto an offscreen buffer, then scale up with
    // nearest-neighbor via imageSmoothingEnabled = false.
    const off = document.createElement("canvas");
    off.width = sideLength;
    off.height = sideLength;
    const offCtx = off.getContext("2d");
    if (!offCtx) return;
    // ImageData's constructor wants a Uint8ClampedArray<ArrayBuffer>
    // specifically; frameToRgba()'s return type is the more general
    // Uint8ClampedArray<ArrayBufferLike> so it stays independent of DOM
    // lib types for testability. Copying into a plain ArrayBuffer-backed
    // array satisfies the stricter DOM type without changing frame.ts.
    const height = Math.ceil(bytes.length / sideLength);
    const paddedRgba = new Uint8ClampedArray(sideLength * height * 4);
    paddedRgba.set(rgba);
    const imageData = new ImageData(paddedRgba, sideLength, height);
    offCtx.putImageData(imageData, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      off,
      0,
      0,
      sideLength,
      sideLength,
      0,
      0,
      canvas.width,
      canvas.height
    );
  };

  const handleCaptureOnce = async () => {
    const session = sessionRef.current;
    if (!session || session.operation || session.active || locked) return;
    session.operation = "capture";
    const generation = session.generation;
    setIsCapturing(true);
    setError(null);
    try {
      await captureOnce(session, generation);
    } catch (e) {
      if (session.retired || session.generation !== generation) return;
      if (isUnlockRequiredError(e)) {
        setError(
          "ZMK Studio is locked -- press the Studio unlock key on your keyboard."
        );
      } else {
        setError(e instanceof Error ? e.message : "Unknown error");
      }
    } finally {
      session.operation = null;
      if (!session.retired) setIsCapturing(false);
    }
  };

  // Notification-based streaming (Phase E): SetFrameStream{enable: true}
  // starts a firmware-side capture loop that raises one FrameStreamChunk
  // notification per 128-byte chunk of every captured frame, instead of
  // this component polling CaptureFrame+GetFrameChunk in a loop. Ignored
  // unless this connection owns an active stream, so a
  // stray/late chunk after Stop Streaming doesn't render.
  const handleFrameStreamNotification = (chunk: FrameStreamChunk) => {
    const session = sessionRef.current;
    if (
      !session?.active ||
      session.retired ||
      chunk.source !== session.source
    ) {
      return;
    }
    if (chunk.totalSize <= 0 || chunk.totalSize > session.side * session.side) {
      return;
    }

    const assemblers = assemblersRef.current;
    // A new frame_id means any previous (necessarily incomplete, or it
    // would have been rendered and removed already) assembler for an
    // older frame is stale -- drop it rather than let the map grow
    // unbounded across a long streaming session.
    for (const key of assemblers.keys()) {
      if (key !== chunk.frameId) {
        assemblers.delete(key);
      }
    }

    let assembler = assemblers.get(chunk.frameId);
    if (!assembler) {
      assembler = createFrameAssembler(chunk.totalSize);
      assemblers.set(chunk.frameId, assembler);
    }

    const isComplete = assembler.addChunk(chunk.offset, chunk.data);
    if (!isComplete) {
      return;
    }
    assemblers.delete(chunk.frameId);

    // Old firmware never sets `format`, which decodes to the enum's zero
    // value -- PIXEL_FORMAT_PG7, already the desired default.
    const format = chunk.format ?? PixelFormat.PIXEL_FORMAT_PG7;
    const bytes = assembler.getBytes();
    let invalidCount = 0;
    for (const b of bytes) {
      if (!isValidPixelByte(b, format)) invalidCount++;
    }

    renderFrame(bytes, session.side, format);
    setInvalidCount(invalidCount);
    setPixelCount(chunk.totalSize);
    setComplete(chunk.complete);
    setDurationMs(null); // not reported per-frame while streaming
    setStreamSource(chunk.source);

    frameCountRef.current++;
    const now = performance.now();
    const elapsed = now - fpsWindowStartRef.current;
    if (elapsed >= 1000) {
      setFps((frameCountRef.current * 1000) / elapsed);
      frameCountRef.current = 0;
      fpsWindowStartRef.current = now;
    }
  };

  const setFrameStream = async (
    enable: boolean,
    session: FrameSession
  ): Promise<boolean> => {
    const resp = await callRequest(
      Request.create({
        setFrameStream: {
          deviceIndex,
          source,
          enable,
          pixelCount: enable ? side * side : 0,
          maxInvalidRetries: advanced.maxInvalidRetries
            ? Number.parseInt(advanced.maxInvalidRetries, 10)
            : 0,
        },
      }),
      session
    );
    if (resp.error) {
      throw new Error(resp.error.message);
    }
    if (!resp.setFrameStream) {
      throw new Error("SetFrameStream response missing set_frame_stream field");
    }
    return resp.setFrameStream.streaming;
  };

  const stopStreaming = async () => {
    const session = sessionRef.current;
    if (!session?.active || session.operation || !session.stop) return;
    session.operation = "stop";
    const generation = session.generation;
    setStreamState({ streaming: true, changing: true });
    setError(null);
    try {
      if (await session.stop()) {
        throw new Error("The device still reports an active frame stream");
      }
      session.active = false;
      session.stop = undefined;
    } catch (e) {
      if (!session.retired && session.generation === generation) {
        setError(e instanceof Error ? e.message : "Unknown error");
      }
    } finally {
      session.operation = null;
      if (!session.retired) {
        setStreamState({ streaming: session.active, changing: false });
      }
    }
  };

  const startStreaming = async () => {
    const session = sessionRef.current;
    if (!session || session.operation || session.active || locked || !subsystem)
      return;
    session.operation = "start";
    session.side = side;
    session.source = source;
    session.stop = () => setFrameStream(false, session);
    const generation = session.generation;
    setStreamState({ streaming: false, changing: true });
    setError(null);
    assemblersRef.current.clear();
    frameCountRef.current = 0;
    fpsWindowStartRef.current = performance.now();
    setFps(null);
    setStreamSource(null);

    try {
      const streaming = await setFrameStream(true, session);
      if (session.retired || session.generation !== generation) {
        if (streaming) await session.stop().catch(() => undefined);
        return;
      }
      session.active = streaming;
      if (!streaming) session.stop = undefined;
    } catch (e) {
      if (session.retired || session.generation !== generation) return;
      if (isUnlockRequiredError(e)) {
        setError(
          "ZMK Studio is locked -- press the Studio unlock key on your keyboard."
        );
      } else {
        setError(e instanceof Error ? e.message : "Unknown error");
      }
    } finally {
      session.operation = null;
      if (!session.retired) {
        setStreamState({ streaming: session.active, changing: false });
      }
    }
  };

  // A single always-on subscription (not tied to the streaming lifecycle)
  // handles both this component's own relayed requests (CaptureFrame/
  // GetFrameChunk/SetFrameStream with source != 0 answer asynchronously via
  // PeripheralResponse -- see web/src/relay.ts) and FrameStreamChunk
  // notifications, which handleFrameStreamNotification itself gates on
  // the owned session so a stray chunk after Stop Streaming is dropped.
  useEffect(() => {
    if (!zmkApp || !subsystem) return;
    let retired = false;
    const correlator = sessionRef.current?.correlator;
    if (!correlator) return;
    const unsubscribe = zmkApp.onNotification({
      type: "custom",
      subsystemIndex: subsystem.index,
      callback: (notification) => {
        if (retired) return;
        if (correlator.handleNotificationPayload(notification.payload)) {
          return;
        }
        let decoded: PMW3610Notification;
        try {
          decoded = PMW3610Notification.decode(notification.payload);
        } catch {
          return;
        }
        if (decoded.frameStreamChunk) {
          handleFrameStreamNotification(decoded.frameStreamChunk);
        }
      },
    });
    return () => {
      retired = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zmkApp, connection, subsystem?.index]);

  // If Studio locks while streaming, the firmware stops the stream loop on
  // its own (see the lock listener in pmw3610_handler.c) -- but it does not
  // (and cannot, notifications aren't request/response) tell the client
  // it did so. Reset the UI's streaming state to match so the "Start
  // Streaming" button becomes available again once unlocked, instead of
  // staying stuck showing "Stop Streaming" for a stream that no longer
  // exists.
  useEffect(() => {
    const session = sessionRef.current;
    if (locked && session) {
      session.generation++;
      session.active = false;
      // Reacting to an external system (the firmware silently stopping the
      // stream on lock) becoming out of sync with local UI state, not a
      // derived-state anti-pattern -- see the comment above.
      setStreamState({
        streaming: false,
        changing: session.operation === "start" || session.operation === "stop",
      });
    }
    // Only react to the lock transition, not every isStreaming change.
  }, [locked, connection, subsystem?.index]);

  if (!zmkApp) return null;

  if (!subsystem) {
    return (
      <section className="card">
        <h2>Frame Viewer</h2>
        <div className="warning-message">
          <p>
            Subsystem &quot;{PMW3610_SUBSYSTEM_IDENTIFIER}&quot; not found. Make
            sure your firmware includes the PMW3610 module with
            CONFIG_ZMK_PMW3610_STUDIO_RPC=y.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Frame Viewer</h2>
      <p>
        Captures a still image from the sensor using the official PMW3610
        Pixel_Grab procedure (full array is 22 x 22). Capturing briefly
        interrupts mouse motion while the sensor resets afterwards.
      </p>

      <div className="form-grid">
        <label htmlFor="side-select">Size</label>
        <select
          id="side-select"
          value={side}
          onChange={(e) => setSide(Number(e.target.value))}
          disabled={isCapturing || isStreaming || isStreamChanging || locked}
        >
          {SIDE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} x {n} ({n * n} px)
            </option>
          ))}
        </select>

        <label htmlFor="frame-device-index">Device index</label>
        <input
          id="frame-device-index"
          type="number"
          min={0}
          value={deviceIndex}
          onChange={(e) => setDeviceIndex(Number(e.target.value))}
          disabled={isCapturing || isStreaming || isStreamChanging || locked}
        />

        <label htmlFor="frame-source">Split source</label>
        <input
          id="frame-source"
          type="number"
          min={0}
          value={source}
          onChange={(e) => setSource(Number(e.target.value))}
          disabled={isCapturing || isStreaming || isStreamChanging || locked}
          title="0 = this device's own sensors; 1+ = a split peripheral's, relayed asynchronously"
        />
      </div>

      <div className="toolbar">
        <button
          className="btn btn-primary"
          disabled={isCapturing || isStreaming || isStreamChanging || locked}
          onClick={() => void handleCaptureOnce()}
        >
          {isCapturing ? "Capturing..." : "Capture Once"}
        </button>
        {isStreaming ? (
          <button
            className="btn btn-danger"
            disabled={isStreamChanging}
            onClick={() => void stopStreaming()}
          >
            {isStreamChanging ? "Stopping..." : "Stop Streaming"}
          </button>
        ) : (
          <button
            className="btn"
            disabled={isCapturing || isStreamChanging || locked}
            onClick={() => void startStreaming()}
          >
            {isStreamChanging ? "Starting..." : "Start Streaming"}
          </button>
        )}
      </div>

      <details
        className="advanced-panel"
        open={showAdvanced}
        onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
      >
        <summary>Advanced (capture tuning)</summary>
        <div className="form-grid">
          <label htmlFor="max-invalid-retries">
            Capture wait (0 = default)
          </label>
          <input
            id="max-invalid-retries"
            type="number"
            min={0}
            max={100}
            value={advanced.maxInvalidRetries}
            disabled={isCapturing || isStreaming || isStreamChanging || locked}
            onChange={(e) =>
              setAdvanced({ ...advanced, maxInvalidRetries: e.target.value })
            }
            placeholder="0"
          />
          <small>
            RAW8: post-arm wait in ms. PG7: 10 ms ready-wait retry units.
          </small>
        </div>
      </details>

      {error && (
        <div className="error-message">
          <p>{error}</p>
        </div>
      )}

      <div className="frame-canvas-wrap">
        <canvas ref={canvasRef} className="frame-canvas" />
      </div>

      <dl className="setting-summary">
        <div>
          <dt>Pixels captured</dt>
          <dd>{pixelCount ?? "-"}</dd>
        </div>
        <div>
          <dt>Complete</dt>
          <dd>
            {complete === null ? "-" : complete ? "yes" : "no"}
            {complete === false && (
              <span className="warning-inline"> (sensor: not all 484)</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Capture time</dt>
          <dd>{durationMs !== null ? `${durationMs} ms` : "-"}</dd>
        </div>
        <div>
          <dt>Invalid bytes</dt>
          <dd>
            {invalidCount ?? "-"}
            {invalidCount !== null && invalidCount > 0 && (
              <span className="warning-inline"> (PG_Valid clear)</span>
            )}
          </dd>
        </div>
        <div>
          <dt>FPS (streaming)</dt>
          <dd>{fps !== null ? fps.toFixed(1) : "-"}</dd>
        </div>
        {streamSource !== null && (
          <div>
            <dt>Stream source</dt>
            <dd>
              {streamSource === 0 ? "local" : `peripheral ${streamSource}`}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
