// Split relay support (DESIGN.md Phase F): a request with a nonzero
// `source` is answered asynchronously -- the RPC call returns a
// `DeferredResponse{requestId}` immediately, and the real Response arrives
// later as a `PeripheralResponse{source, requestId, response}` Studio
// notification. This module correlates the two by requestId, independent
// of any React component -- pure and unit-testable without a DOM/canvas.

import { Notification, Response } from "./proto/cormoran/pmw3610/pmw3610";

const DEFAULT_TIMEOUT_MS = 6000; // > firmware's ~5s frame-capture deadline
const DEFAULT_BROADCAST_WINDOW_MS = 2000;
const MAX_EARLY_RESPONSES = 64;

/**
 * GetInfoRequest.source sentinel ("list every PMW3610 across the whole
 * keyboard" -- see pmw3610.proto's doc comment on GetInfoRequest). Local
 * devices are returned synchronously (same call, same as source: 0); any
 * connected peripheral's devices arrive afterwards as separate
 * PeripheralResponse notifications sharing GetInfoResponse.relayRequestId,
 * collected via PeripheralResponseCorrelator.collectBroadcast().
 */
export const PMW3610_SOURCE_ALL = 0xffffffff;

interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface BroadcastListener {
  onResponse: (source: number, response: Response) => void;
}

interface SourcedResponse {
  source: number;
  response: Response;
}

interface EarlyBroadcast {
  responses: SourcedResponse[];
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Tracks relayed requests awaiting their PeripheralResponse notification.
 * One instance is enough per subsystem connection -- requestId is assigned
 * by the firmware from a single counter, so concurrent callers (e.g.
 * multiple UI panels) sharing one correlator never collide.
 */
export class PeripheralResponseCorrelator {
  private pending = new Map<number, PendingRequest>();
  private broadcastListeners = new Map<number, BroadcastListener>();
  private rpcWindows = new Set<Map<number, SourcedResponse[]>>();
  private earlyBroadcasts = new Map<number, EarlyBroadcast>();
  private generation = 0;
  private clearReason = "Connection changed";

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  /** Buffer only while an RPC is awaiting its immediate reply. The split
   * notification can precede that reply, before its request id is known.
   * Windows are bounded and closed by the caller even when the RPC fails. */
  beginRpc() {
    const generation = this.generation;
    const responses = new Map<number, SourcedResponse[]>();
    this.rpcWindows.add(responses);
    return {
      assertCurrent: () => {
        if (generation !== this.generation) {
          throw new Error(this.clearReason);
        }
      },
      responseFor: (requestId: number) =>
        responses.get(requestId)?.[0]?.response,
      broadcastFor: (requestId: number) => responses.get(requestId) ?? [],
      close: () => {
        this.rpcWindows.delete(responses);
        responses.clear();
      },
    };
  }

  /** Bridge the immediate GetInfo reply to the caller's collection window,
   * including replies received before the relay request id was known. */
  prepareBroadcast(requestId: number, responses: SourcedResponse[]): void {
    const old = this.earlyBroadcasts.get(requestId);
    if (old) clearTimeout(old.timeoutId);
    if (this.earlyBroadcasts.size >= MAX_EARLY_RESPONSES) {
      const oldest = this.earlyBroadcasts.keys().next().value!;
      clearTimeout(this.earlyBroadcasts.get(oldest)!.timeoutId);
      this.earlyBroadcasts.delete(oldest);
    }
    this.earlyBroadcasts.set(requestId, {
      responses: [...responses],
      timeoutId: setTimeout(
        () => this.earlyBroadcasts.delete(requestId),
        this.timeoutMs
      ),
    });
  }

