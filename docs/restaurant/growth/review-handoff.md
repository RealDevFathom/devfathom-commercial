# Restaurant persisted review candidate — WHA-1400

Parent: `c42551d84366e448dd4e4a2c0e5a395ee2277ea5`; original base
`83899072f6f702d490f913faed86bf6430659437`. Same owner and branch.

## Implemented independently

- `growth-review.ts`: scoped persisted insight reads and serialized append-only
  EDIT/REJECT/APPROVE commands, revision concurrency, actor-bound idempotency,
  strict metadata/version/scope checks, current-evidence gate, and atomic inert
  draft creation. Current tenant, Restaurant vertical, active branch, Core/POS,
  financial permission and write configure permission are required. Catering
  also requires `catering:read`. No generation/provider/publishing/delivery call.
- `growth-review-contract.ts`: strict request/settings and bounded Restaurant
  review presentation. Priority NORMAL/HIGH is editable; action/objective remain
  server owned. Maximum 100 revisions, three recommendations. No free-form copy,
  recipients, prices, schedules or budget accepted. No export surface added.
- `restaurant-growth.ts`: audited protected router factory (`read`, `review`),
  outside the central root. Shared module mapping untouched; explicit module
  checks remain at the service boundary.
- `/restaurant/growth?branch=<id>&insight=<id>`: real server-action route using
  that router, fresh authenticated context per call. Empty, denied, unavailable,
  insufficient, invalid, stale, loading, review/confirmation, final, and unknown
  response states. Unknown write responses retain exactly the same request UUID
  for reconciliation. Reuses PageHeader, SectionCard, Button, StatusPill and
  semantic Studio tokens. Financial source links preserve branch and both exact
  business-date periods. The source-workspace action is distinct from evidence.
- `review-storage.sql`: proposed Restaurant-only SQL fragment, not installed.
  Composite branch/insight/review/draft references; unique final decision;
  sequential revisions; append-only triggers; deferred approval/draft pairing;
  draft action linked to saved insight action ref; exact tenant AND branch RLS,
  including missing-branch denial and no platform bypass. No shared table changed.

## Provisional dependency and exact coordinator binding

Read-only compatibility reference:
`/tmp/devfathom-pharmacy-marketing-recovery/prisma/migrations/20261006160000_growth_insights/migration.sql`.
It defines `growth_insights`: id, organizationId, branchId, vertical, actorId,
schemaVersion, inputHash, status, failureCode, provider, model, snapshot, output,
createdAt; composite `(organizationId,branchId,id)`. Source remains unfinished,
**provisional**, neither copied nor accepted by this delivery.

`createRestaurantGrowthRouter(binding)` takes a server-owned
`RestaurantGrowthBinding`. Default is null: saved READY becomes UNAVAILABLE,
never fabricated readiness. Coordinator replaces the default with the accepted
binding and composes the SQL centrally. Independent write implementation and UI
are complete source candidates; actual persisted READY review awaits this binding.

Binding requirements (not caller supplied):

1. `validatePersisted(snapshot, output)` must call the accepted shared input/output
   validators, enforce Restaurant vertical, code-owned action/evidence refs,
   hypothesis/action compatibility, cohort suppression >=10 and genuine freshness,
   and project only the supported Restaurant presentation fields. Reject unsupported
   metrics/actions. Never reinterpret a Pharmacy result. Do not use retrieval time
   as freshness. Preserve currency, integer minor units, current/comparison period,
   real count denominators and coverage. No output narrative crosses this UI seam.
2. `evidenceIsCurrent(db, scope, inputHash, snapshot)` must verify canonical shared
   input hash AND scope-bound private evidence lineage against current authorized
   readers. Its true result certifies versioned period, currency and source evidence
   remain reviewable. It must not treat matching client hash or elapsed age alone
   as freshness. Current evidence adapter intentionally withholds gateway facts
   until genuine cohort/freshness support exists. No default true implementation.
3. Freeze shared exports and an accepted SHA before integration. Keep generic
   growth storage/provider/generator and central root/schema under their owners.
   This source accepts only Restaurant business-date midnight bounds (45 days
   each, adjacent equal windows), USD/PKR and integer minor units/counts.

