# WHA-1362 — authorized final foundation recheck

Verdict: **PASS — foundation-only**, exact private HEAD `2b5ab7974116051e1075ab7f3006969b1959e697`. Review complete. This supersedes the initial FAIL for GitHub91/92 only on this corrected tree; original `../REVIEW.md` and all original artifacts remain byte-for-byte preserved. Supervisor/board owns acceptance and integration. No consumer candidate was included.

## Candidate identity and authorized scope

Branch: WHA-1362-verify-hw-combined-receipt-layout-queue-authorization-and-printer-runtime-review.
Cwd: /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1362-verify-hw-combined-receipt-layout-queue-authorization-and-printer-runtime-review.
Starting HEAD `872984e7bd434e203b5bf8047b5848971a42325f`; initial dirty state only untracked `docs/reviews/`. Original foundation411306de and translated producer changes4ba8cd08/872984e7 already present; none repeated.

Final parent `aac8172fb7efbbe09b38a2b4bf04dbec5a09b6d8`. Final tree `11730372c68263db4fb76edeb1ee58029713fcca`.

Four authorized private cherry-picks, all exit0, no conflicts:
- `bdea63a2cd3d35eab300dc585e7e1352cf64c4e4` maps to `a0a01c6f113727dc8235467fb7246b1cb70d0f45`.
- `513d05ad34f3268c2229c2ea5703786726e7ccde` maps to `3ce6cbf96ffb8a571c802fb8a67cf2770e6024fb`.
- `5c222a54ef24993693b4c07d4066c89a2ac5fb9b` maps to `aac8172fb7efbbe09b38a2b4bf04dbec5a09b6d8`.
- `ceed2f40a78bafbc24d68506f010218c30a0a6fe` maps to `2b5ab7974116051e1075ab7f3006969b1959e697`.

Source parents independently inspected: bdea63a2 parent411306de;513d05ad parentbdea63a2;5c222a54 parentbc069370;ceed2f40 parent655c7f9a. Source paths match owned correction scope. Native correction exactly2 files,15 insertions/4 deletions. `composition.json` retains full mapping and SHA256 hashes of all preserved artifacts.

## Regression and protocol results

- **GitHub91 PASS:** semantic Unicode remains intact in React-escaped browser markup at58/80mm. Raw Unicode fails with `UNSUPPORTED_PRINT_TEXT`, `BROWSER_OS`. API returns422 and exact safe `error`, `code`, `fallback`, `retryable:false`; no queue creation. Malformed commands/broken UTF-16 return400 without fallback before enqueue; direct malformed service calls produce `INVALID_PRINT_DOCUMENT`, fallback null, no persistence.
- **Queue containment PASS:** producer DB tests and four independent review DB cases. Legacy invalid unattempted jobs become OFFLINE with attemptCount0, lastAttemptAt/printedAt/byteCount null. Review case inserts11 invalid rows (including malformed command), followed by valid work: first poll holds10 and returns null; next poll holds remainder and claims valid bytes. Subsequent polling never retries held/attempted rows. Previously attempted invalid row remains exactly unchanged. Null poll is bounded batch behavior; runtime polling must continue.
- **GitHub92 PASS:** same scoped transitive graph now has0 diagnostics; includes330 Next files among1305 files. Required claimToken and corrected fake-TCP allowlist caller compile together. Native environment is explicitly typed, has fixed NODE_ENV production, and has no ProcessEnv assertion or arbitrary inherited environment. Runtime suite60/60.
- **Claim/HMAC/authorization PASS:** rerun11 claim DB cases and print API boundary tests cover tenant/branch/device binding, current attempt, tampering, unclaimed ACK, exact30000ms expiry, concurrent claimant/ACK, replay and status-change rejection. Runtime validates/echoes token with its authenticated Bearer. Source HMAC includes protocol version, organization, branch, job, device, attempt count and timestamp; timing-safe comparison retained. Device-auth middleware itself unchanged; prior source review reused.
- **Native/host restriction PASS within mocked scope:** exact target allowlist, fixed native commands, shell:false, bounded payload, restricted child environment/arguments, pre-write durable marker and uncertain-delivery no-retry covered by60 runtime tests. Fake loopback TCP DB round trip now executes with required route allowlist and claim ACK. No physical or real OS spooler test.
- **Snapshot/settings PASS within foundation:** independent DB tests compare exact queued bytes against full preview at58/80mm after caller layout/totals/payments mutation. Rerun settings tests cover authorization, SQLNULL-only default semantics, rejected invalid stored settings, strict origin, revision CAS, RLS, rollback and independent branches. Unchanged migration/object constraints and broader source-security findings reused from initial review. Browser semantic preservation/React escaping are tested; actual Urdu shaping and visual layout are not.

