# DEV-665 part 3 — controlled register

## Root cause and evidence (2026-11-03)

Scope: `/Users/Saad/devfathom-qa/wt-dev665-3`, branch `fix/dev-665-part3`. No live data writes, branch assignments, sales, payments, refunds, drawer operations, stock changes, migrations, push, or merge.

The reported owner/pharmacist symptom is explained by **assignment filtering**, combined with an ambiguous frontend empty/loading state. It is not evidence of a missing tenant branch or a broken entry query.

Grounded repository evidence from the prior live audit:

- `qa/sehatcart-2026-11-02/api-evidence/probe1.json`, `owner.pharmacyBranchAssignments.list`, at **2026-11-02 23:04:22 PKT**: HTTP **200**, branch `cmvx5fc4p000cy5qrcgzjrc3b`, name **SehatCart Test Branch**, `assignments: []`. The same capture's `pharmacySales.counterBranches` returned that branch, explaining why other screens could show it.
- `qa/sehatcart-2026-11-02/api-evidence/sweep-desk-results.json`, `/pharmacy/controlled-register`: owner at **23:05:58 PKT** and pharmacist at **23:05:55 PKT** showed `No branch`, with **zero recorded HTTP or console errors**. Cashier/manager captures instead contain explicit **403 FORBIDDEN** for `pharmacySafety.branches`, a separate permission-denied case.
- These are archived audit captures, not a fresh database read. They establish the historical configuration/symptom, not today's assignments or entry count.

Current source path and deterministic reproduction:

1. `ControlledRegisterPage` renders `ControlledRegisterConsole`.
2. The console reads `pharmacySafety.branches`. Its `pharmacy:safety` capability gate precedes branch enumeration.
3. `assignedRegisterBranchIds` in `src/lib/pharmacy/controlled-register.ts` selects only active `pharmacyBranchAssignment` rows for the current **organizationId + userId**. `pharmacySafety.branches` returns `[]` immediately for no assignments, otherwise selects only active same-tenant branches in those IDs.
4. The old UI displayed `No branch` for undefined, failed, or empty branch data. No selected ID meant `controlledRegister` was disabled. Thus “no entries on screen” did **not** mean a successful empty register read.
5. `controlledRegister` and `recordCorrection` both use `organizationBranch`, requiring that assignment and an active same-tenant branch before reading/correcting. Its entry query is correctly constrained by organization and branch. Tests reproduce an existing SehatCart Test Branch with zero assignments returning `[]`, for both EMPLOYEE and ADMIN; direct register access remains forbidden.

Authorization is intentional: schema documentation explicitly says an empty assignment set is not a grant. A counter-specific admin exception does not establish a controlled-register exception. **No fallback to all tenant branches or role-based grant was introduced.** An administrator must assign an otherwise authorized user through the existing assignment workflow if the historical missing assignment still exists. This session does not change that data.

## Scope inventory and implementation

- Runtime edit: `src/components/pharmacy/dispensing/controlled-register-console.tsx` only.
- Caller: `src/app/(app)/pharmacy/controlled-register/page.tsx` unchanged; no other callers found by graph plus scoped search.
- Server read/correction paths: `src/server/routers/pharmacy-safety.ts` and `assignedRegisterBranchIds` traced, retained unchanged. Tenant scope, capability checks, active assignments, PIN correction safeguards, patient masking and witness-name handling remain intact.
- Existing shared UI reused: PageHeader, SectionCard, Button, WorkspaceState, fieldClass and semantic tokens. No redesign, dependency, export, config, migration, seed or shared-component change.
- Added `controlled-register-console.test.tsx`; extended `pharmacy-safety.register.test.ts`. Fixtures are isolated in-memory mocks; no DB connection.
- Accessible branch data now requires a successful query. A single accessible branch selects automatically; multiple branches require a choice. Removed/revoked selection cannot keep displaying or printing stale entries.
- Branch loading, branch load failure with retry, no-access guidance, branch-selection prompt, register loading, register failure with retry, populated entries and a plain successful-empty state are distinct.
- Branch changes clear correction entry identity and PIN. Existing corrections, mobile cards, desktop table, metadata, incidents, totals and masking remain.
- Print remains unavailable for empty/failed/unselected/refreshing data. Real popup behavior was verified. Visual inspection found a separate pre-existing print defect: Tailwind `block` metadata spans lose their layout in the popup, concatenating date/kind, name/registration and witness/PIN text. Added one print stylesheet rule for block metadata lines; verified fixed rendering.

