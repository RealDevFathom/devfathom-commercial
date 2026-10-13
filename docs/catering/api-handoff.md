# Catering continuation contract — October 7

Base 83899072f6f702d490f913faed86bf6430659437. Composer candidate in owned-repo at parent 9bd8c800; additive schema and finance/recipe source composed. Runtime endpoint acceptance remains pending.

Order additions: bookingStartsAt/bookingEndsAt nullable timestamptz, fulfillmentMode nullable PICKUP|DELIVERY, stockLocationId nullable, revision integer default 0, approvedQuoteRevisionId/confirmedQuoteRevisionId nullable. Legacy nulls mean unknown. Existing depositAmount remains planned.

Quote table: restaurant_catering_quote_revisions (id, organizationId, orderId, revision, snapshot jsonb, contentHash, createdByStaffId, createdAt). snapshot schemaVersion=1, currency, quotedTotal decimal string, headcount, booking interval, fulfillmentMode, stockLocationId, menu lines, extraCosts, requirements. Requirement: ingredientId/name, baseUnitId, stockItemId nullable, quantityInBaseUnit string, unitCost nullable string, costSource WEIGHTED_AVERAGE|REFERENCE|MISSING. Line records root recipeVersionId and expanded frozen components. Snapshot prices are estimated weighted-average or reference ingredient costs, never actual or settled revenue.

Approval table: restaurant_catering_quote_approvals (id, organizationId, orderId, quoteRevisionId, orderRevision, actorStaffProfileId, createdAt). Same-order quote FK. Finance must check order.approvedQuoteRevisionId == quote.id and order.revision == quote.revision, and explicit approval exists. Use the same transaction advisory order lock: hashtextextended(orderId,0). Booking operations lock catering:branch:{organizationId}:{branchId} before the order lock. Money commands should only take the order lock.

API names: setBooking({orderId,bookingStartsAt,bookingEndsAt,fulfillmentMode,stockLocationId}); setBranchCapacity({branchId,maxConcurrentHeadcount:null|positiveInt}); bookingAvailability({orderId}); publishQuote({orderId,currency}); approveQuote({orderId,quoteRevisionId}); quoteHistory({orderId}); recordDisposition({orderId,originalMovementId,kind:UNUSED_RETURN|WASTE|NO_RETURN,quantity:canonicalDecimalString,reason,idempotencyKey}). transition adds optional idempotencyKey; identical keyed replay returns persisted original response. Existing CRUD stays, but quote-affecting edits invalidate approval and confirmed menu/booking edits fail.

Capacity unknown fails confirmation. Half-open interval peak concurrent headcount is checked under the shared branch lock. Cancellation does not restock. Only explicit UNUSED_RETURN restores its allocated canonical quantity; WASTE/NO_RETURN do not post stock again. Allocations cap at original consumption; prior automatic reversals preclude further returns. Physical disposition and financial refund are independent.

Money adapter and tests remain WHA-1213-owned. No new money mutation exposed in this lane until composition. UI must not interpret legacy depositAmount as paid.

## Implemented source and composition requirements

All named non-money procedures above are implemented in the owned router. `get` includes the nullable booking/approval/revision fields; existing list payloads retain their original shape. `setBooking` sets all four operational fields together. Cancellation itself never posts inventory. `recordDisposition` requires CANCELLED and a source movement proven by the original consumption idempotency record. A legacy automatic-reversal key blocks additional disposition pending reconciliation.

Every route now requires restaurant-core entitlement, the appropriate catering capability and authenticated branch-authorized staff. Caller-provided actor IDs must match that staff identity. Reads of a list spanning unauthorized branches fail closed. Confirmed and terminal order/menu/extra-cost edits are blocked. Delivery operational updates remain available until terminal status.

