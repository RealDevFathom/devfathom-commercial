# Restaurant growth handoff — WHA-1400

Base: `83899072f6f702d490f913faed86bf6430659437`.
Branch: `codex/restaurant-growth-20261007`. Owner: Restaurant reports engineer987.

## Architecture and bounded source delivery

`src/lib/restaurant/growth-evidence.ts` will expose `readRestaurantGrowthEvidence(h, input)`.
It authenticates the Restaurant vertical, current server-supplied modules and financial
capability, and one exact active authorized branch before calling the existing
`readFinancialComparison`. Input is strict `{branchId, from, to}` business dates;
comparison is the immediately preceding equal window, at most 45 days each.
No provider call, shared-file edit, promotion write, or schema change.
A server-only snapshot retains exact periods, scope, evidence hash, source links,
coverage and monetary definitions. Exact decimal-major to integer-minor conversion
occurs once. No raw reader rows, identity, tender details, or free text are projected.
Gateway forwarding remains disabled pending the frozen shared contract.

Tests: actual adapter entry point with reader and authenticated-helper doubles;
denials, malformed input, exact periods/units, missing/stale/partial/empty sources,
refund reconciliation, error redaction, hash/scope separation, zero mutations.

## Exact shared interface needs — WHA-1622 owner dee1

Freeze exports and supply accepted commit before binding the Restaurant adapter.
The read-only draft is reference material, not an accepted dependency.

- `settled_sales_minor`: Restaurant reports already compute gross minus comps,
  discounts AND processing-date refunds. Refund principal may include components
  not allocated by this reader; neither subtract again nor describe as profit.
- Need Restaurant gross-sales metric and explicit business-date period basis.
  `{from,cutoff}` midnight UTC represents stored business-date bounds, not a
  guaranteed instant-based receipt window or tenant-local timestamp conversion.
- Current server organization currency is not pinned historical currency.
  Currency changes cannot be silently treated as comparable historical amounts.
- `receipt_count` currently means distinct completed numbered customer-linked
  receipts. `readOverviewReport.orderCount` is orders, not that denominator.
  No valid customer cohort count comes from payments/comparison readers. Do not
  invent `cohortSize` or use tender/cover/order counts as distinct customers.
- Need an explicit unknown freshness/cohort representation or omission/refusal.
  Source observation time is not source freshness. Suppress cohorts below ten;
  absent qualifying cohort evidence must withhold gateway facts.
- Code-owned metric/action keys and bounded hypothesis/limitation tokens only.
  Server retains branch IDs, tenant IDs, source URLs, scope and evidence hash.

## Persistence/schema proposal for coordinator (not a migration)

No growth insight or Restaurant campaign draft models exist at this base.
`createPublishedOrderPercentagePromotion` creates published promotion versions:
never call it to create a review draft. PharmacyCampaign remains pharmacy-only.

Shared owner supplies append-only generic growth insight: tenant/vertical/branch,
actor, exact current/comparison period, evidence snapshot/hash, schema version,
provider/model, status/failure, bounded validated output, generation timestamp.
Coordinator composes Restaurant-only review and campaign draft relations:

- Composite tenant/branch/insight relationship; Restaurant vertical enforced.
- Append-only edits; one atomic final APPROVE or REJECT per recommendation.
- Approval inserts exactly one draft plus final decision in one transaction;
  unique `(organizationId, insightId, recommendationIndex)` prevents duplicates.
- Draft is inert: fixed server action, reviewed settings, review/insight lineage,
  actor/time; no published promotion/version, recipients, charge or dispatch.
- Reauthorize current tenant/branch/role/package on generation, readback, edit,
  rejection and approval; reject stale evidence/version/hash before finalization.
- Force tenant/branch RLS with no platform-admin bypass. Restricted-role DB tests
  must assert `NOT rolsuper AND NOT rolbypassrls` before cross-tenant assertions.

API composition proposal: `generate`, `read`, `edit`, `reject`, `approveToDraft`;
all server-owned scope, strict inputs, capability checks and scoped transaction.
Central router/schema changes belong to coordinator. Frozen persisted contracts
are required before shipping a functioning review UI or claiming persistence.

## Remaining composed acceptance

No appropriate Restaurant campaign dispatch/capture abstraction is established by
this handoff. Do not manufacture deliveries or use Pharmacy writers. Any future
path must enforce consent/STOP, caps, quiet hours, eligibility, idempotency and
unknown-no-resend. Synthetic capture must stay separate from live attribution,
link genuine posted synthetic receipts through cutoff, and label observational,
noncausal outcomes and unknown message costs.

Configured-model proof remains blocked on approved existing provider configuration;
no credentials/private env reads or external calls are authorized this run.
Browser, restricted-DB and full build remain not run (unreserved heavy slot).
Persistence/UI/sandbox acceptance awaits frozen shared exports and centrally
composed Restaurant storage. This component does not claim end-to-end completion.
