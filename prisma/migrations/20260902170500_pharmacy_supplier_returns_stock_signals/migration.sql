-- PH-PUR/PH-INV PUR-06 + PUR-07 (PRD §6.3; §8A invariants 9 and 29):
-- purchase returns, expiry claims, debit notes, supplier credit and settlement;
-- the deterministic stock action centre with draft-only one-click actions.

-- PUR-06: stock that has gone back to the supplier stays on the append-only
-- ledger under its own disposition, so the claim remains reconcilable and
-- nothing can allocate the units again.
ALTER TYPE "PharmacyStockDisposition" ADD VALUE 'RETURN_TO_SUPPLIER';

-- PUR-07 / §8A invariant 29: the inert state a one-click draft transfer lands
-- in. `approveTransfer` requires ALLOCATED, so a DRAFT transfer has no path to a
-- stock movement without a separate human step.
ALTER TYPE "PharmacyTransferStatus" ADD VALUE 'DRAFT' BEFORE 'ALLOCATED';

CREATE TYPE "PharmacyPurchaseReturnKind" AS ENUM ('PURCHASE_RETURN','EXPIRY_CLAIM');
CREATE TYPE "PharmacyPurchaseReturnStatus" AS ENUM ('DRAFT','SUBMITTED','DISPATCHED','SETTLED','CANCELLED');
CREATE TYPE "PharmacyDebitNoteStatus" AS ENUM ('OPEN','PARTIALLY_SETTLED','SETTLED','CANCELLED');
CREATE TYPE "PharmacyStockSignalKind" AS ENUM ('LOW_STOCK','STOCKOUT','PROJECTED_STOCKOUT','INBOUND_COVERAGE','NEAR_EXPIRY','RETURN_WINDOW','RECALL','QUARANTINE','COLD_CHAIN','COUNT_VARIANCE');
CREATE TYPE "PharmacyStockSignalStatus" AS ENUM ('OPEN','ACKNOWLEDGED','SNOOZED','DISMISSED','CLOSED','STALE');
CREATE TYPE "PharmacyStockSignalConfidence" AS ENUM ('EXACT','PARTIAL');
CREATE TYPE "PharmacyStockSignalEventKind" AS ENUM ('RAISED','REFRESHED','ACKNOWLEDGED','SNOOZED','DISMISSED','CLOSED','MARKED_STALE','DRAFT_ACTION');
CREATE TYPE "PharmacyStockSignalActionKind" AS ENUM ('DRAFT_REQUISITION','DRAFT_TRANSFER','DRAFT_CLAIM');

-- A return line points at the reservation it took, so the INV-09 claim needs an
-- organization-scoped key to be referenced by.
ALTER TABLE "pharmacy_supplier_claims"
  ADD CONSTRAINT "pharmacy_supplier_claims_org_id_key" UNIQUE ("organizationId","id");

-- ── PUR-06 — returns, claims, debit notes, credit ──────────────────────────

