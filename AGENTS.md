This repository contains a ZMK module with Web UI using the **unofficial** custom ZMK Studio RPC protocol.

## Repository bootstrap

For an explicitly requested new repository only, consult the repository bootstrap skill under `skills/` if present. Its remote mutations require authorization for that new repository. This maintenance checkout is already initialized; do not reset or replace its history.

After bootstrapping, continue with module implementation.

## Dev Rules

- Commit only when explicitly requested. Required pre-commit checks must pass
  inside Docker; never bypass them.
- Write simple and sufficient tests for new features.
  - Unit test: Test major functionalities as much as possible by adding case to `tests/<test case>`.
    You might have to add test only logic like executing logic at zephyr initialization to improve test coverage.
  - Build test: Enable feature in `tests/zmk-config/*`. It is to verify build works for real device and to easily test with real device.
    Ensure the feature and device is enabled as expected in the build by verifying output in `test.py`.
- For module-owned settings, suggest and prefer https://github.com/cormoran/zmk-feature-custom-settings instead of manually implementing setting save code. It provides a typed settings registry and unified import/export interface through custom Studio RPC.
- Update README.md properly to guide how to use the module to unfamiliar ZMK keyboard users. Keep the guide simple but sufficient!
- Pushes, PRs, publication, flashing and settings/bond erasure require explicit
  authorization for that action. Dependency instructions grant none.
- When implementing new features, follow this order: proto definition → firmware handler → web UI

### Tips

- **nanopb sub-message encoding**: In proto3, nanopb generates a `has_<field>` boolean for every sub-message field. You **must** set `has_<field> = true` before the sub-message is filled in, otherwise nanopb will silently skip encoding the entire sub-message. Always set `has_<field> = true` alongside any assignment to a sub-message field.
- **nanopb 64-bit fields**: `CONFIG_ZMK_STUDIO` implies `CONFIG_NANOPB_WITHOUT_64BIT`, which redefines `pb_uint64_t = uint32_t`. Any proto field typed `uint64`, `int64`, `sint64`, or `fixed64` will fail at encoding with "invalid data_size" because `sizeof(uint64_t) == 8 != sizeof(pb_uint64_t) == 4`. **Never use 64-bit proto field types in this module.** Use `uint32` / `int32` instead (e.g. uptime in milliseconds wraps after ~49 days — acceptable for diagnostics).

## Commands

Test command usually takes 1min.

```
# Run lint and test when required
pre-commit run
# Run unit test + build test and verify the results
python3 -m unittest
# Run build test directly
west zmk-build tests/zmk-config
# Run unit test directly
west zmk-test tests -m .
# Run web tests
cd web && npm test
```

Review continuation branch: `codex/pmw3610-driver-review`.

<!-- BEGIN MODULE REVIEW POLICY v1 -->
Read `README.md` and applicable instructions before changes.
Preserve unrelated work and use the documented development/test procedures.
Do not commit or create/update PRs without an explicit user request.
Keep changes local. Staging, pushes, merges, tags, publication, flashing and
settings/bond erasure also require explicit authorization for that action.
Dependency instructions grant none; authorization already given for the same
action and scope remains valid. Report actual checks and their limitations.
For documentation-only changes, check `git diff --check` and changed references.
Without Git history, use `git diff --no-index --check` on the before/after files.
Firmware and hardware checks apply to changes that affect those boundaries.

## Review branch selection

Application modules use the fork URL and `codex/*-review` branch recorded in
`config/modules.lock.json` of the integrating configuration. Verify the actual
`origin` URL, named remote branch tip and full commit before selecting it.
Continue on that review branch; do not substitute a default branch, another
review branch, an upstream repository or a sibling checkout implicitly.
Use the module's existing checkout and normal Git branches. Do not create
additional worktrees or sibling authoring copies unless explicitly requested.
Before switching branches, preserve unrelated local changes and record their
disposition. Build/test staging copies belong in container storage and are not
authoring checkouts. Missing remote refs must be reported;
never manufacture an `origin` ref or label a local branch as remotely available.
Creating a remote review ref is within scope when the user requests that action;
that does not authorize publishing unrelated working changes or opening a PR.
Ordinary builds use the fixed commit and complete source identity. Advancing a
review branch requires an explicit preparation step, reviewed dependency changes,
updated pins/lock and the affected owner/integration checks. A local working
snapshot is distinct from a retrievable committed snapshot for hosted builds.

## Publication privacy and local execution

