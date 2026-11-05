# zmk-driver-pmw3610-with-custom-studio-rpc: agent guide

English is the authoritative guide. [日本語版](AGENTS.ja.md) contains the same rules; update both
together.

## Scope and contract

- Own PMW3610 sensor setup, SPI/IRQ acquisition, power transitions and the declared runtime settings
  adapter. Preserve per-device configuration, accumulated motion/report boundaries, bounded bus
  transactions and fault recovery. Resolve actual driver/kernel APIs before changing timing or PM.

- For custom Studio RPC use the declared fork/API. Update schema, firmware handler and Web client
  together, in that order. Set nanopb submessage `has_*` flags; with `CONFIG_NANOPB_WITHOUT_64BIT`,
  use 32-bit proto fields. Keep module parameters with the declared typed settings owner where
  supported; do not add parallel persistence.

- Reading map for relevant changes: [README.md](README.md), [tests/README.md](tests/README.md). Read
  the affected contract/coverage sections; documentation-only edits do not require unrelated
  dependency tours.

## Working rules

- Read the request and existing diff; preserve unrelated and staged work. Finish authorized
  inspection, edits and reversible checks without repeated approval. Ask only for a missing decision
  or an out-of-scope action. Before a destructive rewrite, preserve irreplaceable uncommitted
  content as private evidence, not rolling whole-tree copies.

- Git staging, commits, pushes, PR changes, merges, tags, publication, flashing and settings/bond
  erasure need authorization for that operation. Existing authorization remains valid for the same
  operation and scope. Dependency guides and passing checks grant none. Before an authorized commit,
  run applicable pre-commit hooks in Docker without bypasses; keep the configured Git identity.

- Use the selected checkout and manifest/lock sources; do not silently switch branches, reset
  history, replace remotes or create authoring copies. Before changing selection, verify source
  URLs/full commits, review dependency changes, update affected pins/locks and run owner/integration
  checks. Distinguish local working snapshots from remotely retrievable commits; report missing refs
  rather than inventing them.

- Read relevant root/nested owner and dependency instructions once per selected checkout/revision.
  Resolve actual west imports, local overrides, enabled features and backend; sibling
  directories/cache names do not identify inputs. Record READ, NO AGENTS or INACCESSIBLE when
  preflight requires it. Missing inputs block dependent checks; continue independent authorized
  work.

- Keep permanent agent rules in this synchronized EN/JA pair. Usage/API details stay in their
  existing documentation homes. Do not add agent-guide fragments or private shared-guide
  dependencies. Remove duplicated rules and obsolete task/branch assumptions without discarding
  active contracts.

## Execution environment

- Run local automated test/build runtimes and dependency setup in Docker; a documented DevContainer
  qualifies. Unless stated otherwise, work from the owner root in its resolved workspace. Launch
  Docker-wrapper scripts on the host; run their inner Python/Node/compiler entries inside the
  prepared container without wrapping Docker again. Host source/Git/reference checks and evidence
  export are allowed; do not install test packages/toolchains on the host. Keep dependencies,
  runtime/build trees and caches in images or named volumes.

- Separate preparation and deliberately selected online compatibility checks from ordinary
  network-free tests. Inspect the available immutable image ID/digest and verified
  dependency/toolchain revisions; pass the image through the owner's declared image option; honor
  declared local overrides and record working files. A launcher that installs or fetches
  dependencies belongs to preparation/online checking, not an offline run. Do not silently pull,
  advance pins or mutate shared caches, patch dependencies or disable required features to clear a
  gate. Missing inputs block dependent checks only; documented preparation within an authorized
  build/setup remains in scope.

- Reuse compatible environments/caches, retaining required clean-cache lanes. Provide required
  inputs, including relevant untracked files, through read-only mounts or isolated container copies;
  verify source identity before/after. Isolate mutable build/runtime/install trees per job under one
  CPU/memory budget, including nested workers. Build once per configuration and reuse that exact
  binary for identical repeats; cached PASS is not a new run. Performance comparisons separate
  preparation/staging/build/execution/validation and cold/warm conditions. Existing hosted platform
  jobs retain their own OS requirements.

## Checks and entry points

