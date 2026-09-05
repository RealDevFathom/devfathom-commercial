# WHA-1370 final private compatibility extension

**READY — private build/compatibility scope only.** No causal source defect found in this bounded execution. This is not an authoritative candidate or release approval.

Starting worktree was clean on the assigned branch at evidence HEAD `4f369a85292882d248ed70b53112c3a7806deb8c`; prior tested source `74b80188fa9c66c2761a74794b9aff8113be8a39` and all previous reports are preserved unchanged.

Final tested source HEAD: `bd218de8fa39c1c464a3b22b16a0021a86b736e1`.
Final tested source tree: `1d68131dc765f629e40425110e98ab89ca5e3dde`.
The subsequent evidence-only HEAD is recorded in the issue completion comment; its parent is this tested source. It changes only this new report directory.

## Exact source composition

| Original source | Private SHA | Private tree |
| --- | --- | --- |
| `671a5974e036ac31103a05293e59130898ff1f04` | `8e006fa2ab6da4f5c5da251840df57cce6ae4be9` | `f55a736f47e76dac2aa9ede37903cfebb361f94d` |
| `c462f5f6f079faac3eb1a765498fa411f68ea876` | `77135089a0469969bda75e5c5649edeef0cae95c` | `2995220b1f180e3df5326855a0d73184094b91c0` |
| `de44c9e32f1d77fdb2daea991ac509d054ca80f3` | `65e78f99064715e7967170f3523bcb96df81b40b` | `c48bb1117214222ca53358b3aeb42bf04cac7ef9` |
| `424474e5a8978bba611e4d4d260debdca2dac3db` | `75fb32b7aa902429865b7206ac083961000810d9` | `4d1e711ed8be444c9d10f7f6afcf204bb627f86a` |
| `8958012bdf0fea5c3a427d16652e944a05ba0343` | `dab384886d7026998eaca8eecee5c7c5f7beeeb2` | `8de07b25adba8c43f19155687c99f2c0a3511b0d` |
| `1c4d8d9f9d3b5d5b95722d36cfafc64728ce937e` | `bd218de8fa39c1c464a3b22b16a0021a86b736e1` | `1d68131dc765f629e40425110e98ab89ca5e3dde` |

All six cherry-picks exited 0 without conflicts; all six stable patch IDs match. `map.json` records original parents and original trees as well. Both independent repairs and the harness have parent `fe1e3e383c8b966cdb68669ba5366db00fe2320a`. Purchasing starts at that same parent and follows the exact de44c9e3 / 424474e5 / 8958012b chain. No test/build ran on its known-failing intermediate commit.

`changed-files.txt` lists every changed source path. The combined sales implementation and test, entire purchasing directory, and new migration byte-match their final original producers (`byte-match.json`, exit 0 each). No implementation corrections or producer rewrites were made. Only the reserved `20260905080000_pharmacy_regulatory_profile_tenant_purge` migration was added; no existing migration changed. No previously included camera/shared/receipt/initial Pharmacy commits or excluded owner-gated work was repeated.

Behavior added by the source patches: void restores stock movements and serializes sale transitions; regulatory profiles permit tenant-purge deletion; purchasing returns classified outcomes, retains validation inputs and locks uncertain writes; existing browser harness selectors/fixtures and JSON report destination align with the source. Harness assertions remain present, including zero-failure/skip checks and the strengthened expected Restaurant count of 17. Browser execution is not claimed.

## Fresh execution

| Check | Actual result | Exit |
| --- | --- | --- |
| `python3 docs/verification/WHA-1370/run-build.py extension` invoking real `bun run build` | Prisma generated; production bundle passed; full TypeScript passed; static generation 163/163; finalization passed | 0 |
| Combined 34-file Vitest invocation in `intersection-command.json` | 463 passed, 0 failed, 0 pending/skipped, 0 todo | 0 |
| Native camera invocation in `native-exit.json` | 16 passed, 0 failed, 0 skipped, 3 files | 0 |
| `git diff --check` | no whitespace errors | 0 |

**479 unique freshly executed tests passed; 0 failed; 0 skipped.** No retry or copied prior test count. Purchasing contributes 32 console and 16 action-form tests (48 total); sales contributes 13 mocked tests. The other 402 Vitest cases cover core camera, Restaurant receipts/printing/runtime, shared settings and Pharmacy receipt/settlement intersections. Exact files and assertion-level results are in `test-summary.json` and `intersection-results.json`; native names are in `native.log`. No database suite was selected; unexecuted DB/browser gates are not hidden within these counts.

The real package script remains `prisma generate && next build`. Installed Next 16.2.12 deployment and TypeScript configuration guides were read. Build used the existing reproduction runner: 8192 MiB heap, ephemeral valid synthetic AUTH_SECRET, production NODE_ENV, telemetry disabled, private caches and generated Prisma, inherited OS/path variables only. No DATABASE_URL, real secret, or typecheck bypass was supplied. Existing private node_modules was preserved; no external symlink was found, no installation/upgrade occurred. Build used actual existing HLS dependency; previous tarball integrity evidence is preserved and was not represented as a new download.

Tests used test NODE_ENV, private caches, and explicitly retained PAPERCLIP_RUN_SCRATCH_DIR. `run-intersection.py` preserves execution environment categories. For reproduction, copy it and `intersection-command.json` into `$PAPERCLIP_RUN_SCRATCH_DIR/extension`, replacing the JSON outputFile argument with your run-owned scratch destination, then run the script. Both commands and subprocess return codes are persisted. Stored log whitespace was normalized; raw/stored hashes are retained in `log-integrity.json`.

No existing preview, dirty worktree, tenant database, or fixture was touched. No DB was provisioned/migrated; no local app or browser ran. Native protocol tests use synthetic transport fixtures. The existing CLI session was used without nested CLI or agents. No callable Ponytail/Claude-Mem/Codebase Memory tool was exposed; no execution claim is made for those tools. Git object evidence and known-path reads supplied source discovery. Studio contract was read; no redesign or visual acceptance was performed.

## Remaining gates and handoff

WHA-1352 received one actionable handoff, comment `25da6c6b-d335-4c6e-8a21-0ea8d2db6a87`: exact combined source/tree and sales blobs for its independently owned isolated DB/concurrency proof. Its earlier static-only review is not runtime acceptance; this lane's 13 mocked sales passes do not clear that empirical gate. WHA-1353's prior 16 DB passes and WHA-1349's prior 48 source-safety passes remain prior reports, not this run's executions.

Formal human confirmations, purchasing JS-only/router-error lock/reload product decisions, Pharmacy policy 89, exact CI/staging, Studio visual matrix, physical camera/printer behavior and release gates remain their owners' responsibility. WHA-1116 status is untouched. No push, remote merge, deployment, owner-push request, or authoritative-candidate label.

Recovery: preserve this branch and reports. This source combination can be omitted as a set from future composition; no deployed state or database requires rollback.