CREATE TABLE "pharmacy_purchase_returns" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "kind" "PharmacyPurchaseReturnKind" NOT NULL,
  "status" "PharmacyPurchaseReturnStatus" NOT NULL DEFAULT 'DRAFT',
  "reference" TEXT NOT NULL,
  "note" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "submittedByUserId" TEXT,
  "submittedAt" TIMESTAMP(3),
  "dispatchedByUserId" TEXT,
  "dispatchedAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_purchase_returns_supplier_fkey"
    FOREIGN KEY ("organizationId","supplierId") REFERENCES "pharmacy_suppliers"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_purchase_returns_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_purchase_returns_org_branch_id_key" UNIQUE ("organizationId","branchId","id"),
  CONSTRAINT "pharmacy_purchase_returns_org_reference_key" UNIQUE ("organizationId","reference"),
  CONSTRAINT "pharmacy_purchase_returns_text_check" CHECK (
    length(btrim("branchId")) > 0 AND length(btrim("reference")) > 0 AND length(btrim("createdByUserId")) > 0),
  -- The lifecycle timestamps are the evidence that a status was reached; a
  -- status that claims a step without the actor and instant behind it is not a
  -- record of anything.
  CONSTRAINT "pharmacy_purchase_returns_submitted_check" CHECK (
    ("submittedAt" IS NULL) = ("submittedByUserId" IS NULL)),
  CONSTRAINT "pharmacy_purchase_returns_dispatched_check" CHECK (
    ("dispatchedAt" IS NULL) = ("dispatchedByUserId" IS NULL)),
  CONSTRAINT "pharmacy_purchase_returns_status_check" CHECK (
    ("status" <> 'SUBMITTED'  OR "submittedAt" IS NOT NULL) AND
    ("status" <> 'DISPATCHED' OR ("submittedAt" IS NOT NULL AND "dispatchedAt" IS NOT NULL)) AND
    ("status" <> 'SETTLED'    OR ("dispatchedAt" IS NOT NULL AND "settledAt" IS NOT NULL)) AND
    ("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
);
CREATE INDEX "pharmacy_purchase_returns_org_branch_status_idx" ON "pharmacy_purchase_returns"("organizationId","branchId","status");
CREATE INDEX "pharmacy_purchase_returns_org_supplier_status_idx" ON "pharmacy_purchase_returns"("organizationId","supplierId","status");

CREATE TABLE "pharmacy_purchase_return_lines" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "purchaseReturnId" TEXT NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "inventoryLotId" TEXT NOT NULL,
  "stockLocationId" TEXT NOT NULL,
  "quantityUnits" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "returnWindowEndsAt" TIMESTAMP(3) NOT NULL,
  "expectedCreditMinor" INTEGER NOT NULL,
  "supplierClaimId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_purchase_return_lines_return_fkey"
    FOREIGN KEY ("organizationId","branchId","purchaseReturnId") REFERENCES "pharmacy_purchase_returns"("organizationId","branchId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_purchase_return_lines_lot_fkey"
    FOREIGN KEY ("organizationId","branchId","inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId","branchId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_purchase_return_lines_location_fkey"
    FOREIGN KEY ("organizationId","stockLocationId") REFERENCES "pharmacy_stock_locations"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_purchase_return_lines_claim_fkey"
    FOREIGN KEY ("organizationId","supplierClaimId") REFERENCES "pharmacy_supplier_claims"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_purchase_return_lines_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_purchase_return_lines_org_return_line_key" UNIQUE ("organizationId","purchaseReturnId","lineNumber"),
  -- §8A invariant 1: a returned quantity is an integer count of canonical base
  -- units, never a decimal pack figure.
  CONSTRAINT "pharmacy_purchase_return_lines_quantity_check" CHECK ("quantityUnits" > 0),
  CONSTRAINT "pharmacy_purchase_return_lines_credit_check" CHECK ("expectedCreditMinor" >= 0),
  CONSTRAINT "pharmacy_purchase_return_lines_text_check" CHECK (
    "lineNumber" > 0 AND length(btrim("reason")) > 0 AND length(btrim("branchId")) > 0)
);
CREATE INDEX "pharmacy_purchase_return_lines_org_branch_lot_idx" ON "pharmacy_purchase_return_lines"("organizationId","branchId","inventoryLotId");

CREATE TABLE "pharmacy_debit_notes" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "purchaseReturnId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "status" "PharmacyDebitNoteStatus" NOT NULL DEFAULT 'OPEN',
  "expectedCreditMinor" INTEGER NOT NULL,
  "issuedByUserId" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_debit_notes_supplier_fkey"
    FOREIGN KEY ("organizationId","supplierId") REFERENCES "pharmacy_suppliers"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_debit_notes_return_fkey"
    FOREIGN KEY ("organizationId","branchId","purchaseReturnId") REFERENCES "pharmacy_purchase_returns"("organizationId","branchId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_debit_notes_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_debit_notes_org_reference_key" UNIQUE ("organizationId","reference"),
  CONSTRAINT "pharmacy_debit_notes_org_return_key" UNIQUE ("organizationId","purchaseReturnId"),
  CONSTRAINT "pharmacy_debit_notes_amount_check" CHECK ("expectedCreditMinor" >= 0),
  CONSTRAINT "pharmacy_debit_notes_text_check" CHECK (
    length(btrim("reference")) > 0 AND length(btrim("issuedByUserId")) > 0 AND length(btrim("branchId")) > 0),
  CONSTRAINT "pharmacy_debit_notes_cancelled_check" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
);
CREATE INDEX "pharmacy_debit_notes_org_branch_status_idx" ON "pharmacy_debit_notes"("organizationId","branchId","status");
CREATE INDEX "pharmacy_debit_notes_org_supplier_status_idx" ON "pharmacy_debit_notes"("organizationId","supplierId","status");

CREATE TABLE "pharmacy_supplier_credits" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "recordedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_supplier_credits_supplier_fkey"
    FOREIGN KEY ("organizationId","supplierId") REFERENCES "pharmacy_suppliers"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_supplier_credits_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_supplier_credits_org_supplier_reference_key" UNIQUE ("organizationId","supplierId","reference"),
  CONSTRAINT "pharmacy_supplier_credits_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "pharmacy_supplier_credits_text_check" CHECK (
    length(btrim("reference")) > 0 AND length(btrim("recordedByUserId")) > 0 AND length(btrim("branchId")) > 0)
);
CREATE INDEX "pharmacy_supplier_credits_org_branch_received_idx" ON "pharmacy_supplier_credits"("organizationId","branchId","receivedAt");