`costSummary` retains old scalar aliases for unfrozen estimates and adds `costBasis`, `missing`, `ingredientCost`, `grossMargin`, `actualCost:null`. A frozen quote uses the snapshot exclusively. Missing costs return null totals/margins, not zero. Frozen estimates use computeRecipeCostInDb for the same resolved root version, with weighted-average preference and reference fallback; they do not claim actual catering COGS. Extras are separately stated; no net-profit claim.

Central integration must apply `prisma/migrations/20261007101500_catering_booking_quotes_disposition/migration.sql` and compose `prisma/fragments/catering-order-fields.prisma` into RestaurantCateringOrder plus the model fragment. Cross-table relations, RLS, CHECKs and triggers are defined by SQL; the scalar Prisma fragment is not permission to regenerate/drop those constraints. Add corresponding Prisma relation metadata when composing the central schema. The base schema was not edited. The router uses parameterized SQL for new fields/tables, so the current generated client remains usable with the additive migration.

Quote, approval, command result and disposition tables are append-only under forced tenant RLS plus immutable-history triggers. Stock/staff cross-tenant and branch references have validation triggers. Capacity update and confirmation serialize on the same branch lock; edits, quote approval, transitions and dispositions serialize on order lock. No nested owning transaction, error swallow, or money mutation was added.

Dependency: recipe expansion calls the existing `explodeRecipeInDb(tx, ...)`. WHA-1320 remains the sole owner of its portion/yield and nested-unit corrections. Frozen leaf quantities prevent later active recipes/prices from changing production, but cannot correct an erroneous expansion at publication. Compose and verify that owner’s correction before runtime acceptance. No nested recipe engine or guessed historical recipe versions were added.

Finance integration: WHA-1213 still owns evidence recording, aggregate payment/refund bounds, drawer linkage and financial summary. No payment endpoint or inferred evidence is introduced by this patch. Finance should use the published quote/approval contract and identical order lock; final adapter wiring and UI composition need coordinator review.

## Composed UI endpoint contract (supersedes earlier pending-money notes)

Accepted source: recipe 00a33 + c56f6b6f + 9fa5ca63; finance 20da9e25 + 2219d083. Central candidate schema now includes their catering relations and constraints; original migrations remain authoritative. Shared authentication/tRPC implementation is unchanged.

`POST /api/restaurant/catering/money` uses existing terminal transport: enrolled-device Bearer authorization, `x-terminal-session`, and stable `Idempotency-Key` headers. The authenticated operator must have a live linked account and effective branch permissions. The JSON body is strict:

```ts
{
  cateringOrderId: string; quoteRevisionId: string;
  kind: 'DEPOSIT' | 'BALANCE' | 'REFUND';
  amount: string; // positive, at most 10 integer and 2 decimal digits
  currency: string; // three uppercase letters, matches quote/original receipt
  source: 'CASH' | 'OPERATOR_ATTESTED';
  originalEvidenceId?: string; // required for refund; use original receipt quoteRevisionId
  drawerSessionId?: string; // cash only
  externalEvidenceSource?: string; // required for operator-attested noncash
  externalEvidenceReference?: string; // required for operator-attested noncash
}
```

Returns `{evidenceId:string,ledgerReference:string|null,replayed:boolean}`. No organization, branch, actor or device JSON fields are accepted. Use existing authenticated terminal context; do not expose identity/credential fields in a form. No valid terminal context means money recording is unavailable. Identical retries retain the key/body. Errors return `{error:string}` with HTTP 400 invalid input, 401 invalid terminal credentials/session, 403 authorization/scope denial, or 409 business conflict. Unexpected errors follow existing terminal error handling after rollback.

New receipts on CANCELLED/CLOSED fail; existing successful replay remains valid under current authorization. Refunds reference the original historically approved receipt quote even after draft edits/cancellation; caps, provenance, day/drawer and refund permission checks still apply. Refund never restores stock. Operator-attested is not provider-verified.

All following reads use authenticated `restaurantCatering` tRPC, input `{orderId:string}`, core entitlement, catering:read and actor/branch authorization:

