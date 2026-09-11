# WHA-1370 private compatibility verification

**READY — private development build/compatibility lane only.** No unresolved source defect found by the checks below. This is not an accepted authoritative composition or release approval.

## Exact object boundaries

Assigned branch preserved: `WHA-1370-verify-hw-private-restaurant-camera-and-receipt-compatibility-build-then-pharmacy-consumer`.
Initial `git status --short` was empty. Expected and actual base HEAD: `f0c6138ea9ef0572c1b7ecdd64af38676e6be7b0`; tree: `7e8d6678b37673b05d3e6e6b8312552a3a2b4b33`.

Phase 1 Restaurant receipt plus camera HEAD: `9070a91cc3782f6838c6b60d7bd4b2cd15283232`; tree: `36aeb45695cb549d9581232c1e979c5e08de0e3d`.
Its successful build and protocol evidence were written to this directory before Phase 2 cherry-picks began.

Phase 2 combined source HEAD: `74b80188fa9c66c2761a74794b9aff8113be8a39`; tree: `375d3986c2998959721a8d1abc0bdbd7079a64d4`.
The subsequent evidence-only commit does not change implementation; the exact tested source is this Phase 2 HEAD.

| Phase | Original source                            | Original parent                            | Private cherry-pick                        |
| ----- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| 1     | `773a1a8e9b4b85ca8a3ae08aba87055c9726513c` | `fe1e3e383c8b966cdb68669ba5366db00fe2320a` | `9be72d0cede7f6a9b3ae38d62d677c497e063754` |
| 1     | `977eed1eb3bb2a611ee139bf65592630b420b5d3` | `773a1a8e9b4b85ca8a3ae08aba87055c9726513c` | `0cc86c095ac3ab6b41ea013755552c85c03474cc` |
| 1     | `036debad81072badc79e7331fae20e2a84addf3e` | `977eed1eb3bb2a611ee139bf65592630b420b5d3` | `6e6bda1548929d514cd46e4bb5d6c418d1354fd7` |
| 1     | `f81ae0c315c1c96e950dfb2eee1ffb384d7d9947` | `036debad81072badc79e7331fae20e2a84addf3e` | `9070a91cc3782f6838c6b60d7bd4b2cd15283232` |
| 2     | `8fccc771aeb4fdd07141ada88e8a74e39459a588` | `fe1e3e383c8b966cdb68669ba5366db00fe2320a` | `9c4d611525706330ac95b2f7bbeac86f3a4df740` |
| 2     | `2cdef75b9f9bb85f9706ec113a13c3a6267d5183` | `8fccc771aeb4fdd07141ada88e8a74e39459a588` | `e8dca138468350bf7ff0ea0d5a6228c9a3e85d7f` |
| 2     | `c49b1afa252f20905269a044d09bdb0406eb7b60` | `fe1e3e383c8b966cdb68669ba5366db00fe2320a` | `677dae7e6b058ba4a9e487128bbeb9dfdd69712c` |
| 2     | `5a1549376377af8321314d3bbfb2ff3a4e987230` | `57cb2f0d77b7b4b68214797faf13ee52927599ca` | `74b80188fa9c66c2761a74794b9aff8113be8a39` |

All eight cherry-picks exited 0, without conflicts. Stable `git patch-id` matches original/private for every patch. Source maps include every intermediate private tree. Original parent/scope evidence is in `source-objects.txt`; exact changed paths are in `phase1-files.txt` and `phase2-files.txt`.

The existing receipt source/ancestry map in `docs/receipt-checkout-WHA-1355.md` identifies translated shared 806/411/bdea/513, queue bc069/5c222, and runtime 655/ceed prerequisites already in the base. None was repeated. No alternate camera credential infrastructure or purchasing `424474e5` patch was added. Source producers were not rewritten.

## Execution evidence

| Check                                             | Result                                                                              | Exit |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- | ---- |
| Phase 1 initial `bun run build`                   | Prisma generation and bundle passed; default ~4 GB TypeScript worker exhausted heap | 1    |
| Phase 1 sized `bun run build`                     | Bundle, full TypeScript, static generation 163/163, build finalization passed       | 0    |
| Phase 1 native camera protocol tests              | 16 passed / 0 failed / 0 skipped                                                    | 0    |
| Phase 2 `bun run build`                           | Bundle, full TypeScript, static generation 163/163, build finalization passed       | 0    |
| Phase 2 initial 31-file intersection Vitest run   | 342 passed / 60 failed / 0 skipped; all failures in runtime scratch setup           | 1    |
| Runtime-only retry with scratch variable restored | 60 passed / 0 failed / 0 skipped                                                    | 0    |
| Actual `hls.js` ESM import/version check          | `Real hls.js ESM import: 1.7.2`                                                     | 0    |
| Source/private stable patch identity checks       | 8 matches                                                                           | 0    |

Final unique executed coverage: **418 passed / 0 unresolved failures / 0 skipped**. This combines 402 Phase 2 Vitest cases across 31 files with 16 Phase 1 native camera cases. Native camera source and dependencies are unchanged by Phase 2; this evidence was reused, not represented as a second execution. The final 402-case total combines the unchanged 342 passes with the 60-case runtime retry; there was no all-green monolithic rerun.