CREATE TABLE "pharmacy_supplier_credit_allocations" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "supplierCreditId" TEXT NOT NULL,
  "debitNoteId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "allocatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_credit_allocations_credit_fkey"
    FOREIGN KEY ("organizationId","supplierCreditId") REFERENCES "pharmacy_supplier_credits"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_credit_allocations_note_fkey"
    FOREIGN KEY ("organizationId","debitNoteId") REFERENCES "pharmacy_debit_notes"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_credit_allocations_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_credit_allocations_org_credit_note_key" UNIQUE ("organizationId","supplierCreditId","debitNoteId"),
  CONSTRAINT "pharmacy_credit_allocations_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "pharmacy_credit_allocations_actor_check" CHECK (length(btrim("allocatedByUserId")) > 0)
);
CREATE INDEX "pharmacy_credit_allocations_org_note_idx" ON "pharmacy_supplier_credit_allocations"("organizationId","debitNoteId");

-- ── PUR-07 — the deterministic stock action centre ─────────────────────────

CREATE TABLE "pharmacy_safety_stocks" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "safetyStockUnits" INTEGER NOT NULL,
  "coverageDays" INTEGER NOT NULL DEFAULT 30,
  "approvedByUserId" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_safety_stocks_medicine_fkey"
    FOREIGN KEY ("organizationId","medicineId") REFERENCES "pharmacy_medicines"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_safety_stocks_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_safety_stocks_org_branch_medicine_key" UNIQUE ("organizationId","branchId","medicineId"),
  -- An unapproved threshold is not a threshold: the evaluator refuses to raise a
  -- stock-level signal without one, so the column may never be blank.
  CONSTRAINT "pharmacy_safety_stocks_value_check" CHECK (
    "safetyStockUnits" >= 0 AND "coverageDays" > 0
    AND length(btrim("approvedByUserId")) > 0 AND length(btrim("branchId")) > 0)
);