- `paymentSummary`: `{approvedQuoteTotal:string|null,plannedDepositAmount:string|null,recordedReceipts:string,recordedRefunds:string,netPaid:string,refundableBalance:string,amountDue:string|null,currency:string|null,moneyBasis:'UNEARNED_EVIDENCE',evidence:Array<{id:string,quoteRevisionId:string,kind:'DEPOSIT'|'BALANCE'|'REFUND',amount:string,currency:string,source:'CASH'|'OPERATOR_ATTESTED',originalEvidenceId:string|null,drawerMovementId:string|null}>}`. Current approval absent/stale means null approved total/amount due. Persisted evidence remains readable. Use receipt ID and receipt quote ID for refunds.
- `approvalHistory`: `Array<{id:string,quoteRevisionId:string,orderRevision:number,actorStaffProfileId:string,createdAt:Date}>`, oldest first. Compare to order approvedQuoteRevisionId/current revision; historical approval is not current approval.
- `consumptionHistory`: `{reconciliationRequired:boolean,movements:Array<{originalMovementId:string,stockItemId:string,locationId:string,canonicalUnit:{id:string,name:string,abbreviation:string|null},consumed:string,allocated:string,remaining:string|null,dispositions:Array<{id:string,originalMovementId:string,kind:'UNUSED_RETURN'|'WASTE'|'NO_RETURN',quantity:string,resultMovementId:string|null,reason:string,actorStaffProfileId:string,createdAt:Date}>}>}`. All quantities are canonical-unit decimal strings. Empty movements means no persisted consumption. Legacy automatic reversal sets reconciliationRequired and null remaining; disable new disposition. A missing source or overallocated history fails closed.

`quoteHistory` remains unchanged. Dates use the existing tRPC date transformer. Money/disposition reads serialize with their order's mutations. These are implemented source contracts; source checks and endpoint DB proof are separately reported, and no build/browser acceptance is claimed.

## October 7 location-read and unit-label delta

- Query: `restaurantCatering.bookingLocations({ branchId: string })` (required, trimmed nonempty ID, max 200 chars; strict input). Output: `Array<{ id: string; name: string }>` ordered by name then ID; only active stock locations in that branch and current organization. Empty result is `[]`. Use for the booking stock-location selector.
- Authorization: existing `catering:read`, `restaurant-core`, authenticated active staff actor and existing branch assignment/global-configure checks. A role with `catering:read` and `catering:manage` needs no inventory/report capability or inventory module for this selector. `catering:manage` alone does not imply read. Unauthorized branch/capability/module/actor returns `FORBIDDEN`; malformed input returns `BAD_REQUEST`. No global roles, shared procedure mapping or inventory permission changes.
- `restaurantCatering.productionRequirements({ orderId })` adds `baseUnit: { id: string; name: string; abbreviation: string | null } | null` to every existing row. `baseUnitId` and decimal-string `quantityInBaseUnit` remain authoritative. Labels resolve against current in-tenant unit metadata using the recorded ID, including frozen requirements; they are not historical label snapshots. Missing metadata returns `null`: display the recorded ID, never guess or substitute the stock item's canonical unit. No frozen snapshot, hash, recipe or quantity is rewritten.
- Existing `restaurantCatering.consumptionHistory({ orderId })` already exposes `movements[].canonicalUnit: { id; name; abbreviation }`; consumed/allocated/remaining and disposition quantities are in that canonical unit. Keep this distinct from requirement base units. Quote-history JSON stays unchanged.
- Source tests exercise actual ABAC decisions with a catering-only organization role, actual actor/branch middleware, denied inventory/report reads, denied cross-branch lookup, strict/minimal query shape, module/capability/actor failures, live base-unit labeling and frozen/missing labels. Restricted-DB endpoint test also seeds active/inactive/other-branch locations; execution remains subject to existing resource gate.
