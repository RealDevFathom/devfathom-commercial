# HANDOFF — SehatCart develop QA pass + BA recommendations

Last updated: 2026-11-03 05:01 PKT (00:01 UTC)
Branch: `saad/great-brown-id2w5x` (base `develop` @ `47518cb`)
PR: [#1224](https://github.com/RealDevFathom/devfathom-commercial/pull/1224) into `develop` — docs/evidence/harness only, never merge from this session. Session is subscribed to PR activity.
Linear: no Linear issue is attached to this QA pass (see Open questions)

## Resume here

- **Single next action:** none required. All QA, BA and issue-filing work is done. PR #1224 (docs only) has Machine/QA/Security PASS from a review session (2026-11-02 23:16 UTC) and waits for a human merge decision. Before any push, run `node_modules/.bin/prettier --check` on the changed files: the QA gate runs Prettier on changed files. If anything comes back, handle it per the PR subscription rules. Do **not** start fixing the filed issues: per Saad (2026-11-03), Codex fixes them.
  - Testing is complete. Day 2026-11-02 was CLOSED by QA at 23:48 PKT (variance −4.00, deliberate).
  - Caveat: another tester (`QA-20261102-FUNC-*`, `QA-20261102-CASHCHECK-*`) is using the **same QA Cashier account** on this tenant.
- **Item:** QA pass (no DEV id). W1–W9 done.
- **Half-written / uncommitted:** nothing after this commit. Test bills still holding stock (no UI can release them, #1242): 60 u QA-B1 (3 reload-lost UI bills, ids unknown), 20 u QA-B2 (pre-add preview probe ~00:58 PKT), 10 u QA-B4 (after-close bill), 10 u QA-AMX-1 (Rx test bill). Three API drawers `qa-verify-mvzny1qg-*` are still open (one dated 2026-11-05).

## Issues filed (W9) — report finding → issue

Filed 2026-11-03 01:15–01:30 PKT with labels `bug`, `qa`, severity (`sev1-critical`…`sev4-trivial`) plus `pharmacy`/`security`/`ux`/`a11y` where relevant. **No `claude` label, no assignees, no fixes.**

| Finding                                 | Issue | Finding                               | Issue |
| --------------------------------------- | ----- | ------------------------------------- | ----- |
| 2 Sev1 reload-lost bills leak stock     | #1242 | 15 Sev3 refused payment locks counter | #1254 |
| 3 Sev1 no prescriber/patient creation   | #1245 | 16 Sev3 change disappears             | #1255 |
| 4 Sev1 pharmacist can't tender          | #1241 | 17 Sev3 receipt text/identity         | #1256 |
| 6 Sev1 exportPatient unmasked           | #1243 | 18 Sev3 receipt numbers per device    | #1257 |
| 7 Sev2 pharmacovigilance 500            | #1244 | 19 Sev3 returns "1 BOX"               | #1258 |
| 8 Sev2 Expiry board cost exposure       | #1246 | 20 Sev3 duplicate pack sizes          | #1259 |
| 9 Sev2 write-off witness                | #1248 | 23 Sev3 login throttle message        | #1260 |
| 10 Sev2 Rx without prescription (API)   | #1249 | 24 Sev3 no offline indicator          | #1261 |
| 11 Sev2 client business date            | #1250 | 27 Sev3 opening import cost basis     | #1262 |
| 12 Sev2 day close blocks until midnight | #1251 | 31 Sev4 category growth undercount    | #1263 |
| 13 Sev2 sign-out doesn't revoke         | #1252 | 32 Sev4 no H1 / day-close aria        | #1264 |
| 14 Sev3 keyboard search                 | #1253 |                                       |       |

Not filed because already tracked (no duplicates created):

- 1 → #1227 and 5 → #1227 + closed #509: **comment added** (capability half, onboarding gap, evidence).
- 21 → Linear DEV-498 F14 and 22 → DEV-498 F11 / #1239: **comment added** (F14's proposed fix would block adding controlled items; desktop clipping details).
- 25 → #1233 (names; contrast is #1081/#1092). 26 → #1234: **comment added** (all `text-primary` in dark, token-level fix).
- 28 → Linear DEV-504: **comment added** (unused workspace Locale, Urdu receipt details). 29 → #1236. 30 → #1232.

Corrections after the completeness critic (`wf_7026951b-8f2`, agent `a2d620bc0934d4493`): issue bodies #1242, #1243, #1245, #1251, #1254, #1259, #1264 were edited to cite saved evidence only; UI observations that existed only in run output are now saved verbatim in `qa/sehatcart-2026-11-02/api-evidence/ui-run-log-excerpts.md` (commit `7dbce5d`). `qa-report.md` carries the same corrections and every issue number.

## PR #1224 review status

| Check                                            | Verdict                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine checks (review session)                  | PASS on `d34637b`      | The first run, on `1f73675`, failed Prettier (95 of 98 new md/json/mjs files unformatted). The review session pushed `d34637b`, which only applies Prettier; verified here that all 61 JSON evidence files hold identical data and every harness script parses. Re-run on `d34637b`: deps OK, typecheck no new errors (4 already on develop), ESLint 0 errors, Prettier clean, no related tests, `next build` passed. GitHub itself shows 0 check runs; `mergeable_state: clean`; no Claude Approvals check.                                                                                                                                                                                               |
| Codex code review (`dd6cf1d`)                    | 2 × P2 → fixed         | (1) dark sweeps only set `prefers-color-scheme`; the app reads `localStorage['theme']`, so the "dark" sweep rendered light → `roleContext` now stores the app theme and sweeps record `data-theme`. (2) `print-receipt.mjs` wrote HTML to a hard-coded path → now `path.join(EVIDENCE, …)`. Threads replied to and resolved.                                                                                                                                                                                                                                                                                                                                                                               |
| Codex security review (`dd6cf1d`)                | completed, no findings | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| QA re-check after fix                            | done                   | Genuine dark pass: 34/34 pages `data-theme=dark`, no errors/overflow. New dark finding (report #26). Adversarial verification applied to `qa-report.md` (one finding withdrawn, three added from live follow-ups).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| QA review (review session, 2026-11-02 23:16 UTC) | PASS                   | Non-blocking notes for the owner: (1) root `HANDOFF.md` collides with #1223's — kept at the root because the user asked for it there; rename on merge if #1223 lands first. (2) Harness defaults pointed at this session's paths — fixed in the commit after `d34637b` (repo root derived from the script location, scratch in the OS temp dir). (3) `probe1.json` held the tenant owner's real email — redacted in `probe1.json` and `sweep-desk-results.json` in the same commit; earlier commits still contain it (no history rewrite; a squash merge keeps it out of `develop`). (4) About 10.9 MB of evidence sits in `qa/` and `qa-evidence/` rather than `docs/qa/` — left for the owner to decide. |
| Security review (review session)                 | PASS                   | No credentials, tokens, cookies, JWTs or keys in the 50 text files; screenshots spot-checked; the only phone number is synthetic; receipt HTML is static.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Workstreams (items)

| #   | Item                                                                                  | Status              | Done so far                                                                                                                                                                                                                               | Exact next step                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Recon + GitHub issue index                                                            | done                | 573 issues indexed (`gh api search/issues`), permission model + role templates mapped (`src/lib/vertical-catalog.ts:764-826`)                                                                                                             | —                                                                                                                                                                                              |
| W2  | Harness (per-role sessions, tRPC caller, UI step runner, page sweep)                  | done                | `qa/sehatcart-2026-11-02/harness/*.mjs`; desktop sweep 46 routes × 4 roles                                                                                                                                                                | —                                                                                                                                                                                              |
| W3  | RBAC UI + API denial matrix                                                           | done                | Live: #1010/#507, #1012, #1016, #1036, #412, #517, #509(closed→reproduces) confirmed; new N4, N15, N17. Static audit: `rbac-static.tsv` (350 procs)                                                                                       | —                                                                                                                                                                                              |
| W4  | Functional E2E (purchasing → goods-in → counter → returns → Rx → day close → reports) | done                | PO/GRN/post via UI+API, cash sale + receipt print (EN/UR), return + refund, Rx gate, day-close preview; command-centre sales reconciled to 5 receipts (PKR 505.98)                                                                        | Report accuracy (above) → day close + lock-after-close test (owner; do last, it locks the business day for everyone) → stock count/transfer/write-off/recall/opening-stock CSV import          |
| W5  | AI (Ask Fathom + growth)                                                              | done (blocked live) | Ask Fathom 503 (no `AI_PROVIDER` on develop, #1199/#1159) → accuracy/injection/Urdu **not testable live**; tool authz reviewed in code (`src/lib/ai/tools/pharmacy-reports.ts`); growth insights UNAVAILABLE; basket needs completed days | Write up; optional: deterministic replenishment report check (`pharmacyReports.replenishment`)                                                                                                 |
| W6  | UI/UX/a11y sweep (375/768/1440, dark, Urdu RTL, keyboard, axe)                        | done                | Desktop/tablet/phone sweeps done (no doc overflow; #1032/#1069 reproduce); axe done (N25); no app Urdu (N24); dark sweep running                                                                                                          | `ROUTES="..." node qa/sehatcart-2026-11-02/harness/sweep.mjs tablet 768 1024 light`, then `phone 375 812`, `desk-dark 1440 900 dark`; Urdu switch via Settings; axe via `@axe-core/playwright` |
| W7  | Security + data integrity probes                                                      | done                | XSS pass; CSV pass (Sev4 gap); throttle N19; logout-not-revoked N20; concurrency pass; #521/#636 fixed; offline N21                                                                                                                       | Optional: cross-tenant host probe (needs another tenant host)                                                                                                                                  |
| W8  | Write `qa-report.md` + `ba-recommendations.md`                                        | done                | After verification: 32 new findings (6 Sev1/7 Sev2/15 Sev3/4 Sev4), 23 re-verified, go/no-go = NO-GO; 39 BA recommendations (24 P1, 14 P2, 1 P3) + top 10                                                                                 | —                                                                                                                                                                                              |
| W9  | File new findings as GitHub issues (no `claude` label, no fixes)                      | done                | 23 issues #1241–#1264; 9 already tracked (see table above); 4 evidence comments                                                                                                                                                           | —                                                                                                                                                                                              |

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
# Defaults: QA_REPO = the checkout that contains the harness; QA_SCRATCH = <OS temp dir>/qa-sehatcart-2026-11-02;
# QA_CREDS = $QA_SCRATCH/secrets/creds.json; QA_EVIDENCE = $QA_REPO/qa-evidence.
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
