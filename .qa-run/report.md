# WHA-1589 — partial pharmacy execution, blocked by disk capacity

Candidate: `89f39834`, detached owned worktree `ph-qa-specs`. No tracked source changes, fixes, pushes, merges, or deployments.

## Disposition
Blocked. Disk started at 17 GiB and fell to 7.4 GiB during the production build (6.3 GiB after shutdown), below the required 8 GiB reserve. Build was terminated; all three owned PostgreSQL clusters are stopped. Unblock owner: local-board / workspace storage operator. Reclaim capacity in owner-approved paths or provide capacity, leaving at least 8 GiB after install/build, then wake WHA-1589 for purchasing and finance execution. Do not delete other agents’ worktrees.

## Commands and results
| Command | Exit | Results |
|---|---:|---|
| `df -h /` before worktree creation | 0 | 17 GiB available |
| `git worktree add --detach .../ph-qa-specs 89f39834` | 0 | candidate created |
| `caffeinate -dimsu bun install --frozen-lockfile` | 0 | 1294 packages installed |
| Counter extension preparation / migrate deploy | 0 / 0 | all migrations applied |
| Counter setup wrapper | 3 | unnecessary blanket function grant rejected on extension function; table/sequence grants passed; extra grant omitted |
| `caffeinate -dimsu bash .qa-run/run-counter.sh` → `bun run test:e2e:pharmacy-counter --reporter=html,line` | 1 | preflight + seed twice passed; 0 passed, 2 failed, 6 did not run |
| Purchasing setup: extension preparation → migrate deploy → purchasing seed | 0 | fresh lane ready |
| Finance setup: extension preparation → migrate deploy → base seed → restaurant fixture seed | 0 | fresh lane ready; 197 owned fixture rows, 0 leaked rows; Insights fixture verification passed |
| `caffeinate -dimsu env DATABASE_URL=<runtime lane> AUTH_SECRET=<synthetic> bun run build` | 143 | compiled in 71s; terminated during TypeScript because disk reserve failed |
| Purchasing Playwright command | not run | blocked before build completion; 0 executed, no result for expected 6 |
| Finance Playwright command | not run | 0 executed; default config expands its one test to desktop and mobile Chromium |
| Owned PostgreSQL shutdowns | 0 each | counter 55689, purchasing 55690, finance 55691 stopped |

Each DB lane used loopback only, separate owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE and runtime LOGIN NOSUPERUSER NOBYPASSRLS. Extension preparation used the disposable bootstrap role, migrations the owner, and seeds the runtime. Commands used caffeinate. No Vitest or standalone tsc invocation.

## Browser failures
1. **Counter navigation** — `tests/e2e/pharmacy-counter.spec.ts:69`, failing assertion `:56`. Expected dashboard/pharmacy URL; remained `http://127.0.0.1:4331/login` after 30 seconds. Screenshot shows empty login fields. Trace records native `POST /login` → HTTP 200 HTML and no auth API call. Probable cause: form submitted before hydration (helper at lines 39–47 lacks hydration wait). Confidence limited: initial server startup suffered a harness-induced Turbopack error described below. Six subsequent serial counter cases did not run; no conclusion about pack conversion, Urdu aliases, Rx gating, receipts, or safety blocks is supported.
2. **Additional first-sale case** — `tests/e2e/time-to-first-sale.spec.ts:100`, failing `tests/e2e/fixtures/pharmacy-first-sale.ts:73`. Error: `Required runtime precondition: PHARMACY_FIRST_SALE_INPUT`. Config includes this extra case in addition to seven counter tests. Probable cause: the prescribed counter runner supplies the counter seed but this added case requires separate onboarding input. Screenshot and trace retained, but failure occurs before the onboarding browser workflow.

Harness limitation: PostgreSQL data/socket was initially placed under `.qa-run` in the source tree. Tailwind/Turbopack scanned `.s.PGSQL.55689` and raised `Operation not supported on socket (os error 102)`. During startup, the owned cluster was moved into the injected run temporary directory and restarted without Unix sockets. The server recovered and collected eight tests. No candidate code was changed and no test rerun was performed. These counter results are a partial diagnostic run, not clean acceptance proof.

## WHA-1196
**Neither confirmed nor refuted.** Purchasing never reached browser execution because its production build was stopped by the disk rule. Counter native login submission is not evidence of the purchasing server-action redirect defect.

## Evidence paths in archive
- `evidence/counter-html/index.html`: HTML report (open locally after extraction).
- `evidence/counter.log`: exact test output and failures.
- `browser/pharmacy-counter-pharmacy--1d072--excludes-Restaurant-routes-pharmacy-counter-serial/`: screenshot `test-failed-1.png`, `trace.zip`, video, error context.
- `browser/time-to-first-sale-admin-f-f9a71-to-the-first-completed-sale-pharmacy-counter-serial/`: screenshot `test-failed-1.png`, `trace.zip`, video, error context.
- `evidence/*setup.log`, `counter-roles.log`, `build.log`, `disk-stop.log`, `worktree-status.log`, `install.log`.

No purchasing/finance HTML report or trace exists, because those commands were not started. Only untracked run harness/evidence and install log were added to the owned worktree; generated ignored build/browser files also remain there. Temporary disposable databases are stopped and subject to run-directory cleanup.

## Upload packaging
Paperclip rejected the combined archive above 10 MB. Evidence is published as `browser.zip` and `reports.zip`; remove the `browser/` or `evidence/` prefix from the paths above when opening the corresponding split archive. The original install log is retained locally; its exit/count are recorded above. This standalone report supersedes embedded copies for packaging details.