CREATE TABLE "pharmacy_stock_signals" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "kind" "PharmacyStockSignalKind" NOT NULL,
  "dedupKey" TEXT NOT NULL,
  "status" "PharmacyStockSignalStatus" NOT NULL DEFAULT 'OPEN',
  "medicineId" TEXT NOT NULL,
  "stockLocationId" TEXT,
  "inventoryLotId" TEXT,
  "cause" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "explanation" TEXT NOT NULL,
  "dataWindowStart" TIMESTAMP(3) NOT NULL,
  "dataWindowEnd" TIMESTAMP(3) NOT NULL,
  "sourceObservedAt" TIMESTAMP(3) NOT NULL,
  "freshnessSeconds" INTEGER NOT NULL,
  "confidence" "PharmacyStockSignalConfidence" NOT NULL,
  "neededUnits" INTEGER NOT NULL,
  "onHandUnits" INTEGER NOT NULL,
  "inboundUnits" INTEGER NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedByUserId" TEXT,
  "snoozedUntil" TIMESTAMP(3),
  "snoozeReason" TEXT,
  "dismissedAt" TIMESTAMP(3),
  "dismissedByUserId" TEXT,
  "dismissReason" TEXT,
  "closedAt" TIMESTAMP(3),
  "markedStaleAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_stock_signals_medicine_fkey"
    FOREIGN KEY ("organizationId","medicineId") REFERENCES "pharmacy_medicines"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_signals_location_fkey"
    FOREIGN KEY ("organizationId","stockLocationId") REFERENCES "pharmacy_stock_locations"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_signals_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_stock_signals_org_branch_id_key" UNIQUE ("organizationId","branchId","id"),
  CONSTRAINT "pharmacy_stock_signals_text_check" CHECK (
    length(btrim("branchId")) > 0 AND length(btrim("dedupKey")) > 0 AND length(btrim("cause")) > 0
    AND length(btrim("ownerUserId")) > 0 AND length(btrim("explanation")) > 0),
  CONSTRAINT "pharmacy_stock_signals_units_check" CHECK (
    "neededUnits" >= 0 AND "onHandUnits" >= 0 AND "inboundUnits" >= 0 AND "freshnessSeconds" > 0),
  CONSTRAINT "pharmacy_stock_signals_window_check" CHECK ("dataWindowStart" <= "dataWindowEnd"),
  -- §8A invariant 29: a dismissal or a snooze without its reason is not an
  -- auditable human decision, so the database refuses to store one.
  CONSTRAINT "pharmacy_stock_signals_dismissed_check" CHECK (
    ("status" = 'DISMISSED') = ("dismissedAt" IS NOT NULL AND "dismissedByUserId" IS NOT NULL AND "dismissReason" IS NOT NULL AND length(btrim("dismissReason")) > 0)),
  CONSTRAINT "pharmacy_stock_signals_snoozed_check" CHECK (
    "status" <> 'SNOOZED' OR ("snoozedUntil" IS NOT NULL AND "snoozeReason" IS NOT NULL AND length(btrim("snoozeReason")) > 0)),
  CONSTRAINT "pharmacy_stock_signals_ack_check" CHECK (
    ("acknowledgedAt" IS NULL) = ("acknowledgedByUserId" IS NULL)),
  CONSTRAINT "pharmacy_stock_signals_closed_check" CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL)),
  CONSTRAINT "pharmacy_stock_signals_stale_check" CHECK (("status" = 'STALE') = ("markedStaleAt" IS NOT NULL))
);
-- PUR-07 dedup: at most one LIVE signal per (product, location, cause) identity.
-- Terminal rows are excluded so a dismissed or closed signal stays on the record
-- and the same condition can legitimately be raised again later.
CREATE UNIQUE INDEX "pharmacy_stock_signals_live_dedup_key"
  ON "pharmacy_stock_signals"("organizationId","branchId","dedupKey")
  WHERE "status" IN ('OPEN','ACKNOWLEDGED','SNOOZED','STALE');
CREATE INDEX "pharmacy_stock_signals_org_branch_status_due_idx" ON "pharmacy_stock_signals"("organizationId","branchId","status","dueAt");
CREATE INDEX "pharmacy_stock_signals_org_owner_status_due_idx" ON "pharmacy_stock_signals"("organizationId","ownerUserId","status","dueAt");
CREATE INDEX "pharmacy_stock_signals_org_branch_kind_idx" ON "pharmacy_stock_signals"("organizationId","branchId","kind","status");

CREATE TABLE "pharmacy_stock_signal_events" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "signalId" TEXT NOT NULL,
  "kind" "PharmacyStockSignalEventKind" NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT,
  "detail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_stock_signal_events_signal_fkey"
    FOREIGN KEY ("organizationId","branchId","signalId") REFERENCES "pharmacy_stock_signals"("organizationId","branchId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_signal_events_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_stock_signal_events_actor_check" CHECK (length(btrim("actorId")) > 0),
  -- A snooze or a dismissal is only auditable with the reason attached.
  CONSTRAINT "pharmacy_stock_signal_events_reason_check" CHECK (
    "kind" NOT IN ('SNOOZED','DISMISSED') OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0))
);
CREATE INDEX "pharmacy_stock_signal_events_org_signal_idx" ON "pharmacy_stock_signal_events"("organizationId","branchId","signalId","createdAt");

