# Printer soft-retirement policy and backend admission

Status: backend implementation added; source validation does not enable deployment.
Source baseline: `78f9d68a514e90b1c21989b155e4e683e52317e4`.

## Meaning and preservation

Retirement ends a registered inventory record's eligibility for new registered routing and
new registered print jobs. It does not prove the printer is disconnected, stop a physical
queue, prohibit a raw transport address, revoke a bridge or reconcile delivery.

Persist a nullable, server-written `RestaurantPrinter.retiredAt` timestamp. Null means the
record is not retired; a timestamp means retired. Keep ONLINE/OFFLINE as observed health.
Registration still defaults to OFFLINE and creates an unretired record. Never use telemetry,
an error string, bridge revocation or a renamed label as the retirement flag.

Preserve the inventory row, IDs, organization/branch/bridge relationships, name, address,
connection kind, width, telemetry and creation timestamp. Only `retiredAt` and the normal
update timestamp may change. Preserve every route, job, stored document/width, attempt,
claim, acknowledgement, idempotency key and credential. No cascade, backfill or physical
retry belongs to retirement. Retired records remain visible in authorized inventory lists.

Retirement is one-way in this slice. Repeated authorized requests for the same already
retired record return its original retirement timestamp and `changed: false`; they do not
write a new timestamp. Restoration, reassignment and transport edits require separate work.

## Authorization and transition

Use the existing audited `devices:manage` procedure and current staff branch authorization.
Recheck the tenant-scoped active branch inside the write transaction, then lock the exact
printer in that branch. A printer in another organization or branch is not a valid target.
An inactive or revoked owning bridge does not block inventory retirement. Retirement must
not activate, rotate, revoke or issue credentials for that bridge.

For an unretired target, refuse the transition if either condition exists in the same
organization and branch:

1. Any route has the target's `registeredPrinterId`, including a disabled route.
2. Any job has the target's `registeredPrinterId` and a status other than PRINTED.

The second condition includes fresh PENDING work, attempted PENDING work, OFFLINE holds
and NO_PRINTER records. PRINTED is only the existing server acknowledgement state; it is
not a claim of confirmed paper output. Preserve printed history as well.

The operator must explicitly remove or change route bindings through the accepted routing
workflow. Unresolved delivery needs its own authorized reconciliation workflow. Retirement
must not clear bindings, change job status, reset attempts, delete state markers or move a
job to another printer to satisfy the gate. A blocker is a definite conflict with no write.

After authorization, an already retired target can return the idempotent result before
these transition checks. That result only reports its saved lifecycle state; it does not
certify the absence of anomalous references or authorize delivery.

Audit the target, branch, bridge, changed flag and saved retirement timestamp through the
existing audit mechanism. Do not include credentials, enrollment codes, receipt documents
or transport output in audit details or errors. Unknown errors remain errors; an uncertain
response is not permission for an automatic physical retry.

## Transaction and admission rule

The original baseline only took a branch admission lock for guarded Settings
requests. The shared locking dependency now covers fresh registered enqueue and
registered route admission. The retirement transition below now verifies actual outer
isolation and holds the corresponding branch/printer update locks. A `retiredAt: null` filter alone would leave other enqueue producers able
to race retirement. Do not enable a retirement writer until all of the following are true.

- Retirement takes the tenant branch lock, then the printer row lock, both FOR UPDATE,
  before checking references and updating the timestamp. Its transaction must use a
  verified Read Committed boundary so blocker reads see preceding committed work after
  waiting for the branch lock. A nested wrapper cannot silently upgrade its outer isolation.
- Route replacement retains its existing branch FOR UPDATE lock. Before admitting any
  registered reference, acquire current locking reads of those printer rows in stable ID
  order, then validate ownership, exact address, active bridge and unretired state.
- Every fresh registered enqueue participates, including unguarded order, course, reprint
  and receipt producers. Keep the existing idempotency lock and prior-job replay first.
  Before a new registered job's eligibility observation and insert, hold the branch lock
  FOR SHARE and the printer row lock FOR SHARE until the outer transaction commits.
- A branch lock alone does not refresh an older Repeatable Read snapshot when retirement
  changes only the printer row. The printer locking read must fail closed on a stale
  higher-isolation snapshot; never fall back to a stale nonlocking observation. Verify the
  exact outer boundary for each producer rather than assuming the nested facade changes it.
- Keep eligibility and the 58/80 mm ticket-width snapshot tied to the same locked inventory
  observation. Do not resolve another target, invent a fallback width or reuse stale caller
  metadata when admission fails.

For new work, the retired record is unavailable. Registered route saves fail before deleting
or replacing any rows. Guarded enqueue returns the existing refresh conflict; unguarded
enqueue returns the existing retryable NO_PRINTER result without inserting a job. Raw-only
legacy routes and jobs retain their existing contract. Another inventory record or raw
route sharing the address is not retired by association.

Preserve existing early branch guards and unguarded no-route behavior: an unguarded
request with no resolved route returns NO_PRINTER before prior-job lookup. Once the
existing prior-job lookup is reached, replay precedes retirement eligibility and retains
the persisted destination and document. Keep synchronous registered delivery rejected.
Do not broaden fresh-only claiming, bridge ownership, HMAC, lease, CAS or ACK behavior.
Claim eligibility must not dispatch a retired registered record. ACK of an already valid
claim still uses the existing job/device/token contract and must not be silently retargeted
or blocked solely by a later inventory flag. No automatic delivery recovery is introduced.

## Exact backend admission boundary

The next product slice must admit the complete change together:

- `prisma/schema.prisma`: the nullable retirement field only, plus one additive application
  migration and the corresponding generated-client/application manifest changes. Preserve
  the fixed initializer profile and every previous migration byte. Do not run a migration.