Integration coverage includes camera UI/lifecycle/grants/router and audit redaction, Restaurant receipt caller/UI/shared layout/renderer/queue contract/runtime, settings intersections, and Pharmacy receipt presentation/browser print/query refresh/identity/settlement. Pharmacy contributes 55 cases. Assertions and file-level counts are retained in JSON. Prior independent 209/164/53/48 reports were context only and are not counted as our executions.

First observed environment failure was:

```text
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
Next.js build worker exited with code: null and signal: SIGABRT
```

Host has 24 GiB RAM. One build retry raised the Node heap to 8192 MiB, added an ephemeral synthetic authentication secret required by production validation, and retained the real build script and typechecking. This resolved the failure; no source correction was needed.

Initial test environment omitted `PAPERCLIP_RUN_SCRATCH_DIR` during credential sanitization. Runtime test `beforeEach` at `tests/print-bridge.test.ts:40` failed with:

```text
Error: Set PAPERCLIP_RUN_SCRATCH_DIR to an isolated test scratch directory.
```

Its teardown additionally received an undefined path. The single affected file was rerun with the existing run-owned scratch path passed through, resolving all 60 setup failures. No tests or assertions changed.

## Reproduction and isolation

Repository script is exactly `prisma generate && next build`, invoked with `bun run build`. Node `v22.23.1`, Bun `1.3.14`, Next `16.2.12`, Prisma `7.9.1`, Vitest `4.1.10`. Installed Next deployment and TypeScript guides were read; Studio contract was read in full before UI source inspection.

Starting worktree had no `node_modules` or local environment file (only `.env.example`). A private filesystem copy (`cp -cR`) of WHA-1355 matching dependencies was made under this worktree. Dependency/devDependency/override declarations match except the authorized new HLS pin. No external dependency symlinks remained. Other worktrees, previews, and their generated clients were untouched.

The internal HLS attachment `e455eada-b7d0-4995-89d1-af096a6fa45a` independently matched 8,003,699 bytes, SHA256 `14311c46a7aea04a7ffc373653b11d019bb41df8a693a2459eb3115a262aef53`, and exact lockfile SHA512. Every archive entry was checked: package-prefixed regular file/directory only, no absolute path, traversal, links, or special files. Extraction occurred in run scratch, then copied into private `node_modules/hls.js`. Real package import and actual production bundle passed; no alias, stub, fake dependency, install, or upgrade was used. See `hls-integrity.json`.

Build subprocesses inherited only PATH, HOME, USER, SHELL, LANG, TMPDIR; set production NODE_ENV, telemetry disabled, private XDG/Bun cache directories, Prisma update-message suppression, 8192 MiB Node heap, and generated synthetic AUTH_SECRET. No production secret or database URL was provided. `NEXT_BUILD_SKIP_TYPECHECK` was absent. `run-build.py` reproduces the successful environment categories without storing the synthetic secret. Build output and generated Prisma remained private.

Test subprocesses used the same OS/path environment subset with test NODE_ENV and private cache. Runtime retry additionally passed `PAPERCLIP_RUN_SCRATCH_DIR`. No DB was needed, provisioned, connected to, or migrated. Database suites were not selected; this lane does not independently re-prove DB isolation/atomicity. No local application/browser service started. Native camera tests used their synthetic transport fixtures.

```sh
python3 docs/verification/WHA-1370/run-build.py phase2
# Exact 31-file Vitest argv retained in intersection-command.json.
# Resolve its outputFile to your own PAPERCLIP_RUN_SCRATCH_DIR on reproduction.
node node_modules/vitest/vitest.mjs run tests/print-bridge.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile="$PAPERCLIP_RUN_SCRATCH_DIR/runtime-retry-results.json"
bun test src/lib/restaurant/cameras/mediamtx.protocol.test.mts src/lib/restaurant/cameras/mediamtx-runtime.test.mts src/lib/restaurant/cameras/mediamtx-route.test.mts
node --input-type=module -e 'import Hls from "hls.js"; if (Hls.version !== "1.7.2") throw new Error("Unexpected version"); console.log("Real hls.js ESM import:", Hls.version);'
git diff --check
```

The existing CLI harness was used; no nested Codex or extra agents. No callable Ponytail, Claude-Mem, or Codebase Memory tool was exposed in this run; no claim of their execution is made. Direct Git objects, known-path reads, compiler and test evidence supplied this bounded verification.

## Remaining boundaries and recovery

No blocker remains for this assigned private lane. Formal WHA-1364 human-only confirmation and policy 89 remain their existing owners' gates. Authoritative composition/release, approved staging visual QA, full Studio viewport/theme/motion/accessibility matrix, physical cameras/MSE decoding/native printer/OS behavior remain unverified here. This report cannot clear those gates.

No implementation fixes, unrelated repairs, migrations, merge, push, Git remote mutation, deployment, existing tenant DB access, or device claims. Report-only changes are confined to this directory. Private source combinations can be omitted from future composition as a set; no deployed state or database needs rollback. Preserve this branch and its private artifacts for review.

Evidence packaging: the first staged whitespace check exited 2 because raw tool logs contain trailing spaces/EOF blank lines. Log whitespace was normalized without changing diagnostic text; raw/stored SHA256 values are retained in `log-integrity.json`. Final staged whitespace check passed (exit 0).