CREATE TABLE "pharmacy_stock_signal_actions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "signalId" TEXT NOT NULL,
  "kind" "PharmacyStockSignalActionKind" NOT NULL,
  "actorId" TEXT NOT NULL,
  "requisitionId" TEXT,
  "transferId" TEXT,
  "purchaseReturnId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_stock_signal_actions_signal_fkey"
    FOREIGN KEY ("organizationId","branchId","signalId") REFERENCES "pharmacy_stock_signals"("organizationId","branchId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_signal_actions_requisition_fkey"
    FOREIGN KEY ("organizationId","requisitionId") REFERENCES "pharmacy_requisitions"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_signal_actions_transfer_fkey"
    FOREIGN KEY ("organizationId","transferId") REFERENCES "pharmacy_interbranch_transfers"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_signal_actions_return_fkey"
    FOREIGN KEY ("organizationId","purchaseReturnId") REFERENCES "pharmacy_purchase_returns"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_signal_actions_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_stock_signal_actions_actor_check" CHECK (length(btrim("actorId")) > 0),
  -- §8A invariant 29 at the storage layer: an action row names exactly one draft
  -- document, and the reference it names must match the kind it claims. There is
  -- no column here that could point at a purchase order or a stock movement.
  CONSTRAINT "pharmacy_stock_signal_actions_target_check" CHECK (
    (("requisitionId" IS NOT NULL)::int + ("transferId" IS NOT NULL)::int + ("purchaseReturnId" IS NOT NULL)::int) = 1
    AND ("kind" <> 'DRAFT_REQUISITION' OR "requisitionId" IS NOT NULL)
    AND ("kind" <> 'DRAFT_TRANSFER'    OR "transferId" IS NOT NULL)
    AND ("kind" <> 'DRAFT_CLAIM'       OR "purchaseReturnId" IS NOT NULL))
);
CREATE INDEX "pharmacy_stock_signal_actions_org_signal_idx" ON "pharmacy_stock_signal_actions"("organizationId","branchId","signalId","createdAt");

-- ── Append-only evidence and no-delete lifecycle roots ─────────────────────
-- Settlement money, signal decisions and the draft documents a signal produced
-- are records of what happened; a correction is a new row (§8A invariants 8, 15,
-- 27, 29). The lifecycle roots may advance status but can never be deleted.
CREATE TRIGGER pharmacy_credit_allocations_append_only BEFORE UPDATE OR DELETE ON "pharmacy_supplier_credit_allocations" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_signal_events_append_only BEFORE UPDATE OR DELETE ON "pharmacy_stock_signal_events" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_signal_actions_append_only BEFORE UPDATE OR DELETE ON "pharmacy_stock_signal_actions" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_supplier_credits_append_only BEFORE UPDATE OR DELETE ON "pharmacy_supplier_credits" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_purchase_returns_no_delete BEFORE DELETE ON "pharmacy_purchase_returns" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_purchase_return_lines_no_delete BEFORE DELETE ON "pharmacy_purchase_return_lines" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_debit_notes_no_delete BEFORE DELETE ON "pharmacy_debit_notes" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_stock_signals_no_delete BEFORE DELETE ON "pharmacy_stock_signals" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_safety_stocks_no_delete BEFORE DELETE ON "pharmacy_safety_stocks" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();

-- ── Tenant and branch isolation, forced ────────────────────────────────────
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pharmacy_purchase_returns','pharmacy_purchase_return_lines','pharmacy_debit_notes',
    'pharmacy_supplier_credits','pharmacy_safety_stocks','pharmacy_stock_signals',
    'pharmacy_stock_signal_events','pharmacy_stock_signal_actions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_branch_isolation ON %I USING (current_setting(''app.is_platform_admin'',true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'',true),'''') AND (NULLIF(current_setting(''app.current_branch_id'',true),'''') IS NULL OR "branchId" = current_setting(''app.current_branch_id'',true)))) WITH CHECK (current_setting(''app.is_platform_admin'',true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'',true),'''') AND (NULLIF(current_setting(''app.current_branch_id'',true),'''') IS NULL OR "branchId" = current_setting(''app.current_branch_id'',true))))',
      t);
  END LOOP;
END $$;

-- A credit allocation carries no branch of its own; it is narrowed through the
-- debit note it settles, which is branch-scoped by the policy above.
ALTER TABLE "pharmacy_supplier_credit_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_supplier_credit_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_supplier_credit_allocations"
  USING (current_setting('app.is_platform_admin',true) = 'true' OR ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND EXISTS (SELECT 1 FROM "pharmacy_debit_notes" n WHERE n."organizationId" = "pharmacy_supplier_credit_allocations"."organizationId" AND n."id" = "pharmacy_supplier_credit_allocations"."debitNoteId")))
  WITH CHECK (current_setting('app.is_platform_admin',true) = 'true' OR ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND EXISTS (SELECT 1 FROM "pharmacy_debit_notes" n WHERE n."organizationId" = "pharmacy_supplier_credit_allocations"."organizationId" AND n."id" = "pharmacy_supplier_credit_allocations"."debitNoteId")));