- `src/lib/restaurant/printer-inventory.ts` and
  `src/server/routers/restaurant-devices.ts`: public lifecycle projection, authorized
  monotonic transition, transaction checks and audit metadata.
- `src/lib/restaurant/printing/registered-routing.ts` and
  `src/lib/restaurant/printing/service.ts`: current locking admission, retired eligibility,
  retained replay and stored-width behavior.
- Actual outer producer transaction owners identified in the checkpoint's dependency map;
  include `src/app/api/restaurant/print-bridge/route.ts` if its isolation boundary changes.
  A missing or unverified owner keeps retirement writes unadmitted.
- Focused synthetic tests for those changes and the existing exact accepted printing tests
  whose behavior is affected. No donor, Pharmacy-held, fixture or database-test payload
  becomes readable or executable merely because it is adjacent.

The corrected producer map has three direct enqueue sites: manual POST in
`src/app/api/restaurant/print-bridge/route.ts` and
`src/lib/restaurant/kitchen-tickets.ts`, and
`src/app/api/restaurant/checkout/receipt/receipt-dispatch.ts`. Kitchen tickets receive their caller's transaction from
send, fire-course and reprint operations in `src/lib/restaurant/orders.ts`.

Web send/fire enters through `src/server/routers/restaurant-orders.ts`; the default tRPC
context in `src/server/trpc.ts` supplies the tenant facade, while an injected database
context can already own a transaction. Terminal fire and reprint enter through
`src/app/api/restaurant/orders/fire/route.ts` and
`src/app/api/restaurant/orders/reprint-kot/route.ts`, then
`src/lib/restaurant/terminal-orders.ts` and the outer `withTenantDb` call in
`src/lib/restaurant/terminal-auth.ts`. Receipt dispatch uses `moneyMutationRoute` in
`src/lib/restaurant/checkout-routes.ts`, which delegates to the same terminal outer transaction.

Only guarded manual HTTP requests explicitly select Read Committed. Order transactions,
terminal outer transactions and unguarded manual requests omit isolation; the deployed
default has not been established. `src/lib/tenancy/scoped-db.ts` reuses nested transactions,
so a new nested option cannot prove the outer isolation. These exact owners are the next
implementation dependency, not permission to refactor unrelated transaction consumers.

Before edits, pin the current base, exact paths and test-read scope; forecast schema/codegen
and evidence storage while retaining the established disk reserve. Generate only into an
owned output with verified realpaths, using existing dependencies. Preserve accepted
application and initializer records separately. No service, credential, runtime database,
network, deployment or cleanup action is part of source admission.

The reviewed inventory UI keeps retired rows visible with lifecycle separate from observed
health. It requires branch- and printer-specific confirmation before one guarded retirement
mutation, retains confirmed server timestamps through list-refresh failure, and reports
conflict or uncertain outcomes without automatic retry. Registration, rename and another
retirement stay blocked until a fresh authorized post-outcome inventory read and operator
acknowledgement. Visual and browser QA remain open.

## Required focused proof before source acceptance

| Area           | Decisive positive and negative proof                                                                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization  | Manager capability and active authorized branch succeed; missing capability, cross-tenant, cross-branch, inactive or missing branch/target fail without writes. An inactive/revoked bridge alone does not prevent retirement.                  |
| Blockers       | Both enabled and disabled registered routes block. Every non-PRINTED job state blocks, including attempted/uncertain work. PRINTED history is preserved.                                                                                       |
| Transition     | One server timestamp is written; repeated retirement retains it. Telemetry, ownership, address, width, credentials, routes and jobs are unchanged.                                                                                             |
| Ordering       | Retirement locks branch then printer before blockers; route saves and guarded/unguarded fresh enqueue take the corresponding locks before eligibility and insertion. Denied/stale admission performs no write.                                 |
| Compatibility  | Existing early guards/no-route behavior remain. Once lookup is reached, prior replay occurs before fresh eligibility; stored destination/width and ACK remain intact. Retired new selection fails; raw-only legacy behavior remains unchanged. |
| Claim/ACK      | An anomalous queued job bound to a retired record receives no dispatch or attempt increment. An already-valid claim still acknowledges through the unchanged device/token/lease contract.                                                      |
| Schema/package | Nullable additive migration, generated schema identity, application manifest/profile and immutable initializer boundaries are coherent; no previous SQL bytes disappear.                                                                       |

Synthetic source tests cannot establish database interleavings, RLS, migration execution,
mixed-version rollout or physical output. Real concurrent enqueue/route-save/retire and
stale-isolation tests remain a separately authorized database acceptance gate. Reader/writer
rollout must prevent old writers that ignore retirement from creating new registered work
before a retirement endpoint is enabled. Source acceptance must state that dependency.

## Implemented backend slice

The nullable `retiredAt` field and additive application migration are accompanied by an
audited `retirePrinter` management mutation. The transaction requests ReadCommitted and
checks its actual isolation before branch and printer update locks, blockers and the
conditional lifecycle update. Repeats retain the saved timestamp. Inventory listing keeps
retired records visible; new registered routing, enqueues and claims exclude them. ACK
retains the existing token, device, job and lease rules without a retirement filter.

Offline schema generation and mocked source checks are the acceptance scope. No migration
has been executed. Before deployment enables this mutation, all old registered-job and
route writers must be replaced or stopped; their ignorance of retirement invalidates the
locking/eligibility contract. The inventory panel has 60 passing synthetic tests for
confirmation, receipts and reconciliation; these do not establish visual or browser behavior.
Live database interleavings, migration execution, RLS verification, runtime acceptance,
old-writer rollout and physical output remain separate gates.
