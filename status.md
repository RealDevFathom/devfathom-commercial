# DevFathom delivery status

Last reconciled: 2026-09-02 03:15 PKT — leadership is back with Claude (Cowork supervisor);
Codex is paused. Restaurant is being finished from the candidate below, gates in order.

Work was stopped by Codex for the handoff and resumed under Claude. Restaurant is **not yet release-complete**: the
accepted local implementation candidate exists, but the clean full automated gate, complete browser
E2E, documentation reconciliation, authorized integration, deployment, and production smoke remain.

## Authoritative checkpoint

| Item | Exact state |
| --- | --- |
| Canonical private candidate | `6cd73e4b5eb747b1d017d28ce6858d6606a7c6f9` |
| Candidate parent | `93f8a9316d5c6934c20dd6078ba40e1413147017` |
| Candidate worktree | `/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1116-compose-the-final-accepted-restaurant-artifacts-into-one-clean-private-candidate` |
| Candidate working tree | Clean after the commit that carries this status and the manifest truth fix; that commit's SHA (branch tip) is the one exact final SHA for WHA-1125 and WHA-1100 |
| Local preview | Tenant and SuperAdmin health return 200 on port 3105, but the running preview is from older `c7f15f65`, so it is not final-candidate proof |
| Paperclip execution | Paused; no live run should be resumed without reconciling it to this candidate and the contracts below |
| Remote/release state | Nothing from this candidate was pushed, merged, deployed, or production-smoked |

## What is implemented in the candidate

The assembled source covers Restaurant onboarding; staff, roles, branches, and devices; catalog,
menu, pricing, modifiers, and OCR import; POS, dine-in/takeaway/direct delivery, tables, KDS, orders,
discounts, complimentary items, payments, split bills, refunds, voids, drawers, and daily closing;
Pakistan tax and custom tax profiles; recipes/BOM, ingredients, stock, wastage, suppliers, purchasing,
and alerts; shifts/workforce; SOP library, schedules, evidence, verification, escalation, scores, and
audit; customers/loyalty; dashboard, finance, reports, analytics, and multi-branch foundations.

Important product boundaries:

- Printing has durable jobs, routing, idempotency, and ESC/POS rendering, but only a simulation
  adapter. No physical, network, or OS printer I/O has been accepted.
- Direct connected Delivery includes publications, addresses, zones, frozen snapshots, PREPAID/COD
  kitchen handoff, settlement, close, Reports, and Insights. Marketplace providers and full driver
  logistics are deferred.
- Offline POS supports the accepted local new-order capture/replay design; final integrated browser
  proof is still required.
- OPay New 9220 is only a candidate card terminal. No provider documentation, credentials,
  authorization, reconciliation, or hardware acceptance has been completed.
- Pakistan tax calculation/configuration exists. Fiscal filing, fiscal-device certification,
  authority e-invoicing, and legal/accounting approval remain external.

## Accepted evidence

- WHA-1108 final-controls artifact `fc2841e5c6dd08d184f9e091f145b0ca912f7198`
  (parent `958575ba`): focused Vitest **63 passed**; final-controls browser acceptance **5/5**.
  One separately opt-in restoration test was skipped in that focused run.
- WHA-1116 composition `6cd73e4b5eb747b1d017d28ce6858d6606a7c6f9`: exact ten-file
  composition; focused Vitest **4 files / 81 passed**; correction rerun **11/11**; changed-file
  ESLint and Prettier passed; 8 GiB `tsc --noEmit` passed; worktree was clean.
- WHA-1129 static completion audit found no remaining repository-resolvable runtime development
  blocker. It made no changes and did not substitute for database, build, or browser QA.

The stale claims in `tests/e2e/restaurant-acceptance-manifest.ts` (friendly selectors as WHA-300,
offline order capture as under correction, golden-byte printing as WHA-228, and closed lanes
WHA-228/282/286/297/298/299/300 listed as active — all `done` in Paperclip, artifacts present in the
candidate; only WHA-281 remains open) are corrected in the commit that carries this status.
`validateRestaurantAcceptanceManifest()` reports no violations; Prettier passes.

## QA evidence that must not be treated as a green gate