## Independent checks

Execution: archive of exact HEAD under PAPERCLIP_RUN_SCRATCH_DIR/combined; compose node_modules symlink used read-only; Vite cache redirected to owned scratch; Prisma generated only into owned archive. No implementation edits. Only review fixtures/report added.

1. `node node_modules/prisma/build/index.js generate`: exit0, scratch-only client (`generate.log`).
2. Eight focused suites using `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=<evidence>/unit.json`: **127 passed,0 failed,0 skipped/pending**,8 files. Exact file list/command in `commands.json`.
3. Same Vitest flags for restaurant-settings.db, claim.db, printing.db, and independent wha1362-recheck.db fixture: **23 passed,0 failed,0 skipped/pending**,4 files. Exact command/DB identity in `db-command.json`; assertions and output in `recheck.db.test.ts.txt`, `db.json`.
4. Three added API assertions: **3 passed,0 failed,0 skipped/pending** using same flags and `tests/wha1362-api-recheck.test.ts`; fixture preserved in `api-recheck.test.ts.txt`, results `api.json`.
5. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.verify.json`: exit0,0 diagnostics. Same config as initial review; copied alongside evidence. `tsc -p tsconfig.verify.json --listFilesOnly`: exit0,1305 files including330 Next files (`type-graph.json`). Source/Next graph scope excludes review-only fixtures and unrelated consumers.
6. `node node_modules/eslint/bin/eslint.js <all22 changed TS/TSX files from fe1e3e38..HEAD>`: exit0,0 diagnostics. Exact paths in `commands.json`.
7. `git diff --check fe1e3e38..HEAD`: exit0.

Total executed tests: **153 passed,0 failed,0 skipped**. No repeated unchanged suite. Additional3 API cases close explicit response-field/malformed-input evidence gaps.

## Isolated DB identity and limits

Used only published WHA1354 disposable database `wha1354_disposable_b032106891`,127.0.0.1:52027, runtime `wha1354_runtime_b032106891`; URL identity asserted privately before launch. Fresh randomized tenants created by all4 suites; cleanup limited to their own organization IDs. Each suite independently ran enforcing-role guard. Independent review tenant prefix `wha1362-` plus random UUID; no existing tenant reads/writes. Existing WHA1350 database never accessed. Shared disposable cluster left running; WHA1354 owns environment cleanup.

Published fixture identity and migration evidence reused from WHA1354 `.wha1354-verification-NSdov4`: PostgreSQL16.15;105 migrations,0 unsuccessful/checksum mismatches; runtime owns0 app tables; branch tables ENABLE/FORCE RLS. Those metadata counts are prior evidence, not newly reprovisioned evidence. No credentials copied into report.

## Remaining gates and disposition

Foundation review **DONE/PASS**, without waiting for WHA1355. Canonical Restaurant1355 and Pharmacy1358 consumers, end-to-end invoice/fallback integration, full build, Studio viewport/theme/accessibility/browser matrix, actual Unicode shaping, actual Windows/macOS spooler and physical printer acceptance remain outside this review. No release, hardware exactly-once or physical-print guarantee. Human-only approval actions remain owner's responsibility.

No new findings; GitHub91/92 receive primary regression evidence first, Paperclip receives consolidated result second. No issue-close/release decision impersonated. No nested CLI, extra agents/workers, source correction, shared dependency/client mutation, real device, app/browser service, push, merge, reset, rebase, deploy or production access.

Recovery remains unchanged: uncertain physical writes require operator reconciliation before any new attempt; held unsupported documents need browser/OS output or corrected new intent. Preserve additive schema on any later rollback. Board owns integration decisions.

Graph/task-memory/Ponytail and rg unavailable this run; narrow file fallback used. One authorized final recheck completed; no further review loop scheduled.

## Exact correction paths

- docs/receipt-layout-WHA-1354.md
- scripts/print-bridge.ts
- src/app/api/restaurant/print-bridge/route.test.ts
- src/app/api/restaurant/print-bridge/route.ts
- src/components/receipts/receipt-designer.test.tsx
- src/lib/receipts/configuration.test.ts
- src/lib/receipts/configuration.ts
- src/lib/receipts/preview.ts
- src/lib/restaurant/printing/claim.db.test.ts
- src/lib/restaurant/printing/contract.ts
- src/lib/restaurant/printing/esc-pos.ts
- src/lib/restaurant/printing/printing.db.test.ts
- src/lib/restaurant/printing/receipt-snapshot.test.ts
- src/lib/restaurant/printing/service.ts
- tests/print-bridge.test.ts