- Documentation/instructions only: run `git diff --check`, verify changed paths/commands and EN/JA
  agreement. Without Git history use `git diff --no-index --check` on before/after copies. Firmware
  suites are not required solely for prose changes.

- Before the prepared-container firmware entry, set `OWNER_TEST_OUTPUT` to a fresh absolute path
  inside that container's mounted results volume, outside the checkout.

- Canonical prepared-workspace firmware entry: `python3 -m unittest -v`. Follow this owner's
  README/test guide for every native/board/role artifact and its result assertions; direct west
  builds/tests are diagnostic subsets, not replacements.

- For Web changes, from `web/` in the prepared container use `npm run generate`,
  `npm test -- --runInBand`, `npm run build`, `npm run lint`. Review any formatter/linter edits and
  preserve unrelated work.

- Use `tests/README.md` for affected protocol/kernel/negative controls and integration gates.
  Preserve the full declared native/board/role matrix; inspect effective config, linked
  sources/symbols and actual fixture completion.

- The current PMW runner cleans build subdirectories. Enforce the fresh `OWNER_TEST_OUTPUT`
  preflight before invoking it; this is a caller requirement, not a built-in rejection guard.

## Test quality

- Keep module fixtures, assertions, independent oracles, mutations, selectors and validators in the
  owner's tests/; retain documented Web and non-module test layouts. CI/package scripts dispatch
  owner entries, not sibling/private suites or source-rewriting substitutes. Probes expose state,
  not scenarios. Map implementation families to normal/boundary/invalid, independent-state,
  ordered-time/output, reset/cancel, failure/recovery and role/protocol cases and explicit gaps.

- A regression needs a failing original or named control. Expected-failure controls qualify only by
  their specified assertion/rejection; report them separately from product results. Do not weaken
  assertions, accept unclassified snapshots or count compilation errors as killed runtime faults.
  Before retiring tests, archive unique original assertions/failures externally with a replacement
  map. Quick runs every behavioral scenario with sanitizers where supported; full adds the
  documented ABI, optimization, coverage, kernel and supported-core matrix.

- Use focused checks for local implementation changes and the complete affected owner matrix for
  interface/test-infrastructure changes. Run unchanged stock ZMK and DYA only where both are
  supported. DYA-only features are NOT APPLICABLE to stock; disabling them is not compatibility
  evidence. For test suites, verify the required nonempty case/fixture completions; a zero exit
  alone, skipped required cases, timeouts or setup errors do not establish PASS.

## Evidence and handoff

- Use fresh evidence paths: resolve parents and reject existing files, directories or symlinks.
  Record commands/exits, source/dependency/config/backend/image identities and raw ordered
  output/times, retaining first failures and relevant config/DTS/binaries. Source or dependency
  drift invalidates affected results; never edit running scripts. Put retained outputs on a mounted
  named volume or export them before container removal, including failures; a path printed inside a
  disposable container is not retained evidence.

- Preserve exact fixed-input traces or specification-based timing bounds; totals do not replace
  per-report order/time. Before calling a mismatch nondeterministic, repeat identical
  binary/input/seed/backend/initial-flash conditions and PHY where applicable at least three times.
  Host load alone is not an explanation. Distinguish invalid/stale/incomplete/unavailable
  observations from valid zero.

- Report PASS, FAIL, BLOCKED, NOT RUN and NOT APPLICABLE distinctly. Local CI, host/native/compile
  and simulator results do not establish hosted CI, browser or physical
  HID/BLE/split/electrical/power/reset acceptance. Validate exercised production paths and correlate
  hardware before simulator-fidelity claims. End-to-end/stability claims need matching
  installed-image and host observations; quiet logs are not proof.

- Before sharing, review source/comments/guides/examples/logs/media/artifacts/metadata for
  credentials, personal/host/device IDs, private paths, bonds and individual histories/preferences.
  Authorized local work may use real values; keep private originals and label sanitized copies. Use
  clearly synthetic public fixtures/placeholders; preserve public project/API identifiers, licenses
  and attribution. Keep useful diffs/evidence. Handoff reports behavior, files, actual checks,
  gaps/risks and version-control/device actions.