## Workflow evidence

- Read repository AGENTS.md, full Studio contract, relevant bundled Next server/client component guide, Ponytail Ultra, Caveman Ultra and Codebase Memory skills.
- Worktree absent from `list_projects`; indexed with `index_repository(repo_path=..., mode='fast', persistence=false)` before discovery. Used graph search/snippets/traces; supplemented missing JSX/test graph edges with scoped search.
- Claude-Mem connector was not exposed and installed plugins were disabled in current config. Used the running local worker's scoped search API via documented port resolution: project `devfathom-commercial`, query `controlled register`, limit 5; **no matching results**. No broad history injected or global plugin settings changed.
- Live read-only HEAD request to `https://sehatcart.pharmacy.develop.devfathom.com/pharmacy/controlled-register` returned **307** to `/login?callbackUrl=%2Fpharmacy%2Fcontrolled-register`. Browser connector inventory reported **The browser access host is unavailable**. No authenticated live API/DB acceptance claimed.

## Verification so far

All repository commands use `PATH="$HOME/devfathom-qa/bun/bin:$PATH"`.

- `bun run db:generate`: **exit 0**, generated Prisma Client 7.10.0 locally. Initial tests/typecheck lacked generated Prisma files; generation corrected that setup issue. No database mutation.
- `bun run test src/components/pharmacy/dispensing/controlled-register-console.test.tsx src/server/routers/pharmacy-safety.register.test.ts src/lib/pharmacy/register-print.test.ts src/server/routers/pharmacy-witness-enumeration.test.ts`: **exit 0**, **29 tests / 4 files passed**. Log `/tmp/dev665-part3-tests.log`. Earlier test-only selector and cross-document matcher failures were corrected.
- `bunx eslint src/components/pharmacy/dispensing/controlled-register-console.tsx src/components/pharmacy/dispensing/controlled-register-console.test.tsx src/server/routers/pharmacy-safety.register.test.ts`: **exit 0**. Log `/tmp/dev665-part3-lint.log`.
- `bun run build`: **exit 1** before compilation: `Could not find the Next.js package (next/package.json)`. Worktree `node_modules` is a symlink to `/Users/Saad/devfathom-qa/repo/node_modules`, outside the configured Turbopack root (`process.cwd()`). Bundled Turbopack root documentation confirms external paths are not resolved. Repository configuration unchanged; supported webpack production-build fallback attempted separately. Log `/tmp/dev665-part3-build.log`.
- Post-generation full typecheck and webpack build outcomes will be appended below.

### Browser and design-contract matrix

Actual component and real shared styles/fonts rendered in a temporary Vite harness, using mocked tRPC hooks only. No application service/database or production writes. System Chrome used because packaged Playwright Chromium was unavailable.

