# HANDOFF — SehatCart develop QA pass + BA recommendations

Last updated: 2026-11-03 01:15 PKT (20:15 UTC)
Branch: `saad/great-brown-id2w5x` (base `develop` @ `47518cb`)
PR: [#1224](https://github.com/RealDevFathom/devfathom-commercial/pull/1224) into `develop` — docs/evidence/harness only, never merge from this session. Session is subscribed to PR activity.
Linear: no Linear issue is attached to this QA pass (see Open questions)

## Resume here

- **Single next action:** file the new findings as GitHub issues (per Saad 2026-11-03: labels `bug`, `qa`, `pharmacy`, `sevN-…` + `security`/`ux`/`ui`/`a11y` as relevant, **never `claude`**, do **not** fix; they sync to Linear and Codex fixes them). **Before filing, de-duplicate against issues #1225+**: a parallel Codex QA run filed #1227 (= finding 1), #1232 (= 30), #1233 (= 25, names part), #1234 (≈ 26, Settings Edit only), #1236 (= 29) at ~19:39 UTC. Linear-only: DEV-504 (= finding 28, Urdu foundation), DEV-498 item F14 (= finding 21; its proposed fix would block adding controlled items). Do not create duplicates; record the existing number instead. Then write every issue number into `qa-report.md` + this log and push.
  - `qa-report.md` is rewritten with the adversarial-verification corrections (32 findings: 6 Sev1 / 7 Sev2 / 15 Sev3 / 4 Sev4). Workflow `wf_7026951b-8f2`: 7 verify groups + duplicate hunt done; completeness critic (agent `a2d620bc0934d4493`) still running — read its result from the workflow `journal.jsonl` and apply anything real.
  - Testing is complete. Day 2026-11-02 was CLOSED by QA at 23:48 PKT (variance −4.00, deliberate).
  - Caveat: another tester (`QA-20261102-FUNC-*`, `QA-20261102-CASHCHECK-*`) is using the **same QA Cashier account** on this tenant.
- **Item:** QA pass (no DEV id). All test workstreams done; W9 (file issues) in progress.
- **Half-written / uncommitted:** nothing after this commit. Test bills still holding stock (no UI can release them, finding 2): ~60 u QA-B1 (3 reload-lost cashier bills, ids unknown), 10 u QA-AMX-1, 10 u QA-B4 (after-close bill), 20 u QA-B2 (pre-add preview probe ~00:58 PKT).

## Issues filed (W9) — report finding → GitHub issue

Filed so far (labels `bug`,`qa`,[`pharmacy`],`sevN-…`,[`security`/`ux`/`a11y`]; never `claude`; no fixes):
2 → #1242 · 3 → #1245 · 4 → #1241 · 6 → #1243 · 7 → #1244 · 8 (narrowed to Expiry board) → #1246 · 9 → #1248 · 10 → #1249 · 11 → #1250 · 12 → #1251 · 13 → #1252 · 14 → #1253

Still to file: 15, 16, 17, 18, 19, 20, 23, 24, 27, 31, 32.
Not filed (already tracked): 1 → #1227 · 5 → #1227 + closed #509 · 21 → Linear DEV-498 (F14) · 22 → DEV-498 (F11) / #1239 · 25 → #1233 (+ #1081/#1092 contrast) · 26 → #1234 · 28 → Linear DEV-504 · 29 → #1236 · 30 → #1232.
Comments planned (add evidence that changes the fix): #1227 (capability half + onboarding gap), #1234 (all `text-primary` in dark, token-level fix), DEV-498 (F14 fix would block adding controlled items; F11 desktop clipping), DEV-504 (unused workspace Locale, Urdu receipt details). Then: fix the "finding 3" text in #1249 to "#1245".

## PR #1224 review status

| Check | Verdict | Notes |
|---|---|---|
| Machine checks (CI) | none configured | 0 check runs on the PR head; repo workflows only deploy. `mergeable_state: clean`. No Claude Approvals check in this repo. |
| Codex code review (`dd6cf1d`) | 2 × P2 → fixed | (1) dark sweeps only set `prefers-color-scheme`; the app reads `localStorage['theme']`, so the "dark" sweep rendered light → `roleContext` now stores the app theme and sweeps record `data-theme`. (2) `print-receipt.mjs` wrote HTML to a hard-coded path → now `path.join(EVIDENCE, …)`. Threads replied to and resolved. |
| Codex security review (`dd6cf1d`) | completed, no findings | — |
| QA re-check after fix | done | Genuine dark pass: 34/34 pages `data-theme=dark`, no errors/overflow. New dark finding (report #26). Adversarial verification applied to `qa-report.md` (one finding withdrawn, three added from live follow-ups). |

## Workstreams (items)

| # | Item | Status | Done so far | Exact next step |
|---|------|--------|-------------|-----------------|
| W1 | Recon + GitHub issue index | done | 573 issues indexed (`gh api search/issues`), permission model + role templates mapped (`src/lib/vertical-catalog.ts:764-826`) | — |
| W2 | Harness (per-role sessions, tRPC caller, UI step runner, page sweep) | done | `qa/sehatcart-2026-11-02/harness/*.mjs`; desktop sweep 46 routes × 4 roles | — |
| W3 | RBAC UI + API denial matrix | done | Live: #1010/#507, #1012, #1016, #1036, #412, #517, #509(closed→reproduces) confirmed; new N4, N15, N17. Static audit: `rbac-static.tsv` (350 procs) | — |
| W4 | Functional E2E (purchasing → goods-in → counter → returns → Rx → day close → reports) | done | PO/GRN/post via UI+API, cash sale + receipt print (EN/UR), return + refund, Rx gate, day-close preview; command-centre sales reconciled to 5 receipts (PKR 505.98) | Report accuracy (above) → day close + lock-after-close test (owner; do last, it locks the business day for everyone) → stock count/transfer/write-off/recall/opening-stock CSV import |
| W5 | AI (Ask Fathom + growth) | done (blocked live) | Ask Fathom 503 (no `AI_PROVIDER` on develop, #1199/#1159) → accuracy/injection/Urdu **not testable live**; tool authz reviewed in code (`src/lib/ai/tools/pharmacy-reports.ts`); growth insights UNAVAILABLE; basket needs completed days | Write up; optional: deterministic replenishment report check (`pharmacyReports.replenishment`) |
| W6 | UI/UX/a11y sweep (375/768/1440, dark, Urdu RTL, keyboard, axe) | done | Desktop/tablet/phone sweeps done (no doc overflow; #1032/#1069 reproduce); axe done (N25); no app Urdu (N24); dark sweep running | `ROUTES="..." node qa/sehatcart-2026-11-02/harness/sweep.mjs tablet 768 1024 light`, then `phone 375 812`, `desk-dark 1440 900 dark`; Urdu switch via Settings; axe via `@axe-core/playwright` |
| W7 | Security + data integrity probes | done | XSS pass; CSV pass (Sev4 gap); throttle N19; logout-not-revoked N20; concurrency pass; #521/#636 fixed; offline N21 | Optional: cross-tenant host probe (needs another tenant host) |
| W8 | Write `qa-report.md` + `ba-recommendations.md` | done | After verification: 32 new findings (6 Sev1/7 Sev2/15 Sev3/4 Sev4), 23 re-verified, go/no-go = NO-GO; 39 BA recommendations (24 P1, 14 P2, 1 P3) + top 10 | — |
| W9 | File new findings as GitHub issues (no `claude` label, no fixes) | in progress | Duplicate hunt done (see Resume here) | De-dup vs #1225+, then `issue_write create` per finding |

## Environment / test data (no passwords here — creds live only in a local, uncommitted file)

- Tenant: `https://sehatcart.pharmacy.develop.devfathom.com`, org `cmvx5fc310002y5qrvcbv98h9`, single branch `MAIN` `cmvx5fc4p000cy5qrcgzjrc3b` (Lahore). Workspace is **not activated** (onboarding 7/12).
- Accounts: qa.owner (ADMIN, role "Owner / Operator"), qa.cashier (Cashier), qa.manager (Procurement), qa.pharmacist (Pharmacist + `pharmacy:safety` override).
- Setup change made by QA: owner assigned **QA Cashier + QA Pharmacist to branch MAIN** at ~23:20 PKT (before that, nobody had a branch assignment and cashier sales could not be paid — finding N4).
- Medicines: QA Panadol `cmvxpws13002v1xqrfsg4p4hz` (STRIP pack `cmvxpy8hn003t1xqr9az7aste`; duplicate pack `cmvzkrtdx01aw4oqrwe45y3zt` created by QA → N1). Rx test item QA Amoxicillin 500mg `cmvzld6dm01uc4oqrs4vn5m0a` (pack `cmvzld6hf01ui4oqrzi7bnemw`, batch QA-AMX-1, 200 u, MRP 300.00/strip).
- Batches of Panadol: QA-B1 (MRP 25.00, exp 2027-06, mostly locked in abandoned bills), QA-B2 (MRP 28.00, exp 2027-01, ~280 u), QA-B3 (MRP 30.00, exp 2028-03, 300 u).
- Supplier created by cashier (RBAC probe): `QA-RBAC-mvzktau8 supplier` `cmvzktbce01cs4oqrsxjjoswy`.
- **60 units of QA-B1 are still locked in 3 abandoned open bills** (created by QA Cashier ~23:15–23:22 PKT via UI; ids unknown, no UI can list/void them — finding N8).
- Counter drawers are per browser device id (localStorage). Harness persists cashier/pharmacist localStorage with `PERSIST=1`.
- AI: `AI_PROVIDER` not set on develop → Ask Fathom 503, growth insights UNAVAILABLE.

## Commands (checks)

This branch changes **no production code**, so typecheck/lint/unit/build were not run (not applicable). QA checks:

```bash
# one-time: create the creds file OUTSIDE the repo and point QA_CREDS at it
export QA_CREDS=/path/outside/repo/creds.json QA_SCRATCH=/tmp/qa-scratch QA_REPO=$(pwd)
node qa/sehatcart-2026-11-02/harness/login-all.mjs          # latest: 4/4 roles OK (~0.8–0.9 s each)
node qa/sehatcart-2026-11-02/harness/rbac-purch.mjs         # latest: cashier supplier→licence→authorise→PO 200; pharmacist approve 200 (BUG #1010)
node qa/sehatcart-2026-11-02/harness/rbac-sale.mjs          # latest: manager/pharmacist/cashier create+addLine 200, cart 403 (N4)
node qa/sehatcart-2026-11-02/harness/rbac2.mjs              # latest: drawer/patient/PV by Procurement 200; exportPatient unmasked (N15); PV create 500 (N16)
node qa/sehatcart-2026-11-02/harness/reports1.mjs           # latest: commandCentre 200 owner; expiryAdvice 500 (#1042)
node qa/sehatcart-2026-11-02/harness/ask.mjs owner "question" # latest: 503 (AI disabled)
node qa/sehatcart-2026-11-02/harness/sweep.mjs desk 1440 900 light   # latest: 184 pages, React #418 on /pharmacy/orders
gh api -X GET search/issues -f q='repo:RealDevFathom/devfathom-commercial is:issue' -f per_page=100 --paginate --jq '.items[] | [.number, .state, (.labels|map(.name)|join(",")), .title] | @tsv' > issues.tsv
```

Known failures: all failures above are product findings on the deployed develop build (not test-harness failures). Harness caveat: each run uses a fresh browser profile unless `PERSIST=1` (new counter device ⇒ `DRAWER_NOT_OPEN`).

## Open questions / decisions

1. **Push policy.** Original brief said "do not push"; at 23:3x PKT the user asked for this HANDOFF.md to be committed and pushed. Decision: push only docs, evidence screenshots and the QA harness (no production code, no session cookies, no credentials).
2. **PR.** Repository workflow requires a PR for a pushed branch → PR into `develop`, docs-only, not to be merged by this session.
3. **Linear.** No Linear issue exists for this QA pass, so there is nowhere to post status comments yet. Asked the user whether to create one or comment on an existing DEV issue.
4. **Concurrent tester** on the same tenant and the same QA Cashier account (`QA-20261102-FUNC-*`). Their activity is mixed into drawers, receipts and report totals.
5. **Day close** locks the business day for everyone on the branch → run it last.
6. Severity rule used: Sev1 = security, data loss, money wrong, blocks selling; existing issues are re-verified and linked, not re-filed.
