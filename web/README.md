# PMW3610 Module - Web Frontend

This is a web application (sensor configurator + frame viewer) for the
PMW3610 ZMK module's custom Studio RPC subsystem.

## Features

- **Device Connection**: Connect to ZMK devices via Serial (WebSerial)
- **Sensor info & diagnostics**: `GetInfo` (ready/product id/revision/init
  error/runtime config) and `ReadDiagnostics` (SQUAL/shutter/pixel min-avg-max),
  with optional 1s auto-refresh for diagnostics
- **Settings panel**: generic editor for the sensor's own custom settings
  (subsystem `cormoran__pmw3610`), talking to the separate
  `cormoran_custom_settings` subsystem provided by
  [zmk-feature-custom-settings](https://github.com/cormoran/zmk-feature-custom-settings)
  (list/edit/write with memory or persist mode, save/discard/reset)
- **Frame viewer**: capture a still image from the sensor using the official
  PMW3610 datasheet `Pixel_Grab` procedure, and render it to a `<canvas>`.
  A capture-once button pulls one frame via `CaptureFrame` + chunked
  `GetFrameChunk`; a streaming toggle instead calls `SetFrameStream` and
  subscribes to `FrameStreamChunk` custom Studio notifications pushed by the
  firmware (no client-side polling loop) -- see "Frame viewer notes" below.
  Also shows an FPS counter, an invalid-byte (PG_VALID clear) warning count,
  and an advanced capture-wait control (RAW8: post-arm milliseconds;
  PG7: 10 ms ready-wait retry units).
- **Studio lock awareness**: the `cormoran__pmw3610` subsystem is secured
  (see the module README's "Security" section) -- the UI shows a banner and
  disables settings/frame controls while ZMK Studio is locked, and reacts to
  `UNLOCK_REQUIRED` RPC errors even if no lock notification was seen yet.
- **React + TypeScript**: Modern web development with Vite for fast builds
- **react-zmk-studio**: Uses the `@cormoran/zmk-studio-react-hook` library for
  simplified ZMK integration

## Quick Start

Run these commands inside the repository's Docker development environment.

```bash
# Install dependencies
npm install

# Generate TypeScript types from proto
npm run generate

# Run development server
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## Project Structure

```
src/
├── main.tsx              # React entry point
├── App.tsx               # Main application: connection + feature cards
├── App.css               # Styles
├── SensorInfo.tsx         # "Sensor" + "Diagnostics" cards (GetInfo/ReadDiagnostics)
├── SettingsPanel.tsx      # "Settings" card (generic custom-settings editor)
├── FrameViewer.tsx        # "Frame Viewer" card (CaptureFrame/GetFrameChunk + canvas)
├── frame.ts               # Pure frame-chunk reassembly + pixel conversion helpers
├── settingsJson.ts        # Settings export/import JSON document helpers
└── proto/                 # Generated protobuf TypeScript types (buf generate)
    └── cormoran/
        ├── pmw3610/
        │   └── pmw3610.ts
        └── zmk/custom_settings/
            └── custom_settings.ts

test/
├── App.spec.tsx              # Tests for App component
├── SensorInfo.spec.tsx        # Tests for the sensor/diagnostics cards
├── SettingsPanel.spec.tsx     # Tests for the settings editor
├── FrameViewer.spec.tsx       # Tests for the frame viewer controls
└── frame.spec.ts               # Tests for frame reassembly/pixel conversion (pure functions)
```

## How It Works

### 1. Protocol Definition

This module's own protobuf schema is defined in
`../proto/cormoran/pmw3610/pmw3610.proto`. The settings panel additionally
talks to zmk-feature-custom-settings' generic custom-settings subsystem,
whose schema (`cormoran/zmk/custom_settings/custom_settings.proto`) lives in
that dependency's own repo, not this one.

### 2. Code Generation

TypeScript types are generated using `ts-proto`:

```bash
npm run generate
```

This runs `buf generate`, which uses the configuration in `buf.gen.yaml`.
`buf.gen.yaml` lists **two** input directories: this repo's own `../proto`
and the vendored Custom Settings schema under `web/proto`. The vendored
file records its source commit and re-sync procedure. Keeping it outside
the repo-root `proto/` tree avoids duplicate firmware-side nanopb symbols
when both modules are enabled, and lets Web CI build without a West
workspace.

### 3. Using react-zmk-studio

The app uses the `@cormoran/zmk-studio-react-hook` library:

```typescript
import { useZMKApp, ZMKCustomSubsystem } from "@cormoran/zmk-studio-react-hook";

// Connect to device
const { state, connect, findSubsystem, isConnected } = useZMKApp();

// Find the PMW3610 subsystem
const subsystem = findSubsystem("cormoran__pmw3610");

// Create service and make RPC calls
const service = new ZMKCustomSubsystem(state.connection, subsystem.index);
const response = await service.callRPC(payload);
```

The settings panel does the same thing but against a different subsystem:
`findSubsystem("cormoran_custom_settings")` (zmk-feature-custom-settings'
generic settings RPC), using `SettingRef.customSubsystemIndex` to point at
this module's `findSubsystem("cormoran__pmw3610")` result for `list_settings`
/ `write_setting` scopes.

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Writing Tests

Use the test helpers from `@cormoran/zmk-studio-react-hook/testing`:

```typescript
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";

const mockZMKApp = createConnectedMockZMKApp({
  deviceName: "Test Device",
  subsystems: ["cormoran__pmw3610"],
});

render(
  <ZMKAppProvider value={mockZMKApp}>
    <YourComponent />
  </ZMKAppProvider>
);
```

## Frame viewer notes

- The firmware side has a fixed-size static frame buffer
  (`CONFIG_ZMK_PMW3610_STUDIO_RPC_FRAME_BUF_SIZE`, default 484 = 22x22).
  `CaptureFrame`/`SetFrameStream`'s `pixel_count` is clamped to this size.
- **Capture once** (`CaptureFrame` + `GetFrameChunk`): a one-shot pull --
  `CaptureFrame` captures into the firmware's static buffer, then the web
  app loops `GetFrameChunk` calls (see `chunkOffsets()`/`assembleFrame()` in
  `src/frame.ts`) up to 128 bytes at a time until the whole frame is
  collected. Rejects with an error if streaming is currently active (stop
  streaming first).
- **Streaming** (`SetFrameStream` + `FrameStreamChunk` notifications,
  Phase E): toggling "Start Streaming" calls `SetFrameStream{enable: true,
device_index, pixel_count, max_invalid_retries}`, then the firmware
  repeatedly captures frames on its own (system workqueue loop) and pushes
  one `FrameStreamChunk` custom Studio notification per 128-byte chunk of
  each frame -- the web app no longer drives a client-side capture loop.
  `createFrameAssembler()` in `src/frame.ts` incrementally reassembles
  chunks (by `frame_id`/`offset`) into a full frame and reports when it's
  complete so the canvas renders once per frame, not per chunk.
  "Stop Streaming" calls `SetFrameStream{enable: false, ...}` and waits
  for its acknowledgement; a failed stop remains available for retry.
  Connection changes retire pending work and stop the owned stream using
  its original connection. `CaptureFrame` and `SetFrameStream` share the same
  firmware-side buffer/frame_id, so the UI disables "Capture Once" while
  streaming is on.
- Frame rate depends on the sensor's wiring (`disable-burst-read`, see the
  module README's sensor configuration): the default 4-wire burst path resets
  the sensor only once per streaming session and reads a whole frame in one
  SPI transaction. The per-pixel fallback waits for individual sensor
  handshakes. Actual frame coherence and throughput need validation on the
  selected hardware and transport. The FPS counter reports received frames.
- If ZMK Studio locks while a stream is active, the firmware stops the loop
  on its own (see the module README's "Security" section) but cannot notify
  the client that it did so (notifications aren't request/response) -- the
  web app detects this via the lock-state banner/notification and resets
  its own "streaming" UI state to match once locked.
- Each `CaptureFrameResponse`/`FrameStreamChunk` carries a `format` field
  (`PixelFormat`) discriminating the pixel byte layout: `PIXEL_FORMAT_RAW8`
  (4-wire burst path) is a full 8-bit pixel with no validity bit;
  `PIXEL_FORMAT_PG7` (3-wire fallback, and the default for older firmware
  that predates this field) has bit7 as `PG_VALID` with bits[6:0] the pixel
  value. `src/frame.ts`'s `isValidPixelByte`/`pixelByteToGray`/`frameToRgba`
  all take `format` as an (optional, defaulting to PG7) parameter and
  `FrameViewer.tsx` threads the response/notification's `format` through to
  them -- PG7 masks bit7 for display (`(byte & 0x7f) << 1` for 8-bit
  grayscale) and counts bit7-clear bytes as a data-quality warning; RAW8
  renders every byte as-is and always reports 0 invalid bytes (the burst
  read is all-or-nothing -- see `complete`).

## Roadmap

This UI is feature-complete through Phase E (sensor info/diagnostics,
settings, frame capture/streaming, Studio lock awareness). The frame-capture
procedure has been hardware-validated (Phase D); Phase E's notification-based
streaming path has likewise been hardware-validated (see the module
README's "Frame capture" / "Security" sections and DESIGN.md).