- `node /tmp/dev665-part3-browser/verify.mjs`: **exit 0**, **128 passes** = 375/768/1024/1440 × light/dark × normal/reduced motion × 8 states (loaded, empty, branch loading/error, no accessible branches, register loading/error, multiple branches).
- One H1, no document horizontal overflow, bounded table behavior, automatic single selection, explicit multi selection, active/disabled/error/loading/empty states, branch/register retries checked. Keyboard tab order, visible focus and Escape checked at 375/1440. Two Axe checks: **0 violations**. Console, page and failed-request errors: **0**. No destructive confirmation applies to this patch; no correction submitted in browser.
- `node /tmp/dev665-part3-browser/verify-print.mjs`: **exit 0** after print CSS fix, both 375/1440. Real popup, intercepted `print()` invocation, visible three-row register, selected branch, totals, null opener, popup-blocked recovery; all **11 metadata spans** have block display. Screenshots visually inspected and PDFs generated.
- Reports: `/tmp/dev665-part3-browser/report.json`, `print-report.json`; exact commands/setup in `COMMANDS.md`; screenshots under `screenshots/`; final `print-register-fixed-375.pdf` and `print-register-fixed-1440.pdf`. Temporary server stopped and its port closed.
- Limits: standalone component harness, not authenticated tenant shell or live tRPC. Native print dialog, physical printer, current live assignment rows and live register entries remain unverified. Existing historical evidence is clearly separated above.

## Final verification outcomes

- Post-generation `PATH="$HOME/devfathom-qa/bun/bin:$PATH" bun run typecheck`: **exit 2**. Exactly five TS2307 missing-module diagnostics, all in unchanged files:
  - `src/app/api/assistant/route.providers.e2e.test.ts:2`: `@smithy/eventstream-codec`
  - `src/app/api/assistant/route.providers.e2e.test.ts:3`: `@smithy/util-utf8`
  - `src/lib/ai/provider.ts:1`: `@ai-sdk/amazon-bedrock`
  - `src/lib/ai/provider.ts:9`: `@aws-sdk/credential-providers`
  - `src/lib/ai/secrets.ts:3`: `@aws-sdk/client-secrets-manager`
  Log `/tmp/dev665-part3-typecheck-generated.log`. No diagnostics in changed files.
- `PATH="$HOME/devfathom-qa/bun/bin:$PATH" bun run build --webpack`: **exit 1**, fails compilation on the three missing Bedrock/AWS packages above. Log `/tmp/dev665-part3-build-webpack.log`. This supported fallback passes the external-symlink resolution issue but cannot complete with the current shared dependency installation.
- Verified all five package paths absent under `node_modules`; `git diff -- src/lib/ai/provider.ts src/lib/ai/secrets.ts src/app/api/assistant/route.providers.e2e.test.ts package.json bun.lock next.config.ts` was empty. These are unrelated environment/setup blockers, not changes introduced by this patch. Shared dependencies were not modified while other branches were running.
- Final related Vitest run after adding the print metadata layout regression: **exit 0**, **29/29 tests in 4 files**. The print test now checks computed metadata display in an iframe document as well as popup content, branch, totals and invocation.
- Final ESLint, Prettier check, and `git diff --check`: **exit 0**.
- Codebase Memory index refreshed after changes, persistence disabled; no graph artifacts added to the worktree.
- Focused diff reviewed: only the console and its two regression-test files are intended for commit. This evidence note is deliberately excluded.

Completion boundary: local UI implementation and mock regression/browser acceptance are complete. A clean full typecheck and production build remain blocked by the existing dependency layout/install. Current live branch assignment/entry acceptance requires an authenticated read; if assignments are still absent, an authorized administrator must provision them separately. No authorization bypass or live data change is included.

## Local commit and exclusion proof

Committed **8727beb0d76bee91a51136f80b9d045445c3a774** on `fix/dev-665-part3`:
`fix: clarify controlled register branch access and printing (DEV-665)`.

Exactly three files committed:
- `src/components/pharmacy/dispensing/controlled-register-console.tsx`
- `src/components/pharmacy/dispensing/controlled-register-console.test.tsx`
- `src/server/routers/pharmacy-safety.register.test.ts`

Commit command exited **0**. Post-commit `git status --short` showed only `?? ROOT_CAUSE_DEV665_part3.md`; `git ls-files --error-unmatch ROOT_CAUSE_DEV665_part3.md` exited **1**, confirming this note is untracked/uncommitted. Commit contains no Co-Authored-By trailer. No push or merge performed.
