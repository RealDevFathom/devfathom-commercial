# Catering payment evidence adapter — WHA-1213

Local candidate from `83899072f6f702d490f913faed86bf6430659437`. No route, shared schema, tender, payment, refund, drawer or daily-close source edits. Historical completed POS business-date fix is unchanged.

## Exact integration contract

`recordCateringMoneyEvidence(tx, trustedScope, input)` returns `{ evidenceId, ledgerReference: string|null, replayed }`. `tx` must be the existing `withTenantDb` transaction. Propagate all failures out of that transaction. The adapter never opens/commits a transaction or invokes providers, inventory, bills, tenders, receipt allocation or settlement.

`trustedScope` contains organizationId, branchId, staffProfileId, deviceId and `StaffBranchAuthorization`. These are exclusively server-derived: authenticated tenant/restaurant-module context, verified live device/session, and `resolveCapabilityBranchAuthorization(..., 'catering:manage')`. Never accept scope, actor, organizationId, client time or authorization from request JSON. The adapter rechecks ACTIVE staff/device, device tenant/branch, authorized actor/branch, and branch-effective capabilities through existing role/direct-grant DENY precedence. Required capabilities: catering:manage; additionally cash:adjust for CASH and payments:refund for REFUND. These are intentionally explicit branch grants, including for organization-wide administrators. The route owner must preserve the existing authenticated-device/session checks; no new endpoint is supplied here.

`input`: cateringOrderId, quoteRevisionId, kind DEPOSIT|BALANCE|REFUND, positive amount string with at most two decimal places, uppercase three-letter currency, source CASH|OPERATOR_ATTESTED, idempotencyKey. CASH requires drawerSessionId and prohibits external provenance fields. OPERATOR_ATTESTED requires externalEvidenceSource and externalEvidenceReference and prohibits drawerSessionId. REFUND requires originalEvidenceId; other kinds prohibit it. A refund must use the original receipt's source and currency. Noncash reference uniqueness is tenant-wide by source/reference, across orders and kinds; an external refund needs its own reference.

Contract matches catering owner's `api-handoff.md`: restaurant_catering_quote_revisions(id, organizationId, orderId, revision, snapshot, contentHash); snapshot.schemaVersion=1 with currency and quotedTotal; restaurant_catering_quote_approvals with quoteRevisionId/orderRevision; order.revision and approvedQuoteRevisionId. Shared lock is `pg_advisory_xact_lock(hashtextextended(orderId,0))`. All current-quote and aggregate reads occur under it. Existing catering writers must retain that same lock. New DEPOSIT/BALANCE requires explicit approval at the current order revision and an allowed nonterminal status (DRAFT, QUOTED, CONFIRMED, IN_PRODUCTION, READY, DELIVERED). CANCELLED/CLOSED rejects new receipts with ORDER_NOT_RECEIVABLE. REFUND instead requires input.quoteRevisionId to equal the original same-tenant/branch/order receipt's quoteRevisionId, with a retained historical approval whose orderRevision equals that quote's revision. It retains the original currency/source and remaining-receipt cap; arbitrary unapproved history and other-order receipts are denied. Current approval pointer/revision and terminal status do not prevent returning previously received money. Quote revisions, approvals, and receipt history must remain immutable under the composed schema. No new quote approval is needed for refunds after editing or cancellation.

Receipts are capped by approved total less net receipts. Refunds are capped against the original receipt less its previous refunds. Amounts stay unearned evidence; this is not a general ledger or statutory accounting assertion. Cash appends exactly one PAID_IN/PAID_OUT and links its unique ID; never CASH_SALE/CASH_REFUND. Drawer device/operator/branch/business-date must match and the drawer/day must be open. Existing daily-close lock and appendMovement locking are reused unchanged.

Canonical money idempotency includes tenant, branch, actor/device, order, quote, amount, currency, kind, source, original receipt, provenance and drawer. Equivalent amounts normalize to two decimal places. Identical replay returns the stored result even if the order status/quote/day subsequently changes; authorization is rechecked first. Changed replay conflicts. Different orders using the same device/key can lose the existing unique-key race and roll back; retry returns replay/conflict per the existing primitive.

`summarizeCateringMoney(approvedQuoteTotal, plannedDepositAmount, evidence, currency)` returns approvedQuoteTotal, plannedDepositAmount, recordedReceipts, recordedRefunds, netPaid, refundableBalance, amountDue and currency. Route owner must supply tenant/branch/order-filtered persisted evidence and current authoritative quote. No quote means amountDue=null. Legacy depositAmount is planned only; no backfill infers paid/approval/history. All evidence is excluded from settled sales/net sales/receipt/tender reporting; existing drawer adjustments account for physical cash.

## Central composition and runtime proof

Compose the catering owner's quote/order migration first, then the proposed `evidence.sql` and scalar `evidence.prisma` fragment. These files are not registered/applied migrations. Coordinator owns final schema relation metadata, grants, deployment and verification. Preserve composite tenant/order/currency/source FKs, positive/check constraints, unique provenance/drawer references, FORCE RLS and append-only trigger. Grant the runtime role SELECT/INSERT on the evidence table; no UPDATE/DELETE. The adapter remains unavailable before composition.

Do not modify or delete evidence to reverse it: record a linked refund. Disabling route wiring can roll back exposure; never roll back by deleting financial history.

The prepared `catering-money.db.test.ts` uses real application transactions and SQL, two organizations and three branches. It refuses to run without `CATERING_MONEY_DB_SLOT=reserved`, a local disposable TEST_DATABASE_URL, and a role with rolsuper=false/rolbypassrls=false. It does not create a listener, apply migrations, or delete immutable fixture rows. Dispose the entire test database after proof.

Run from repository root after coordinator reserves the slot and composes schema:

```sh
CATERING_MONEY_DB_SLOT=reserved TEST_DATABASE_URL='<reserved local disposable runtime URL>' node_modules/.bin/vitest run --configLoader runner --config docs/restaurant/catering-money/vitest.config.mts
```

Without the slot flag the same config runs only the source/unit suite. No database acceptance is claimed from unit doubles. Independent review and runtime proof remain required; candidate is not self-approved.

Lifecycle correction runtime owner: the same WHA-1294 catering composer (7025), using the already assigned exclusive 55675 slot. This source lane must not start another database or change the composer checkout. Schema fragments are unchanged. Run the updated restricted-role cases after composing this follow-up commit.