Two full-suite attempts were cancelled and are invalid release evidence:

1. Run `35936265-a174-4546-a4b7-a3a94cda8f5d` omitted the Delivery owner mapping. It reported
   332 passed files, 1 failed file, 1 skipped file, 4,028 passed tests, and 7 skipped tests, then
   attempted an invalid runtime `CREATEROLE` shortcut. Discard this result.
2. Run `00fc8773-bdd6-4673-ac34-ac2abc015e19` ignored the corrected serialized/JSON contract and
   ran plain parallel `bun run test`; it also omitted Delivery owner mapping and the restoration
   opt-in. It reported 331 passed files, 2 failed files, 1 skipped file, 4,027 passed tests,
   1 failed test, and 7 skipped tests. Discard this result.

Useful but partial setup evidence from the second attempt: **56 migrations** applied; the restricted
runtime role was login-only with superuser, bypass-RLS, create-database, create-role, and inherit all
false; the required database subset passed **19 suites / 180 tests** in 2.93 seconds. This does not
complete the release gate.

## Paperclip state at stop

| Issue | State at handoff |
| --- | --- |
| WHA-1116 — compose final candidate | Done at `6cd73e4b…` |
| WHA-1129 — source/delta completion audit | Done; no code blocker found |
| WHA-1130 — documentation pass | Blocked and unassigned. Automatic recovery created private docs commit `5f371718428bc088b3b00c4c40a2f155f50b781c` on stale base `c7f15f65` before cancellation. Preserve it for selective review only; do not merge or cherry-pick it blindly. This canonical `status.md` supersedes its root ledger. |
| WHA-1125 — final automated release gate | Blocked and unassigned pending one exact final SHA |
| WHA-1100 — final browser gate | Blocked and unassigned; starts only after WHA-1125 is green on the same SHA |

The recurring ten-minute completion watcher is paused. The cancelled QA PostgreSQL instance on port
55587 was stopped. The older local tenant/SuperAdmin preview on port 3105 was deliberately left
running for inspection.

## Required continuation order

1. Done: this status and the acceptance-manifest truth fix are committed on top of `6cd73e4b…`;
   the branch tip is the one exact final SHA. Do not reuse stale or cancelled worktrees/runs.
2. Run WHA-1125 on a fresh PostgreSQL 16 database. Apply all 56 migrations and use separate owner
   and restricted-runtime mappings for every required suite, including Delivery. Run Vitest
   serialized with JSON evidence and the restoration opt-in. Require zero failures and zero skipped
   required tests; then run lint, typecheck, production build, and the Linux/amd64 image gate.
   Never grant `CREATEROLE` to the restricted runtime and never replace this with plain parallel
   `bun run test`.
3. Only after WHA-1125 is fully green, run WHA-1100 against the **same SHA** and a fresh seeded DB:
   Restaurant **15**, SuperAdmin **7**, and Agency regression **8** browser scenarios, all passing
   with zero skips. Cover the complete onboarding-to-close flow, role/tenant boundaries, responsive
   and keyboard behavior, and the final docs against the real UI.
4. Reconcile admin/operator documentation and this status against proven behavior. Record exact
   commands, SHA, database role flags, test counts, build/image result, browser evidence, and any
   external limitations.
5. Ask Saad for explicit authorization before any push, shared-ref merge, deployment, or production
   smoke. A healthy local preview or Paperclip Done count is not release proof.

## External inputs code work cannot close alone

- Card/online acquiring provider contract, OPay New 9220 documentation and credentials, test
  merchant account, device protocol, settlement, refunds, and physical acceptance.
- Physical printer, drawer, KDS, and camera hardware acceptance.
- Notification provider credentials and deliverability acceptance.
- Restaurant-authored SOP content, tax/rate/effective-date choices, loyalty and inventory operating
  policy, retention policy, and legal/accountant approval.

## Optional or deferred scope

Marketplace APIs, live rider tracking, route optimization, native mobile, reservations/waitlist,
stored value, payroll execution, tip payout, production batches, and full driver logistics remain
optional or deferred unless explicitly approved.

Detailed decisions and module-level scope remain in the
[Restaurant management system plan](industry-specific-docs/restaurants/restaurant-management-system-plan.md).
