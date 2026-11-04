# Owner validation

Run the existing canonical firmware entry from a prepared, revision-verified
Docker workspace:

```sh
OWNER_TEST_OUTPUT="$EVIDENCE/owner" python3 -m unittest
```

This retains the ZMK native `test`, `studio`, `split_peripheral` fixtures and
all eight existing board artifacts. `tests/test_firmware_regressions.py` also
runs the actual request/relay implementations with real Zephyr queues and
nanopb for central and peripheral roles. Its session cases include no-renewal
lease expiry while the worker queue is blocked, renewal while another thread
owns the frame mutex, rejection of a late renewal, lock/disconnect retirement,
renewal rejection after cleanup and during a replacement session, missing epoch
rejection, and invalidation of an older frame after a partial failing capture. The lease
is shortened only in this isolated fixture; production Kconfig keeps its
documented 10–120 second range and 15 second default.

The session suite also cleans up after a failed assertion: it stops the stream
and lease timer, releases an owned queue gate, then flushes the stream work and
drains the queue. A gate release is idempotent, and its semaphores are reset only
once the drained handler has returned, so cleanup cannot leave a permit for the
next block. The frame-mutex helper is joined only if it was created, with a
two-second bound; an unsuccessful cleanup is a separate fixture failure and
cannot qualify a source fault. Original case actions, sleeps, roles and assertions
remain. Timeouts still do not count as executable negative-control detection.

`tests/test_driver_regressions.py` builds the actual sensor implementation once
and executes that binary three times with fresh process directories. Synthetic
SPI/GPIO boundaries expose ordered clock/page writes, injected errors and lock
ownership. Assertions cover force-awake disable/re-enable, CPI and Pixel_Grab
page cleanup, clock-enable/payload errors, page selection before reset, motion
and raw-read serialization, activity during capture, system-queue progress
while capture holds the sensor mutex, and RUN downshift boundaries. Real
Zephyr mutexes and workqueues execute these scenarios; there is no substitute
driver algorithm. Select a fresh output directory for each owner run.

For executable negative controls, stage an isolated owner copy in container
storage, then invoke `python3 tests/review_negative_control.py FAULT "$ISOLATED_OWNER"`
from the unchanged owner. `force-awake`, `page-cleanup`, `motion-queue`,
`motion-lock` and `read-lock` must fail the unchanged driver boundary assertions;
`lease-expiry`, `late-renewal` and `stale-frame` must fail the unchanged session assertions.
Rebuild each distinct control once and retain three identical-binary failures
in independent process directories. The operator refuses the authoring owner.
Missing compilation, link errors or an unrelated failure are not accepted
negative-control results. All positive owner/board/Web assertions remain required.

From `web/`, use the locked dependencies and run the existing entries:

```sh
npm test -- --runInBand
npm run build
npm run lint
```

The new `StreamLease.spec.tsx` cases retain identical renewal options, stop
renewal after unmount and lock, preserve Stop after an uncertain start, and
prevent an unlock or late renewal response from restarting an old lease. Existing frame assembly,
relay, source-session and response-lifetime assertions remain required.

The Renode sensor and wired-split smoke/RPC suites remain separate required
checks at their documented owner entries. These native and Web fixtures do
not establish physical SPI signalling, sensor power, USB Serial/DTR behavior,
BLE backpressure, split transport loss or navigation recovery during the
selected core's unbounded Studio TX wait. Hardware acceptance needs matching
firmware and authorized device access.