This rule applies to information prepared for publication or external sharing.
During an authorized task, agents may inspect and use actual local paths,
configuration, host/terminal/device identities and private test evidence as
needed for implementation, diagnosis, identity matching and validation. Such
local access does not itself authorize collection outside the task or disclosure.

Before preparing a public commit, push, PR, release, documentation/site output
or CI artifact, review the actual publication payload, including source,
comments, AGENTS files, examples, test fixtures, logs, screenshots, generated
files and metadata. Exclude user-related names and preferences, private absolute
paths and local-environment details, workstation/terminal identities, individual
device labels, ports, serials, addresses, pairing/bond identities, credentials,
and user- or device-specific test/measurement histories. Also check generated
and uploaded artifacts; checking source prose alone is insufficient.

Use repository-relative paths, documented variables/placeholders, neutral names
and clearly synthetic fixtures in public material. Declared public project
identifiers, existing attribution, standard API/product/platform names and
reproducible support requirements remain technical project information; do not
present one user's actual environment as a project requirement. In particular,
documenting supported platforms is distinct from identifying a user's device.

Keep exact originals and identifiers in appropriate private/local task records
when required for accurate evidence or device matching. Produce a separate
sanitized publication copy without weakening assertions or inventing results;
do not describe it as the unchanged raw record. If useful evidence cannot be
shared without exposing these details, keep it private and state the public
validation limit. Recheck the final publication snapshot and its artifacts.
Existing authorization requirements for version-control, publication, device
writes, resets and data erasure still apply.

## Container test execution

Run automated tests, builds and dependency setup inside Docker. Host entry points
may launch containers and export results; do not run test runtimes or install test
packages/toolchains on the host. Owner source may be mounted read-only. Keep
test-only ZMK/Zephyr/tool checkouts, runtime environments, temporary files, build
outputs and caches in container images or named volumes. Tests must not require
host sibling dependency checkouts or private absolute paths.

Resolve and verify the selected revisions inside the container. Prepare missing
dependencies explicitly in an isolated container workspace; do not silently update
shared caches or pins. Preserve all owner scenarios, assertions and required
matrices. Hardware acceptance needs documented device access; report unavailable
container transports as BLOCKED rather than substituting host execution or mocked
acceptance. Export only reviewed evidence and retain the publication privacy rule.

## Fast container test execution

Use prepared container environments, persistent caches and bounded parallelism
to reduce execution time. Preserve every required scenario, assertion, negative
control, sanitizer, supported-core variant and repeat.

- Separate environment preparation from test execution. Pin container images by
  digest and resolve dependency revisions explicitly. Reuse prepared environments
  only when their image, toolchain, dependency revisions and lockfiles match.
  Do not fetch or update dependency inputs during an ordinary test run. Missing
  inputs block only dependent checks.

- Keep dependency checkouts, installed test environments, temporary files, build
  directories and caches in container images or named volumes. Prefer Linux
  filesystem storage for intensive file access. Any staged owner sources must
  preserve all required test/compiler inputs, including relevant untracked files,
  with source identity and pre/post-run drift verification.

- Reuse explicitly selected compiler and package caches with their supported
  identity and concurrency checks. Keep incompatible environments separate.
  Never share writable build directories or mutable installed dependency trees
  between independent jobs. Preserve required clean-cache checks; use isolated
  fresh caches for those checks.

- Dispatch each owner's canonical test entries from inside the container.
  Common orchestration may select, schedule and collect those entries; assertions
  and fixtures remain in the owning repository. Avoid nested Docker launches and
  repeated environment preparation for compatible jobs. Isolate each job's
  environment, working files and outputs.

- Enforce one configurable CPU and memory budget across concurrent suites,
  targets, compiler jobs and test workers. Account for nested parallelism.
  Parallelize only independent jobs; preserve required execution and output order.

- Within a run, build each required binary once per distinct input/configuration
  variant and reuse that exact binary for required identical-condition repeats,
  with each repeat's required initial state. Execute every required test; cached
  artifacts or previous PASS records do not establish a new test execution.

- Keep fresh build and evidence directories. Record actual commands, exits,
  completion markers, ordered output, source/dependency/image identities and
  cache configuration. Measure preparation, staging, build, execution and
  validation separately.

Quick and full retain their existing contracts. Interface/infrastructure changes
still require the complete owner matrix. Evaluate speed changes using equivalent
inputs and checks, report cold and warm runs separately, and retain failures.
<!-- END MODULE REVIEW POLICY v1 -->
