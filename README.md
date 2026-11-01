# zmk-driver-pmw3610-with-custom-studio-rpc

Maintenance fork of [cormoran/zmk-driver-pmw3610-with-custom-studio-rpc](https://github.com/cormoran/zmk-driver-pmw3610-with-custom-studio-rpc).
The source baseline is `5c34ea0eec246a1c986111417cd779b53144629a`.
Firmware, protocol and existing test assertions are retained. Validation must
identify the selected source and dependencies; physical sensor, split, timing
and transport acceptance require a separate matching hardware check.

ZMK module providing the [PMW3610](https://github.com/cormoran/zmk-pmw3610-driver)
optical mouse sensor driver, with a Web UI and an **unofficial** custom ZMK
Studio RPC protocol for sensor info/diagnostics, runtime settings, raw
register access, and frame (image) capture.

This is a drop-in replacement for `cormoran/zmk-pmw3610-driver` (same
devicetree compatible `cormoran,pmw3610`) — do not use both modules together.

See [DESIGN.md](./DESIGN.md) for the full module design and roadmap.

## Security — read this before adopting the module

**The entire `cormoran__pmw3610` Studio RPC subsystem is SECURED.** ZMK
Studio must be *unlocked* before any of this subsystem's RPCs succeed —
including read-only ones like `GetInfo`/`ReadDiagnostics`. This is not
configurable per-method: ZMK's custom-subsystem RPC dispatch checks lock
state once per subsystem, not per request, and `WriteRegister` (an
unvalidated raw sensor register write) is reason enough to secure the whole
thing rather than leave it open by default.

Two important consequences for anyone adding this module to a keyboard:

1. **Unlocking is physical-key-only in this ZMK fork.** There is no RPC or
   PIN-based unlock (`zmk.core.Request` only exposes `getDeviceInfo` /
   `getLockState` / `lock` / `resetSettings` — no `unlock`). A
   `&studio_unlock` behavior binding calls `zmk_studio_core_unlock()`
   directly when pressed
   (`dependencies/zmk/app/src/behaviors/behavior_studio_unlock.c`). **Your
   keyboard's keymap MUST bind `&studio_unlock` somewhere**, or once Studio
   locks there is no way to use this module's RPCs (including the web UI)
   again without reflashing a keymap that has the binding. See
   `tests/zmk-config/config/tester_xiao.keymap` for an example override.
2. **Studio auto-locks.** By default (`CONFIG_ZMK_STUDIO_LOCKING`, on for
   any non-`native_sim` board) it locks after
   `CONFIG_ZMK_STUDIO_LOCK_IDLE_TIMEOUT_SEC` (default 600s) of RPC idleness
   and whenever BLE disconnects
   (`CONFIG_ZMK_STUDIO_LOCK_ON_DISCONNECT`). If the web UI suddenly shows a
   "locked" banner and stops working, this is why — press the keyboard's
   `&studio_unlock` key and it resumes automatically.

Frame-streaming *notifications* (see "Frame capture" below) are not
gated by lock state at the transport level, only the RPC call that
starts/stops a stream is secured — a stream already running keeps emitting
notifications through a later auto-lock unless something stops it, so the
firmware itself retires the local stream and broadcasts a stop to split
peripherals when Studio locks. The central also discards queued and late
peripheral data from the retired session. A later unlock alone does not
resume forwarding images; start a new stream explicitly.

## Summary

This module currently includes (Phase A through Phase E):

- **Firmware**: PMW3610 sensor driver (`src/pmw3610.c`) with a
  runtime-configurable parameter set (cpi, axis flags, force-awake, smart
  algorithm, downshift/sample times, minimum report interval — see
  `include/cormoran/pmw3610/pmw3610_api.h`), a **secured** custom Studio RPC
  handler (`src/studio/pmw3610_handler.c`) exposing sensor info/diagnostics/
  raw register access/frame capture/frame streaming, and an optional
  settings integration (`src/settings/pmw3610_settings.c`) via
  [zmk-feature-custom-settings](https://github.com/cormoran/zmk-feature-custom-settings).
- **Protocol**: Protobuf definition (`proto/cormoran/pmw3610/pmw3610.proto`) —
  `GetInfo` (per-device info + runtime config snapshot), `ReadDiagnostics`,
  `ReadRegister`/`WriteRegister`, `CaptureFrame`/`GetFrameChunk`,
  `SetFrameStream` (notification-based streaming) plus a `Notification`
  message carrying `FrameStreamChunk`.
- **Web UI**: React + TypeScript app (`web/`) using
  [@cormoran/zmk-studio-react-hook](https://github.com/cormoran/react-zmk-studio) —
  sensor info/diagnostics cards, a generic settings editor (talking to
  zmk-feature-custom-settings' own Studio RPC subsystem), a frame viewer
  (capture-once / notification-based streaming, canvas rendering, FPS
  counter), and a Studio lock-state banner that disables controls while
  locked.
- **Tests**: Firmware unit tests (`tests/studio/`), build tests
  (`tests/zmk-config/`, including a `pmw3610_settings_rpc` artifact that
  builds with custom settings enabled), and web unit tests (`web/test/`,
  including pure-function tests for frame chunk reassembly/streaming
  assembly).

The frame-capture procedure implements the PMW3610 `Pixel_Grab` sequence
described below. This fork does not publish individual hardware histories or
claim a new physical validation. The secured subsystem replaces the web UI's
client-driven streaming loop with firmware-pushed notifications (see "Security" above and
"Frame capture" below).

## More Info

For more info on modules, you can read through through the [Zephyr modules page](https://docs.zephyrproject.org/3.5.0/develop/modules.html) and [ZMK's page on using modules](https://zmk.dev/docs/features/modules). [Zephyr's west manifest page](https://docs.zephyrproject.org/3.5.0/develop/west/manifest.html#west-manifests) may also be of use.

## Module User Guide

1. Add dependency to your `config/west.yml`. Note: this module requires a patched ZMK with custom Studio RPC support.

   ```yml
   manifest:
       remotes:
           ...
           - name: amgskobo
             url-base: https://github.com/amgskobo
           - name: cormoran
             url-base: https://github.com/cormoran
       projects:
           ...
           - name: zmk-driver-pmw3610-with-custom-studio-rpc
           remote: amgskobo
           revision: d9d917f16cf830d6abf87877f18d85fce880ac75
           import: true
           ...
           # Required: patched ZMK with custom Studio RPC support
           - name: zmk
           remote: cormoran
           revision: e5c9b6915b56801193e359dd9bad4a167ce0d1b8
           import:
               file: app/west.yml
   ```

   The module's continuation branch is `codex/pmw3610-driver-review`.
   Select an explicitly reviewed commit when updating this example. Local
   uncommitted changes require a local source override and are not included
   in the committed revision above.

2. Add the sensor to your board/shield overlay (see
   `tests/zmk-config/snippets/pmw3610-trackball/pmw3610-trackball.overlay` for
   a full example) and enable the driver in your `config/<shield>.conf`:

   Leave `disable-burst-read` unset (the default) unless your SPI bus has no
   NCS/`cs-gpios` under the controller's control -- burst read needs chip
   select held low across the whole multi-byte motion-burst transfer, so it
   only needs disabling on wiring that can't do that. This module's own test
   config builds and validates both: `pmw3610-trackball` (burst read ON,
   recommended) and `pmw3610-trackball-no-burst` (OFF) under
   `tests/zmk-config/snippets/`.

   The burst-read wiring is also what unlocks the fast `FRAME_GRAB` frame
   capture path (see "Frame capture" below) -- `disable-burst-read` falls
   back to the much slower per-pixel `Pixel_Grab` capture for both regular
   motion reporting and frame capture.

   ```conf
   CONFIG_PMW3610=y
   CONFIG_INPUT=y
   CONFIG_ZMK_POINTING=y

   # Optionally enable custom Studio RPC (sensor info/diagnostics/raw
   # register access/frame capture)
   CONFIG_ZMK_STUDIO=y
   CONFIG_ZMK_PMW3610_STUDIO_RPC=y

   # Optionally enable runtime settings (cpi, axis flags, downshift/sample
   # times, etc; requires the zmk-feature-custom-settings module dependency,
   # see its README for adding it to west.yml)
   CONFIG_ZMK_CUSTOM_SETTINGS=y
   CONFIG_ZMK_CUSTOM_SETTINGS_STUDIO_RPC=y
   CONFIG_ZMK_PMW3610_CUSTOM_SETTINGS=y

   # Raise Studio RPC buffers: 256 for chunked frame-capture responses
   # (128-byte data chunk + proto framing overhead), 128 for custom
   # settings requests/exports.
   CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=256
   CONFIG_ZMK_STUDIO_RPC_RX_BUF_SIZE=128

   # Optional: frame capture buffer size (bytes/pixels), default 484 = 22x22.
   # CONFIG_ZMK_PMW3610_STUDIO_RPC_FRAME_BUF_SIZE=484
   ```

3. Explore the protocol / firmware handler / web UI:
   - `proto/cormoran/pmw3610/pmw3610.proto` — message types
   - `src/studio/pmw3610_handler.c` — firmware RPC handler
   - `src/settings/pmw3610_settings.c` — runtime settings integration
   - `web/src/App.tsx` — web UI

### Runtime settings (`cormoran__pmw3610` custom settings)

With `CONFIG_ZMK_PMW3610_CUSTOM_SETTINGS=y`, the following keys are
registered **once per PMW3610 devicetree instance**, as `"<param>@<id>"`
(all public/unsecured, readable and writable over the generic
custom-settings Studio RPC subsystem provided by
[zmk-feature-custom-settings](https://github.com/cormoran/zmk-feature-custom-settings)):

| param | type | default | valid range |
| --- | --- | --- | --- |
| `cpi` | int32 | this device's DT `cpi` property (600 if unset) | 200 – 3200 |
| `swap_xy` | bool | `CONFIG_PMW3610_SWAP_XY` | — |
| `invert_x` | bool | `CONFIG_PMW3610_INVERT_X` | — |
| `invert_y` | bool | `CONFIG_PMW3610_INVERT_Y` | — |
| `force_awake` | bool | this device's DT `force-awake` property (`false` if unset) | — |
| `smart_algorithm` | bool | `CONFIG_PMW3610_SMART_ALGORITHM` | — |
| `run_downshift_ms` | int32 | `CONFIG_PMW3610_RUN_DOWNSHIFT_TIME_MS` | 32 – 8160 |
| `rest1_downshift_ms` | int32 | `CONFIG_PMW3610_REST1_DOWNSHIFT_TIME_MS` | `16*sample` – `255*16*sample`, using the *default* `rest1_sample_ms` |
| `rest2_downshift_ms` | int32 | `CONFIG_PMW3610_REST2_DOWNSHIFT_TIME_MS` | `128*sample` – `255*128*sample`, using the *default* `rest2_sample_ms` |
| `rest1_sample_ms` | int32 | `CONFIG_PMW3610_REST1_SAMPLE_TIME_MS` | 10 – 2550 |
| `rest2_sample_ms` | int32 | `CONFIG_PMW3610_REST2_SAMPLE_TIME_MS` | 10 – 2550 |
| `rest3_sample_ms` | int32 | `CONFIG_PMW3610_REST3_SAMPLE_TIME_MS` | 10 – 2550 |
| `report_interval_min_ms` | int32 | `CONFIG_PMW3610_REPORT_INTERVAL_MIN` | 0 – 1000 |

**`<id>`** is this device's `settings_id`, reported per-device in `GetInfo`
(`DeviceInfo.settings_id`): the devicetree `settings-id` property if set
(recommended, up to 8 ASCII characters, e.g. `settings-id = "trackball";`),
otherwise a 4-hex-digit hash of the devicetree node's path (stable across
reordering of sibling devicetree nodes, but not human-readable — set
`settings-id` explicitly if you want a readable key, e.g. with more than one
PMW3610 device in one firmware image). A single-sensor board without
`settings-id` set ends up with keys like `cpi@a3f2`; with `settings-id =
"trackball"` it would be `cpi@trackball`.

Notes:

- **Each device's settings are independent.** With two PMW3610 devices in
  one firmware image (e.g. a split keyboard's central *and* peripheral each
  having a sensor, or two sensors on one half), changing `cpi@<id>` for one
  device does not affect the other's `cpi@<other-id>`.
- `force_awake` and `cpi` default to **this device's own devicetree
  properties** (`force-awake;` / `cpi = <...>;`), not a single value shared
  by every device.
- The `rest1_downshift_ms`/`rest2_downshift_ms` **range constraints are
  computed from the default sample time**, but the sensor's actual valid
  range at any given moment depends on the *current* `rest1_sample_ms` /
  `rest2_sample_ms` value. If you change the sample time first, a downshift
  value that passed the setting's static range check may still be rejected
  by the driver (and vice versa) — change sample time and downshift time
  together if you push both away from their defaults.
- Changes take effect immediately (pushed to the sensor over SPI as soon as
  it has finished async init) and are re-applied to all PMW3610 devices
  whenever any `cormoran__pmw3610` setting changes (save, discard, or
  reset) — each device only ever reads its own `"<param>@<id>"` keys, so
  this is harmless for devices unrelated to the change.
- Settings persistence/export/import (`get`/`set`/`save`/`discard`/`reset`)
  is handled generically by zmk-feature-custom-settings' own Studio RPC
  subsystem, not duplicated here — see that module's README/web app for the
  matching client-side patterns.

### Frame capture (`CaptureFrame` / `GetFrameChunk`)

Frame capture uses one of two procedures depending on the sensor's wiring
(see `disable-burst-read` above):

- **4-wire burst (`FRAME_GRAB`, the default and recommended path).** One
  CS-held burst SPI transaction reads the whole pixel array via `MOTION_BURST`
  (0x12), the same primitive regular burst motion reporting uses -- see
  DESIGN.md's "G.1 Burst frame capture" section. The post-arm fresh-frame
  wait is tunable through `max_invalid_retries` below. It is what
  `CaptureFrame`/`SetFrameStream` use
  unless the sensor node has `disable-burst-read`. (The read is issued as
  ≤240-byte sub-transfers within the single CS-held transaction to stay under
  the nRF SPIM 255-byte EasyDMA per-transfer cap.)
- **3-wire fallback (`Pixel_Grab`, `disable-burst-read` only).** The
  official PMW3610 datasheet (R2.4) `Pixel_Grab` procedure: an arm sequence
  (SPI clock request on, page-1 magic enable, SPI clock request off, test
  clock on, `PIXEL_GRAB` (0x35) = 0x01), then per pixel: wait for
  `OBSERVATION1` (0x2D) bit2, read `PIXEL_GRAB`, write `OBSERVATION1` = 0x01
  to advance. `PRBS_TEST_CTL` (0x47) bit0 afterwards reports whether the
  sensor considers all 484 pixels read. Each pixel waits on a sensor-side
  handshake; this path exists as a correctness fallback for
  wiring that can't hold chip-select across a burst transfer, not as a
  performance target.

The full pixel array is 22x22 = 484 pixels (datasheet Figure 17) either way.

- `CaptureFrame{device_index, pixel_count, max_invalid_retries}` → captures
  into a firmware-side static buffer (size
  `CONFIG_ZMK_PMW3610_STUDIO_RPC_FRAME_BUF_SIZE`, default 484 = 22x22) and
  returns `{frame_id, pixel_count, chunk_size, complete, duration_ms, format}`.
  `pixel_count` is clamped to the buffer size; 0 uses the driver default
  (484). `max_invalid_retries` is dual-purpose (0 = driver default; see the
  proto for details): on the 3-wire fallback it is the per-pixel budget of
  10ms ready-bit-wait retries (default 3, clamped 1..100); on the burst path
  it is reinterpreted as the **post-arm wait in ms** — the primary
  fresh-frame wait, default 5 ms. Actual coherent frame rate and a safe minimum
  wait depend on the selected hardware and need a matching measurement.
  `complete` mirrors the sensor's own all-pixels-read status (burst: whether
  the burst SPI transaction itself succeeded; fallback: the datasheet's
  all-484 status bit); `duration_ms` is the wall-clock capture duration.
- `format` (`PixelFormat`, on both `CaptureFrameResponse` and
  `FrameStreamChunk`) discriminates the byte layout of the returned pixel
  data: `PIXEL_FORMAT_RAW8` (burst path) is a full 8-bit pixel value with no
  per-pixel validity bit; `PIXEL_FORMAT_PG7` (3-wire fallback, and the
  default/0 value for older firmware that predates this field) is the
  `Pixel_Grab` byte described below. The web UI's `frame.ts` helpers
  (`isValidPixelByte`/`pixelByteToGray`/`frameToRgba`) all take this as a
  parameter and default to `PIXEL_FORMAT_PG7` when absent.
- `GetFrameChunk{frame_id, offset}` → `{frame_id, offset, bytes data}`, up to
  128 bytes per call. Call it repeatedly with increasing offsets (0, 128,
  256, ...) until `offset + data.size >= pixel_count` to assemble the full
  frame; `frame_id` must match the most recent `CaptureFrame` response or the
  call fails.
- On the 3-wire fallback (`PIXEL_FORMAT_PG7`), each raw byte's bit7 is
  `PG_Valid` (bits[6:0] are the pixel value); the firmware stores the byte
  as-is (does not mask it) so the host can inspect capture quality. On the
  burst path (`PIXEL_FORMAT_RAW8`), every byte is a full 8-bit pixel with no
  validity bit. The web UI masks bit7 for display only in the PG7 case, and
  separately counts invalid bytes as a warning (always 0 for RAW8).
- During capture: the motion IRQ is disabled and an internal flag makes the
  normal motion-report path a no-op, so capturing a frame does not interleave
  with mouse movement reporting. The datasheet requires a reset to resume
  navigation after a frame grab, so a one-shot `CaptureFrame` always re-runs
  the power-up-reset + reconfigure flow (same as `pmw3610_resume()`'s
  not-ready path) on return (success **or** failure), and the whole
  procedure is bounded to ~5 seconds of wall-clock time regardless of
  `pixel_count`/`max_invalid_retries`, so a misbehaving sensor cannot hang
  the Studio RPC thread. (A typical complete capture is far faster.)
  `SetFrameStream` instead resets only once per streaming session -- see
  below.
- A 128-byte `GetFrameChunk` data chunk plus proto framing overhead must fit
  in one `CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE` (256 in this module's test
  config) — a `BUILD_ASSERT` in `src/studio/pmw3610_handler.c` catches a
  too-small value at compile time.
- `CaptureFrame` rejects with an `ErrorResponse` ("frame streaming is
  active...") if a `SetFrameStream` stream is currently running — stop the
  stream first (see below).

#### Frame streaming (`SetFrameStream` + `FrameStreamChunk` notification)

Instead of a client-driven poll loop, the firmware can push captured frames
on its own:

- `SetFrameStream{device_index, enable, pixel_count, max_invalid_retries}` →
  `{streaming}`. `enable = true` begins a persistent capture session **once**
  (forcing run mode and confirming it landed -- this one-time setup can take
  up to ~700ms from a deep rest mode; a failure here is returned as an
  `ErrorResponse` and streaming stays off) and starts a background loop (a
  dedicated low-priority workqueue, so it never blocks unrelated system
  workqueue consumers) that captures one frame per iteration **with no reset
  in between** and, on each successful capture, raises one `FrameStreamChunk`
  **notification** (not a response) per 128-byte chunk —
  `{frame_id, offset, bytes data, total_size, complete, format}`, where
  `total_size`/`complete`/`format` are repeated on every chunk of a frame so
  the client can detect the last chunk without a separate "done" message.
  `enable = false` stops the loop and ends the session (a single reset,
  resuming navigation) once the in-flight capture, if any, finishes.
  `pixel_count`/`max_invalid_retries` follow the same 0-means-default,
  clamped semantics as `CaptureFrame` (on the burst path `max_invalid_retries`
  is the post-arm-wait / fps knob; on the 3-wire fallback it is the per-pixel
  retry budget).
  While a session is active, repeating the same options is idempotent;
  changing the device or capture options requires stopping first. A new
  start can return a busy error while the previous capture is finishing;
  retry after cleanup has restored navigation.
- `SetFrameStream` and `CaptureFrame`/`GetFrameChunk` share the same
  firmware-side static buffer/`frame_id` counter, so only one can be active
  — a mutex excludes overlapping sensor captures and frame-buffer access.
  `CaptureFrame` rejects while a stream is active or still stopping.
- Streaming retains one capture session instead of resetting and reconfiguring
  after every frame. One-shot `CaptureFrame` still resets on return.
  The 3-wire fallback retains its per-pixel `Pixel_Grab` procedure. Compare
  frame integrity, motion recovery and timing on the actual selected sensor
  before making a throughput or reliability claim.
- If Studio locks while a stream is running, the current sensor read may
  finish, but the module stops emitting its remaining chunks and ends the
  owned session. For a split stream, a separate stop control retires the
  peripheral's queued requests even when its request queue is full. Stop
  transport failures get bounded retries; the central stops forwarding
  immediately even if that control cannot be delivered. A split disconnect
  also retires pending requests and the local capture session.
- The web UI's frame viewer uses this instead of a client poll loop — see
  [web/README.md](./web/README.md#frame-viewer-notes).

Example raw request/response/notification JSON shapes for CLI tools (e.g.
`tools/zmk-studio-rpc custom-call`) — see `proto/cormoran/pmw3610/pmw3610.proto`
for the exact field numbers:

```jsonc
// CaptureFrame request (defaults: full 22x22 frame)
{ "captureFrame": { "deviceIndex": 0, "pixelCount": 484 } }
// -> { "captureFrame": { "frameId": 1, "pixelCount": 484, "chunkSize": 128,
//      "complete": true, "durationMs": 12, "format": "PIXEL_FORMAT_RAW8" } }
//    ("format" is PIXEL_FORMAT_PG7 -- the default/0 value -- on a
//    disable-burst-read sensor, or when talking to older firmware.)

// GetFrameChunk request (repeat with offset 0, 128, 256, 384)
{ "getFrameChunk": { "frameId": 1, "offset": 0 } }
// -> { "getFrameChunk": { "frameId": 1, "offset": 0, "data": "<128 bytes base64>" } }

// SetFrameStream request (start)
{ "setFrameStream": { "deviceIndex": 0, "enable": true, "pixelCount": 484 } }
// -> { "setFrameStream": { "streaming": true } }
// ... followed by repeated notifications, e.g.:
// { "frameStreamChunk": { "frameId": 1, "offset": 0, "data": "<128 bytes base64>",
//     "totalSize": 484, "complete": true, "format": "PIXEL_FORMAT_RAW8" } }

// SetFrameStream request (stop)
{ "setFrameStream": { "deviceIndex": 0, "enable": false } }
// -> { "setFrameStream": { "streaming": false } }
```

### RPC debug facilities

The `WriteRegister` RPC call writes an arbitrary sensor register with no
validation beyond fitting in a byte. It is a debug/tuning facility (e.g. for
exploring the frame-capture procedure above interactively), but it can just
as easily put the sensor in a bad state until the next power-up reset /
reconfigure. As of Phase E the whole subsystem (including `WriteRegister`)
requires ZMK Studio to be unlocked — see "Security" above — but treat access
to it like access to a debug/JTAG interface regardless: fine for your own
trusted host, not something to expose over an untrusted transport.

### Split keyboards / multiple sensors (`source`, `CONFIG_ZMK_PMW3610_SPLIT_RPC_RELAY`)

**Multiple PMW3610 devices in one firmware image** (e.g. two sensors on the
same half) already work with no extra configuration: each devicetree
instance gets its own settings (see "Runtime settings" above) and its own
entry in `GetInfo`'s `devices` list (`device_index`/`settings_id`).

**Reaching a sensor on a split keyboard's *peripheral* half** additionally
requires `CONFIG_ZMK_PMW3610_SPLIT_RPC_RELAY=y` on **both** halves (depends
on ZMK's `CONFIG_ZMK_SPLIT_RELAY_EVENT`) plus, since the largest relayed
message needs more room than the framework's 128-byte default,
`CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=240`. Every request
(`GetInfo`/`ReadDiagnostics`/`ReadRegister`/`WriteRegister`/`CaptureFrame`/
`GetFrameChunk`/`SetFrameStream`) has a `source` field: `0` (the default)
targets local devices, `1` the first peripheral. Since relaying is
inherently asynchronous, a relayed request's RPC call returns immediately
with a `DeferredResponse{request_id}`; the real answer arrives later as a
`PeripheralResponse{source, request_id, response}` Studio notification.

Requests, responses and image chunks use bounded FIFO queues on the receiving
half. `CONFIG_ZMK_PMW3610_RELAY_QUEUE_DEPTH` defaults to 8 packets per queue
(range 4–32). A full queue drops the incoming packet with a warning; it does
not overwrite an accepted packet. A dropped response times out at the client,
and a dropped chunk leaves an incomplete frame. The lock stop control bypasses
these queues. Both halves must run this module revision for that control.

```jsonc
// GetInfo targeting the first split peripheral's own devices
{ "getInfo": { "source": 1 } }
// -> { "deferred": { "requestId": 7 } }   // immediate
// ... later, as a notification:
// { "peripheralResponse": { "source": 1, "requestId": 7,
//     "response": { "getInfo": { "devices": [ ... ] } } } }
```

**Frame streaming from a peripheral's sensor** works the same way:
`SetFrameStream{source: 1, enable: true, deviceIndex: 0}` starts the
existing capture loop on the peripheral, and each chunk relays back as a
`FrameStreamChunk` notification with `source` filled in (0 for a locally
streamed frame). `CaptureFrame`/`GetFrameChunk` against a peripheral work
the same as their local form, just via the deferred/notification pattern
above instead of a synchronous response.

The underlying relay transport broadcasts a request to *every* connected
peripheral rather than addressing one specifically (each one's answer still
arrives correctly tagged with its own `source`) — fine for the common
single-peripheral split, but means a multi-peripheral build gets one
`PeripheralResponse`/`FrameStreamChunk` per peripheral for the same
`request_id`/stream.

**Listing every PMW3610 across the whole keyboard**: there is no API to ask
ZMK's split transport "which peripherals are currently connected" (nothing
this module could hook into anyway), so `GetInfo` instead accepts the
sentinel `source = 0xFFFFFFFF`: it answers with this device's own local
devices synchronously (exactly like `source: 0`), and — if relaying is
enabled — the *same* request is broadcast to every connected peripheral,
each answering independently as its own `PeripheralResponse` (carrying
`GetInfoResponse.relay_request_id` so the caller can correlate them). The
web UI's Sensor card has a "Scan All Sources" button that does exactly
this, collecting peripheral answers for ~2s and listing a row per source.

```jsonc
// List every PMW3610 across the whole keyboard
{ "getInfo": { "source": 4294967295 } }
// -> { "getInfo": { "devices": [ ... local ... ], "relayRequestId": 3 } }  // immediate
// ... then zero or more notifications, one per connected peripheral:
// { "peripheralResponse": { "source": 1, "requestId": 3,
//     "response": { "getInfo": { "devices": [ ... ] } } } }
```

This has been build-tested (both roles compile, see
`tests/zmk-config/build.yaml`'s `pmw3610_split_*` artifacts) and the
peripheral-side request execution (including a CaptureFrame call and the
genuinely-unsupported-request-kind fallback) has a native_sim self-test
(`tests/split_peripheral`), but **not yet validated against real split
hardware** — no split-capable board pair was available while developing
this feature. The central-side broadcast dispatch additionally has a
self-test (`CONFIG_ZMK_PMW3610_SPLIT_RPC_RELAY_TEST` on the
`pmw3610_split_central` build), but only compile/link-verified: it needs
ZMK's real BLE split transport, which native_sim cannot provide without a
working Bluetooth stack.

### Web UI

See [web/README.md](./web/README.md) for web UI development instructions,
including the settings panel, diagnostics polling, and frame viewer. The
Sensor and Frame Viewer cards each have a "Split source" input (0 = local,
matching the proto default); a relayed request's `DeferredResponse` is
awaited transparently behind the scenes (`web/src/relay.ts`) so the rest of
the UI code doesn't need to special-case it. The generic settings panel
(`cormoran_custom_settings`, a separate subsystem provided by
zmk-feature-custom-settings) does not have a source selector yet -- its
calls always target `source: 0` (local devices).

### Publishing Web UI

**GitHub Pages**: A push to `main` builds and deploys to `https://<account>.github.io/<repo>/`.
Pushes to `codex/pmw3610-driver-review` run Web checks and upload the build
artifact without deploying it.

**Cloudflare Workers (PR previews)**: Configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.

## Module Development Guide

### Setup for running test

Run dependency preparation, test commands and builds inside Docker. The
development container below provides the toolchain. Keep dependency
checkouts, package environments, build outputs and caches in container
images or named volumes; the workspace commands below run inside that
container.

The standalone manifests pin Custom Settings to the maintenance fork's
`codex/custom-settings-review` selection and fix the ZMK, Zephyr and West
command commits. During explicit preparation, run
`python3 tools/verify_review_dependencies.py` before `west update` to
verify the actual remote review branch. Ordinary tests reuse those prepared
inputs and do not fetch dependencies. `OWNER_TEST_OUTPUT` optionally selects
an isolated build directory; board builds run one target at a time with
compiler parallelism controlled by `CMAKE_BUILD_PARALLEL_LEVEL`.

`python3 -m unittest` also builds and runs the central and peripheral
`tests/firmware` regression apps. They compile the production request/relay
implementations with real Zephyr queues and nanopb, using synthetic sensor,
Studio and split transport boundaries. They cover capture ownership, busy
queues, lock/disconnect retirement and late replies. These logic tests
complement the original native fixtures, board matrix and Renode scenarios;
they do not establish physical transport or sensor acceptance.

#### Option0: Dev container (recommended)

Open this repository in VS Code with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers). The container automatically initializes the west workspace using the isolated layout.

#### Option1: west workspace directory layout

Set west topdir as parent of repository root and download dependencies under `../`.
This layout is useful to reduce disk usage by sharing dependencies with other zephyr modules.
The build result is located in `../build`.

```bash
mkdir west-workspace
cd west-workspace # this directory becomes west workspace root (topdir)
git clone <this repository>
# rm -r .west # if exists to reset workspace
west init -l . --mf west/west-test-workspace.yml
west update --narrow
west zephyr-export
```

#### Option2: isolated directory layout

Set west topdir as repository root and download dependencies under `./dependencies`.
This layout is useful if you don't want to share dependencies to other zephyr modules.
Dev container and github actions uses this layout.
The build result is located in `./build`.

```bash
git clone <this repository>
cd <cloned directory>
west init -l west --mf west-test-isolated.yml
west update --narrow
west zephyr-export
```

### Pre-commit

Every commit need to pass pre-commit verification. The verification contains formatting code and running tests.

```
pip install pre-commit
pre-commit install

# Run pre-commit manually
pre-commit run --all-files
# Run for git staged files
pre-commit run
```

### Running Test

```bash
# Run unit test + build test and verify the results
python3 -m unittest
# Run build test directly
west zmk-build tests/zmk-config
# Run unit test directly
west zmk-test tests -m .
# Run web tests
cd web && npm test
```

### Hardware-free Renode test (simulated PMW3610)

`tests/renode/` boots the firmware in the [Renode](https://renode.io/)
emulator against a **simulated PMW3610 sensor** and drives the driver end to
end — the power-up/self-test handshake and motion reporting — with no J-Link
and no real trackball. This complements the native_sim unit tests (which
can't exercise the SPI register protocol or the motion IRQ) and the build
tests (which only prove the image links).

The sensor model is a small C# SPI peripheral, `tests/renode/platforms/PMW3610.cs`,
that answers the driver's register protocol (product id `0x3E`, the
OBSERVATION self-test nibble, `MOTION_BURST` reports) and drives the motion
IRQ line. `tests/renode/platforms/xiao_pmw3610.repl` wires it onto SPIM0 with
the same chip-select and IRQ pins the test snippet's devicetree uses.
(`NRF52840_GPIO_WithLatch.cs` there fills in the GPIO `LATCH` register that
Renode's stock model omits, which the nRF level-sensitive interrupt path
needs.)

Run these commands inside the documented build container. Prepare the test
environment separately from execution:

```bash
python3 tools/renode_core.py prepare --cache /tmp/pmw-renode-core --jobs 2
```

This prepares Renode 1.16.1 and builds its CPU library from checksum-pinned
sources with the local `tools/renode_spurious_irq.patch`. The patch handles an
NVIC acknowledgement that reports no pending exception, before it can be used
as a vector number. This Linux x86_64 container profile leaves the installed
emulator intact and applies the backport to each process's temporary CPU
library. The included synthetic regression verifies the original failure,
continued thread execution, and delivery of a subsequent real interrupt.
`prepare --offline` reuses already downloaded inputs; `run` validates prepared
file hashes and never downloads or builds dependencies. Use the same cache
for the commands below.

```bash
# Build the emulation-only image (see tests/zmk-config/build-renode.yaml)
west zmk-build tests/zmk-config \
  --build-yaml tests/zmk-config/build-renode.yaml -af renode

# Boot it against the simulated sensor and run the driver tests.
# --skip-smoke: the generic smoke test uses a sensor-less
# platform, so run only this module's sensor tests.
python3 tools/renode_core.py run --cache /tmp/pmw-renode-core -- \
  west zmk-renode-test tests/renode \
  --elf build/renode/zephyr/zmk.elf --skip-smoke
```

> If you build from a west-workspace layout (Option 1 above) where a parent
> directory carries its own `zephyr/module.yml`, add
> `--extra-module-auto-discovery zmk-config current` to the `zmk-build`
> command so it does not pick up that unrelated module.

CI runs this automatically in the `Renode PMW3610 Test` job.

### Hardware-free split-relay test (host ↔ peripheral PMW3610)

`tests/renode/pmw3610_usb_wired_split_relay_renode_test.py` proves the split
event relay end to end with **no hardware**: a Studio host reads the split
**peripheral**'s PMW3610 through the relay. It boots two real nRF52840 images on
one Renode session:

```
host ──USB(Studio)──▶ CENTRAL ──wired split (relay)──▶ PERIPHERAL (simulated PMW3610)
```

The host issues `GetInfo(source = PMW3610_SOURCE_ALL)` over the central's
emulated USB CDC; the central relays it to the peripheral over the
[`zmk,wired-split`](https://zmk.dev/docs/development/hardware-integration/wired-split)
link (using ZMK's relay-event transport), the peripheral's driver answers
against the simulated sensor, and the central forwards the answer back to the
host as a `PeripheralResponse` notification. The test asserts the host receives
the peripheral's real `DeviceInfo` — product id `0x3E`, `ready`.

This is the `usb`×`wired` combination: a wired split whose central still speaks
Studio, over USB (which consumes no UARTE, leaving `uart1` for the split link).
The two halves are the `pmw3610_usb_wired_split_{left,right}` shields, built with
`tests/zmk-config/build-usb-split.yaml`.

```bash
west zmk-build tests/zmk-config --build-yaml tests/zmk-config/build-usb-split.yaml -af usb-wired-central
west zmk-build tests/zmk-config --build-yaml tests/zmk-config/build-usb-split.yaml -af usb-wired-peripheral

# Boots both halves, runs the three wired smoke checks, then the module tests.
python3 tools/renode_core.py run --cache /tmp/pmw-renode-core -- \
  west zmk-renode-test --mode wired-split \
  --elf build/usb-wired-central/zephyr/zmk.elf \
  --peripheral-elf build/usb-wired-peripheral/zephyr/zmk.elf \
  tests/renode
```

The central shield enables locking with a short idle timeout. The harness
presses the emulated `&studio_unlock` key before secured calls. It also starts
a peripheral image stream and verifies that the core idle lock stops capture
over the wired control path, rejects a later RPC with `UNLOCK_REQUIRED`, and
leaves the image stream quiet after previously queued bytes have drained.
The first key remains available to the original wired key-relay smoke test.

CI runs this automatically in the `Renode PMW3610 wired-split relay test` job.

### Sync changes from template

Run `Actions > Sync Changes in Template > Run workflow` to get the latest template changes as a pull request.

If the template contains changes in `.github/workflows/*`, register a GitHub personal access token as `GH_TOKEN` repository secret (`repo` + `workflow` scopes).

### Coding agent on actions

Actions for github copilot and claude are available.

- Mention `@copilot`
- Setup `ANTHROPIC_API_KEY` secret and mention `@claude`
  - Or fix [claude.yml](./.github/workflows/claude.yml) to use `CLAUDE_CODE_OAUTH_TOKEN`