  /** Register interest in `requestId`'s eventual PeripheralResponse. */
  waitFor(requestId: number): Promise<Response> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `Timed out waiting for a PeripheralResponse to request ${requestId}`
          )
        );
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeoutId });
    });
  }

  /**
   * Collect every PeripheralResponse for `requestId` (a
   * GetInfoResponse.relayRequestId from a `source: PMW3610_SOURCE_ALL` call)
   * that arrives within `windowMs`, then resolve with all of them. Unlike
   * waitFor(), this expects zero or more responses (one per connected
   * peripheral) rather than exactly one, so it always resolves once the
   * window elapses instead of timing out.
   */
  collectBroadcast(
    requestId: number,
    windowMs: number = DEFAULT_BROADCAST_WINDOW_MS
  ): Promise<Array<{ source: number; response: Response }>> {
    const early = this.earlyBroadcasts.get(requestId);
    if (early) clearTimeout(early.timeoutId);
    this.earlyBroadcasts.delete(requestId);
    return new Promise((resolve) => {
      const results: Array<{ source: number; response: Response }> = [
        ...(early?.responses ?? []),
      ];
      this.broadcastListeners.set(requestId, {
        onResponse: (source, response) => results.push({ source, response }),
      });
      setTimeout(() => {
        this.broadcastListeners.delete(requestId);
        resolve(results);
      }, windowMs);
    });
  }

  /**
   * Feed a raw Studio custom-notification payload. Resolves a matching
   * pending waitFor()/collectBroadcast() registration (if any) when it
   * decodes to a PeripheralResponse with a response payload. Returns true if
   * it was consumed by one of them.
   */
  handleNotificationPayload(payload: Uint8Array): boolean {
    let notification: Notification;
    try {
      notification = Notification.decode(payload);
    } catch {
      return false;
    }
    const peripheralResponse = notification.peripheralResponse;
    if (!peripheralResponse || !peripheralResponse.response) {
      return false;
    }
    const { source, requestId, response } = peripheralResponse;
    if (this.resolve(requestId, response)) {
      return true;
    }
    const broadcastListener = this.broadcastListeners.get(requestId);
    if (broadcastListener) {
      broadcastListener.onResponse(source, response);
      return true;
    }
    const early = this.earlyBroadcasts.get(requestId);
    if (early) {
      this.addEarlyResponse(early.responses, source, response);
      return true;
    }
    for (const responses of this.rpcWindows) {
      const existing = responses.get(requestId);
      if (existing) {
        this.addEarlyResponse(existing, source, response);
        continue;
      }
      if (responses.size >= MAX_EARLY_RESPONSES) {
        responses.delete(responses.keys().next().value!);
      }
      responses.set(requestId, [{ source, response }]);
    }
    return false;
  }

  private addEarlyResponse(
    responses: SourcedResponse[],
    source: number,
    response: Response
  ): void {
    if (
      responses.length < MAX_EARLY_RESPONSES &&
      !responses.some((entry) => entry.source === source)
    ) {
      responses.push({ source, response });
    }
  }

  private resolve(requestId: number, response: Response): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(requestId);
    pending.resolve(response);
    return true;
  }

  /** Reject every still-pending waitFor() request (e.g. on disconnect/
   * unmount). Pending collectBroadcast() windows are left to resolve with
   * whatever they already collected -- there's nothing to "reject" about
   * partial inventory data. */
  clear(reason: string): void {
    this.generation++;
    this.clearReason = reason;
    for (const responses of this.rpcWindows) responses.clear();
    this.rpcWindows.clear();
    for (const early of this.earlyBroadcasts.values())
      clearTimeout(early.timeoutId);
    this.earlyBroadcasts.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/**
 * Send `request` over `service` and resolve with the real Response --
 * transparently awaiting the correlated PeripheralResponse notification if
 * the immediate reply is a DeferredResponse (source != 0).
 */
export async function callPmw3610Request(
  service: {
    callRPC(payload: Uint8Array): Promise<Uint8Array | null | undefined>;
  },
  encodedRequest: Uint8Array,
  correlator: PeripheralResponseCorrelator
): Promise<Response> {
  const window = correlator.beginRpc();
  try {
    const responsePayload = await service.callRPC(encodedRequest);
    window.assertCurrent();
    if (!responsePayload) {
      throw new Error("Empty response");
    }
    const response = Response.decode(responsePayload);
    if (response.deferred) {
      return (
        window.responseFor(response.deferred.requestId) ??
        correlator.waitFor(response.deferred.requestId)
      );
    }
    if (response.getInfo?.relayRequestId) {
      correlator.prepareBroadcast(
        response.getInfo.relayRequestId,
        window.broadcastFor(response.getInfo.relayRequestId)
      );
    }
    return response;
  } finally {
    window.close();
  }
}