Parent relay remains: shared owner must support gross sales; explicit business-date
rather than receipt-instant semantics; refunds already deducted in Restaurant net;
real cohort denominator and explicit unknown freshness. No generic timestamp or
cohort fabrication. `c42551d8` evidence behavior remains unchanged.

## Minimal sandbox adapter proposal — not implemented or claimed

Existing `customers.ts` provides `appendCustomerConsent`, strict consent replay
matching, and current consent ordered by occurredAt/createdAt/id. A withdrawn grant
must supersede prior consent. `notifications.ts:deliverNotificationRequest` is a
STAFF-recipient mechanism; non-IN_APP delivery is STUBBED. It cannot represent
customer marketing capture. The inspected Restaurant webhook inbox has no customer
STOP normalization/capture lineage contract. No Pharmacy adapter is reused.

Small missing adapter, for coordinator admission: a test-only
`captureRestaurantGrowthDraft(db, {draftId, requestId, cutoff})` behind an explicit
reserved disposable DB identity/loopback guard, current tenant/branch/capability,
server-owned synthetic recipient selection, current customer consent and normalized
STOP denial, eligibility, per-recipient/campaign caps and branch quiet hours. Resolve
all recipients server-side; never accept contact details or create a live send.
Capture identity binds draft + reviewed revision + cohort policy + cutoff. Persist
capture/attempt/event lineage once; timeout or unknown outcome prohibits resend;
reconcile the same attempt. Current consent rechecked immediately before capture.
No tests claim these missing delivery behaviors are implemented.

Diagnostic result contract: `{environment: TEST_SANDBOX, observational: true,
messageCost: null, cutoff, captureId, evidenceReceiptIds, settledSalesMinor,
postedMarginMinor: string|null, exclusions}`. Only genuine posted synthetic
Restaurant receipts with exact branch/customer/capture lineage through cutoff may
contribute. Use existing authoritative receipt/Finance readers; no inferred order,
quote, tender, delivery or conversion denominator. Report unknown margin when no
posted cost reader exists. Conflicting/unknown attempt evidence excluded. Keep
sandbox diagnostic outcomes separate from live attribution; no causal ROI.
No appropriate existing customer capture adapter was found, so this narrow proposal
is the remaining action; persistence/review source work proceeded independently.

## Runnable acceptance (slot required; not run)

- Restricted DB: compose accepted generic storage followed by `review-storage.sql`
  into a disposable loopback DB. Supply `RESTAURANT_GROWTH_DB_ADMITTED=1` and
  `RESTAURANT_GROWTH_TEST_DATABASE_URL`, then
  `node node_modules/vitest/vitest.mjs run src/lib/restaurant/growth-review.db.test.ts --no-cache`.
  Five cases: every fixture first asserts current role is neither superuser nor
  BYPASSRLS; RLS cross-tenant/branch/missing branch; foreign insert; immutable review;
  missing draft rollback constraint; matching inert draft/duplicate final decision.
  Synthetic rows use TEST_DOUBLE provider/model labels, not model evidence. All
  fixtures roll back. Concurrency race/committed rollback proof still needs the
  composed integration harness; unit mocks do not prove PostgreSQL atomicity.
- Browser: existing running synthetic app and authenticated test storage state;
  `RESTAURANT_GROWTH_BROWSER_ADMITTED=1`, `RESTAURANT_GROWTH_BROWSER_URL` (loopback),
  `RESTAURANT_GROWTH_BROWSER_STATE`. Run
  `node node_modules/@playwright/test/cli.js test --config tests/e2e/restaurant-growth.config.ts`.
  Four viewport empty-state checks. Fifth case requires a new persisted READY fixture
  and accepted binding, selected by `RESTAURANT_GROWTH_BROWSER_BRANCH`/`_INSIGHT`;
  exercises edit/confirm/approve/reload. No intercepted server results. Starts no
  listener. This is not full Studio theme/motion/keyboard/visual acceptance.

## Limits and review path

Local-board/coordinator reviews this bounded candidate, accepts shared binding and
composes schema, then reserves DB/browser/build admission. No heavy gate/listener,
real configured-model call, credential setup, live data, delivery or deployment.
Configured-model prerequisite remains approved existing configuration plus an actual
model receipt, owned by shared provider lane. Candidate is not end-to-end accepted.
Rollback before integration: omit this additive commit. SQL has never been applied.
