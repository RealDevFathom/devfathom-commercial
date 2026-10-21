-- PH-PUR — PRD §6.3 PUR-02 (the receiving half), PUR-04 (three-way match
-- exceptions) and PUR-05 (the direct purchase path). §8A invariants 3, 6, 8, 18.
--
-- A goods receipt is the document that turns an order or a supplier invoice
-- into stock. It never holds a quantity of its own: posting it writes an
-- inventory lot and RECEIPT movements into the PH-INV ledger, and the ledger's
-- projection remains the only on-hand truth (invariant 6 — nothing here can
-- drive a balance negative because nothing here writes a balance).
--
-- Three things this schema makes unrepresentable rather than merely unreached:
--   * a receipt that posts without batch, expiry, printed MRP, pack conversion,
--     supplier invoice and warranty evidence, from an authorized licensed
--     supplier (PUR-02 acceptance: stock is not saleable until all are present);
--   * rejected goods reaching AVAILABLE — the rejected units name a QUARANTINE
--     or RETURNS location, and the accepted/rejected split is a CHECK (PUR-04);
--   * a correction that edits history — a receipt is reversed by linked
--     compensating movements, never by rewriting the ones it posted
--     (invariant 8, PUR-04 acceptance).
--
-- Branch scope (PLAT-04): receipts, lines and exceptions are branch-owned, like
-- the lots and movements they post. The pharmacy branch entity lands with
-- PLAT-03, so `branchId` carries no foreign key of its own; `organizationId`
-- remains the tenant boundary and the composite (organizationId, branchId, id)
-- keys stop a receipt line from being adopted by another branch's receipt.

CREATE TYPE "PharmacyGoodsReceiptStatus" AS ENUM ('DRAFT','POSTED','REVERSED','CANCELLED');
CREATE TYPE "PharmacyReceivingExceptionKind" AS ENUM ('SHORTAGE','OVERAGE','DAMAGE','PRICE_CONFLICT','PACK_CONFLICT');
CREATE TYPE "PharmacyReceivingExceptionStatus" AS ENUM ('OPEN','RESOLVED');

-- PUR-02 receiving / PUR-05 direct purchase. One header per supplier invoice:
-- the same invoice cannot be received twice into stock.
CREATE TABLE "pharmacy_goods_receipts" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "status" "PharmacyGoodsReceiptStatus" NOT NULL DEFAULT 'DRAFT',
  "supplierId" TEXT NOT NULL,
  "purchaseOrderId" TEXT,
  -- PUR-02: the source-invoice and warranty evidence without which the goods
  -- are not saleable. Both are required on the row, not only at the router.
  "supplierInvoiceRef" TEXT NOT NULL,
  "supplierInvoiceDate" TIMESTAMP(3) NOT NULL,
  "warrantyEvidenceRef" TEXT NOT NULL,
  "receivedByUserId" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  -- PUR-05: a receipt with no purchase order behind it, and the named reason
  -- and approver that authorize the bypass.
  "directPurchase" BOOLEAN NOT NULL DEFAULT false,
  "bypassReason" TEXT,
  "bypassApprovedByUserId" TEXT,
  "bypassApprovedAt" TIMESTAMP(3),
  "postedAt" TIMESTAMP(3),
  "reversedAt" TIMESTAMP(3),
  "reversedByUserId" TEXT,
  "reversalReason" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_goods_receipts_branch_check" CHECK (length(btrim("branchId")) > 0),
  CONSTRAINT "pharmacy_goods_receipts_reference_check" CHECK (length(btrim("reference")) > 0),
  CONSTRAINT "pharmacy_goods_receipts_evidence_check" CHECK (
    length(btrim("supplierInvoiceRef")) > 0
    AND length(btrim("warrantyEvidenceRef")) > 0
    AND length(btrim("receivedByUserId")) > 0
  ),
  -- PUR-05: a direct purchase names its bypass reason and its approver and has
  -- no order; a PO receipt names its order and no bypass. Neither shape can
  -- borrow the other's columns.
  CONSTRAINT "pharmacy_goods_receipts_direct_check" CHECK (
    ("directPurchase" AND "purchaseOrderId" IS NULL
       AND length(btrim(COALESCE("bypassReason", ''))) > 0
       AND length(btrim(COALESCE("bypassApprovedByUserId", ''))) > 0
       AND "bypassApprovedAt" IS NOT NULL)
    OR
    (NOT "directPurchase" AND "purchaseOrderId" IS NOT NULL
       AND "bypassReason" IS NULL AND "bypassApprovedByUserId" IS NULL
       AND "bypassApprovedAt" IS NULL)
  ),
  -- The receiver cannot authorize their own bypass (PUR-02 segregation of
  -- duties, applied to the path that skips the order).
  CONSTRAINT "pharmacy_goods_receipts_bypass_actor_check"
    CHECK ("bypassApprovedByUserId" IS NULL OR "bypassApprovedByUserId" <> "receivedByUserId"),
  CONSTRAINT "pharmacy_goods_receipts_posted_check"
    CHECK (("status" IN ('POSTED','REVERSED')) = ("postedAt" IS NOT NULL)),
  -- A reversal is an event with an actor and a reason, never a silent rollback.
  CONSTRAINT "pharmacy_goods_receipts_reversal_check" CHECK (
    ("status" <> 'REVERSED' AND "reversedAt" IS NULL AND "reversedByUserId" IS NULL
       AND "reversalReason" IS NULL)
    OR
    ("status" = 'REVERSED' AND "reversedAt" IS NOT NULL
       AND length(btrim(COALESCE("reversedByUserId", ''))) > 0
       AND length(btrim(COALESCE("reversalReason", ''))) > 0)
  ),
  CONSTRAINT "pharmacy_goods_receipts_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_goods_receipts_org_branch_id_key" UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_goods_receipts_org_reference_key" UNIQUE ("organizationId", "reference"),
  -- §8A invariant 8 read forward: one supplier invoice is received once.
  CONSTRAINT "pharmacy_goods_receipts_org_invoice_key"
    UNIQUE ("organizationId", "supplierId", "supplierInvoiceRef"),
  CONSTRAINT "pharmacy_goods_receipts_supplier_fkey"
    FOREIGN KEY ("organizationId", "supplierId") REFERENCES "pharmacy_suppliers"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_goods_receipts_order_fkey"
    FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "pharmacy_purchase_orders"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_goods_receipts_org_branch_status_idx" ON "pharmacy_goods_receipts"("organizationId", "branchId", "status", "receivedAt");
CREATE INDEX "pharmacy_goods_receipts_org_order_idx" ON "pharmacy_goods_receipts"("organizationId", "purchaseOrderId");

-- PUR-02 receiving: what actually arrived, at batch granularity. Every field
-- the PH-INV lot needs is here, because a lot is created from this row and a
-- lot that cannot name its batch, expiry, MRP or pack conversion would be
-- stock nobody may sell (§8A invariants 2, 18).
CREATE TABLE "pharmacy_goods_receipt_lines" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "goodsReceiptId" TEXT NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  -- Null on the PUR-05 direct path: there is no ordered line to match against.
  "purchaseOrderLineId" TEXT,
  "medicineId" TEXT NOT NULL,
  "packLevelId" TEXT NOT NULL,
  "batchNumber" TEXT NOT NULL,
  "printedExpiry" TIMESTAMP(3) NOT NULL,
  "expiryPrecision" "PharmacyExpiryPrecision" NOT NULL,
  "printedMrpMinor" INTEGER NOT NULL,
  "canonicalUnitsPerPack" INTEGER NOT NULL,
  "receivedPacks" INTEGER NOT NULL,
  "bonusPacks" INTEGER NOT NULL DEFAULT 0,
  "receivedCanonicalUnits" INTEGER NOT NULL,
  "bonusCanonicalUnits" INTEGER NOT NULL DEFAULT 0,
  -- PUR-04: the accepted/rejected split of everything that arrived. Rejected
  -- units are posted to QUARANTINE or RETURNS and never to AVAILABLE.
  "acceptedCanonicalUnits" INTEGER NOT NULL,
  "rejectedCanonicalUnits" INTEGER NOT NULL DEFAULT 0,
  "rejectionReason" TEXT,
  "invoicedPricePerPackMinor" INTEGER NOT NULL,
  "discountBps" INTEGER NOT NULL DEFAULT 0,
  "taxBps" INTEGER NOT NULL DEFAULT 0,
  "taxCreditable" BOOLEAN NOT NULL DEFAULT false,
  -- Landed cost of one canonical unit, carried onto the lot. Bonus units divide
  -- the same money over more units and never add any (PUR-03).
  "unitCostMinor" INTEGER NOT NULL,
  "stockLocationId" TEXT NOT NULL,
  "quarantineLocationId" TEXT,
  -- Stamped when the receipt posts; the join from this document to the ledger.
  "inventoryLotId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_grl_branch_check" CHECK (length(btrim("branchId")) > 0),
  CONSTRAINT "pharmacy_grl_line_check" CHECK ("lineNumber" > 0),
  -- PUR-02 fail-closed: batch identity, a printed MRP and a pack conversion are
  -- not optional, and a zero MRP is a missing MRP.
  CONSTRAINT "pharmacy_grl_batch_check" CHECK (length(btrim("batchNumber")) > 0),
  CONSTRAINT "pharmacy_grl_mrp_check" CHECK ("printedMrpMinor" > 0),
  CONSTRAINT "pharmacy_grl_pack_check" CHECK ("canonicalUnitsPerPack" > 0),
  CONSTRAINT "pharmacy_grl_money_check" CHECK (
    "invoicedPricePerPackMinor" >= 0 AND "unitCostMinor" >= 0
    AND "discountBps" BETWEEN 0 AND 10000 AND "taxBps" BETWEEN 0 AND 10000
  ),
  -- §8A invariant 1: canonical units are the projection of packs on both the
  -- paid and the free side, never an independently supplied number.
  CONSTRAINT "pharmacy_grl_quantity_check" CHECK (
    "receivedPacks" >= 0 AND "bonusPacks" >= 0
    AND "receivedCanonicalUnits" = "receivedPacks" * "canonicalUnitsPerPack"
    AND "bonusCanonicalUnits" = "bonusPacks" * "canonicalUnitsPerPack"
    AND "receivedCanonicalUnits" + "bonusCanonicalUnits" > 0
  ),
  -- PUR-04: every unit that arrived is either accepted or rejected. Nothing is
  -- lost between the two, and neither side can be negative.
  CONSTRAINT "pharmacy_grl_disposition_check" CHECK (
    "acceptedCanonicalUnits" >= 0 AND "rejectedCanonicalUnits" >= 0
    AND "acceptedCanonicalUnits" + "rejectedCanonicalUnits"
        = "receivedCanonicalUnits" + "bonusCanonicalUnits"
  ),
  -- Rejected goods need somewhere that is not the shelf, and a reason.
  CONSTRAINT "pharmacy_grl_rejection_check" CHECK (
    ("rejectedCanonicalUnits" = 0 AND "quarantineLocationId" IS NULL AND "rejectionReason" IS NULL)
    OR
    ("rejectedCanonicalUnits" > 0 AND "quarantineLocationId" IS NOT NULL
       AND length(btrim(COALESCE("rejectionReason", ''))) > 0)
  ),
  CONSTRAINT "pharmacy_grl_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_grl_org_branch_id_key" UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_grl_org_receipt_line_key" UNIQUE ("organizationId", "goodsReceiptId", "lineNumber"),
  -- The branch travels in the key, so a line cannot be attached to a receipt in
  -- another branch even when both belong to this tenant.
  CONSTRAINT "pharmacy_grl_receipt_fkey"
    FOREIGN KEY ("organizationId", "branchId", "goodsReceiptId") REFERENCES "pharmacy_goods_receipts"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_grl_order_line_fkey"
    FOREIGN KEY ("organizationId", "purchaseOrderLineId") REFERENCES "pharmacy_purchase_order_lines"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_grl_medicine_fkey"
    FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_grl_pack_level_fkey"
    FOREIGN KEY ("organizationId", "packLevelId") REFERENCES "pharmacy_pack_levels"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_grl_location_fkey"
    FOREIGN KEY ("organizationId", "stockLocationId") REFERENCES "pharmacy_stock_locations"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_grl_quarantine_fkey"
    FOREIGN KEY ("organizationId", "quarantineLocationId") REFERENCES "pharmacy_stock_locations"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_grl_lot_fkey"
    FOREIGN KEY ("organizationId", "branchId", "inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId", "branchId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_grl_org_receipt_idx" ON "pharmacy_goods_receipt_lines"("organizationId", "goodsReceiptId");
CREATE INDEX "pharmacy_grl_org_order_line_idx" ON "pharmacy_goods_receipt_lines"("organizationId", "purchaseOrderLineId");
CREATE INDEX "pharmacy_grl_org_medicine_idx" ON "pharmacy_goods_receipt_lines"("organizationId", "medicineId");

-- PUR-04: the three-way match result that a human still has to close. An
-- exception is raised at posting and stays OPEN — and therefore visible — until
-- somebody records who resolved it and why.
CREATE TABLE "pharmacy_receiving_exceptions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "goodsReceiptId" TEXT NOT NULL,
  "goodsReceiptLineId" TEXT NOT NULL,
  "purchaseOrderLineId" TEXT,
  "kind" "PharmacyReceivingExceptionKind" NOT NULL,
  "status" "PharmacyReceivingExceptionStatus" NOT NULL DEFAULT 'OPEN',
  "detail" TEXT NOT NULL,
  -- Quantity terms for SHORTAGE/OVERAGE/DAMAGE, money terms for a price
  -- conflict; a pack conflict states both pack sizes as quantities.
  "expectedUnits" INTEGER,
  "observedUnits" INTEGER,
  "expectedMinor" INTEGER,
  "observedMinor" INTEGER,
  "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedByUserId" TEXT,
  "resolutionNote" TEXT,
  CONSTRAINT "pharmacy_rex_branch_check" CHECK (length(btrim("branchId")) > 0),
  CONSTRAINT "pharmacy_rex_detail_check" CHECK (length(btrim("detail")) > 0),
  -- Resolution is evidence or it has not happened: an exception cannot be
  -- closed without an actor and a note.
  CONSTRAINT "pharmacy_rex_resolution_check" CHECK (
    ("status" = 'OPEN' AND "resolvedAt" IS NULL AND "resolvedByUserId" IS NULL
       AND "resolutionNote" IS NULL)
    OR
    ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL
       AND length(btrim(COALESCE("resolvedByUserId", ''))) > 0
       AND length(btrim(COALESCE("resolutionNote", ''))) > 0)
  ),
  CONSTRAINT "pharmacy_rex_org_id_key" UNIQUE ("organizationId", "id"),
  -- One exception of a kind per receipt line: re-posting cannot multiply the
  -- same shortage into a queue nobody can clear.
  CONSTRAINT "pharmacy_rex_org_line_kind_key" UNIQUE ("organizationId", "goodsReceiptLineId", "kind"),
  CONSTRAINT "pharmacy_rex_receipt_fkey"
    FOREIGN KEY ("organizationId", "branchId", "goodsReceiptId") REFERENCES "pharmacy_goods_receipts"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_rex_line_fkey"
    FOREIGN KEY ("organizationId", "branchId", "goodsReceiptLineId") REFERENCES "pharmacy_goods_receipt_lines"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_rex_order_line_fkey"
    FOREIGN KEY ("organizationId", "purchaseOrderLineId") REFERENCES "pharmacy_purchase_order_lines"("organizationId", "id") ON DELETE RESTRICT
);
-- The index the "visible until resolved" queue is read through.
CREATE INDEX "pharmacy_rex_org_branch_status_idx" ON "pharmacy_receiving_exceptions"("organizationId", "branchId", "status", "raisedAt");
CREATE INDEX "pharmacy_rex_org_receipt_idx" ON "pharmacy_receiving_exceptions"("organizationId", "goodsReceiptId");

-- ── Reversal: linked movements, never an edit ───────────────────────────────
--
-- PUR-04 acceptance ("reversal creates linked movements/postings") and §8A
-- invariant 8. The ledger is already append-only; what was missing was the
-- link, so that a compensating movement is provably the reversal of one
-- specific posting rather than an unexplained negative adjustment.
ALTER TABLE "pharmacy_stock_movements"
  ADD CONSTRAINT "pharmacy_stock_movements_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_stock_movements" ADD COLUMN "reversesMovementId" TEXT;
ALTER TABLE "pharmacy_stock_movements"
  ADD CONSTRAINT "pharmacy_stock_movements_reverses_fkey"
  FOREIGN KEY ("organizationId", "reversesMovementId") REFERENCES "pharmacy_stock_movements"("organizationId", "id") ON DELETE RESTRICT;
-- A posting is reversed at most once; a second reversal would double-count.
CREATE UNIQUE INDEX "pharmacy_stock_movements_reverses_once_idx"
  ON "pharmacy_stock_movements"("organizationId", "reversesMovementId")
  WHERE "reversesMovementId" IS NOT NULL;

/*
 * A reversal must be the exact negation of the posting it names, in the same
 * lot, location and disposition. Anything else is a new movement with a
 * borrowed justification, so it is refused rather than accepted and explained.
 */
CREATE FUNCTION pharmacy_assert_reversal_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original record;
BEGIN
  IF NEW."reversesMovementId" IS NULL THEN RETURN NEW; END IF;
  IF NEW."reversesMovementId" = NEW."id" THEN
    RAISE EXCEPTION 'a stock movement cannot reverse itself' USING ERRCODE = '23514';
  END IF;

  SELECT "inventoryLotId", "stockLocationId", "disposition", "quantityUnits",
         "sealedPackDelta", "looseUnitDelta", "reversesMovementId"
    INTO original
    FROM "pharmacy_stock_movements"
   WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."reversesMovementId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a reversal must name a movement in its own tenant' USING ERRCODE = '23514';
  END IF;
  IF original."reversesMovementId" IS NOT NULL THEN
    RAISE EXCEPTION 'a reversal cannot itself be reversed' USING ERRCODE = '23514';
  END IF;
  IF NEW."inventoryLotId" IS DISTINCT FROM original."inventoryLotId"
     OR NEW."stockLocationId" IS DISTINCT FROM original."stockLocationId"
     OR NEW."disposition" IS DISTINCT FROM original."disposition" THEN
    RAISE EXCEPTION 'a reversal must post to the same lot, location and disposition' USING ERRCODE = '23514';
  END IF;
  IF NEW."quantityUnits" <> -original."quantityUnits"
     OR NEW."sealedPackDelta" <> -original."sealedPackDelta"
     OR NEW."looseUnitDelta" <> -original."looseUnitDelta" THEN
    RAISE EXCEPTION 'a reversal must be the exact negation of the movement it reverses' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_stock_movement_reversal BEFORE INSERT ON "pharmacy_stock_movements"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_reversal_movement();

-- ── Receiving enforcement ───────────────────────────────────────────────────

/*
 * PUR-04: rejected goods never enter available stock. The disposition split is
 * a CHECK on the line; what a CHECK cannot see is the KIND of the location the
 * rejected units are sent to, so it is verified here — a "quarantine" location
 * that is really the dispensing shelf would defeat the whole rule.
 */
CREATE FUNCTION pharmacy_assert_receipt_line_locations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE location_branch text; quarantine_kind "PharmacyStockLocationKind"; lot_branch text;
BEGIN
  SELECT "branchId" INTO location_branch FROM "pharmacy_stock_locations"
   WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."stockLocationId";
  IF location_branch IS DISTINCT FROM NEW."branchId" THEN
    RAISE EXCEPTION 'a receipt line must name a stock location in its own branch' USING ERRCODE = '23514';
  END IF;

  IF NEW."quarantineLocationId" IS NOT NULL THEN
    SELECT "branchId", "kind" INTO location_branch, quarantine_kind
      FROM "pharmacy_stock_locations"
     WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."quarantineLocationId";
    IF location_branch IS DISTINCT FROM NEW."branchId" THEN
      RAISE EXCEPTION 'a receipt line must name a quarantine location in its own branch' USING ERRCODE = '23514';
    END IF;
    IF quarantine_kind NOT IN ('QUARANTINE','RETURNS') THEN
      RAISE EXCEPTION 'rejected goods must be sent to a quarantine or returns location' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."inventoryLotId" IS NOT NULL THEN
    SELECT "branchId" INTO lot_branch FROM "pharmacy_inventory_lots"
     WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."inventoryLotId";
    IF lot_branch IS DISTINCT FROM NEW."branchId" THEN
      RAISE EXCEPTION 'a receipt line must name a lot in its own branch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_goods_receipt_line_locations
BEFORE INSERT OR UPDATE ON "pharmacy_goods_receipt_lines"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_receipt_line_locations();

/*
 * PUR-02 acceptance, fail closed: "stock is not saleable without batch, expiry,
 * invoice/warranty, pack conversion, MRP and authorized supplier". Batch,
 * expiry, MRP and pack conversion are NOT NULL CHECKs on the line and invoice
 * and warranty evidence are NOT NULL CHECKs on the header, so what remains for
 * the moment of posting is the supplier — authorization and licensing can lapse
 * between drafting a receipt and posting it — and the fact that there is
 * anything to post at all.
 *
 * PUR-05 parity: the direct path reaches this trigger by exactly the same
 * route. It is excused the purchase order and nothing else.
 */
CREATE FUNCTION pharmacy_assert_goods_receipt_postable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE supplier_authorized boolean; order_status "PharmacyPurchaseOrderStatus"; line_count integer;
BEGIN
  IF NEW."status" <> 'POSTED' THEN RETURN NEW; END IF;

  SELECT "authorized" INTO supplier_authorized FROM "pharmacy_suppliers"
   WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."supplierId";
  IF supplier_authorized IS NULL THEN
    RAISE EXCEPTION 'supplier does not belong to this pharmacy' USING ERRCODE = '23514';
  END IF;
  IF supplier_authorized IS NOT TRUE THEN
    RAISE EXCEPTION 'supplier is not authorized to supply this pharmacy' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "pharmacy_supplier_licences"
     WHERE "organizationId" = NEW."organizationId" AND "supplierId" = NEW."supplierId"
       AND "verifiedAt" IS NOT NULL AND "expiresAt" >= CURRENT_TIMESTAMP
  ) THEN
    RAISE EXCEPTION 'supplier has no unexpired verified licence on file' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::int INTO line_count FROM "pharmacy_goods_receipt_lines"
   WHERE "organizationId" = NEW."organizationId" AND "goodsReceiptId" = NEW."id";
  IF line_count = 0 THEN
    RAISE EXCEPTION 'a goods receipt cannot be posted with no lines' USING ERRCODE = '23514';
  END IF;

  -- Goods can only be received against an order that has actually been sent.
  IF NEW."purchaseOrderId" IS NOT NULL THEN
    SELECT "status" INTO order_status FROM "pharmacy_purchase_orders"
     WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."purchaseOrderId";
    IF order_status NOT IN ('SENT','RECEIVING') THEN
      RAISE EXCEPTION 'a goods receipt can only be posted against a sent purchase order' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_goods_receipt_postable
BEFORE INSERT OR UPDATE OF "status", "supplierId" ON "pharmacy_goods_receipts"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_goods_receipt_postable();

-- DRAFT → POSTED → REVERSED, with cancellation available only while the receipt
-- has posted nothing. A posted receipt is corrected by reversal, never by
-- being moved back to DRAFT (§8A invariant 8).
CREATE FUNCTION pharmacy_assert_goods_receipt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN RETURN NEW; END IF;
  IF NOT (
    (OLD."status" = 'DRAFT'  AND NEW."status" IN ('POSTED','CANCELLED')) OR
    (OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED')
  ) THEN
    RAISE EXCEPTION 'goods receipt cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_goods_receipt_status_machine
BEFORE UPDATE OF "status" ON "pharmacy_goods_receipts"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_goods_receipt_transition();

/*
 * What arrived is settled at posting. Afterwards the line is history: only the
 * lot stamp written by the posting itself may still change, and the quantities,
 * batch, expiry, MRP and prices the lot was built from cannot be rewritten
 * under it (§8A invariant 8). A mistake is corrected by reversing the receipt.
 */
CREATE FUNCTION pharmacy_assert_receipt_line_settled() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_status "PharmacyGoodsReceiptStatus";
BEGIN
  SELECT "status" INTO receipt_status FROM "pharmacy_goods_receipts"
   WHERE "organizationId" = OLD."organizationId" AND "id" = OLD."goodsReceiptId";
  IF receipt_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'a posted goods receipt line cannot be edited; reverse the receipt instead' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_goods_receipt_line_settled
BEFORE UPDATE ON "pharmacy_goods_receipt_lines"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_receipt_line_settled();

/*
 * PUR-04: "exceptions remain visible until resolved". An exception may be
 * closed — with an actor and a note — and nothing else about it may be
 * rewritten, so a shortage cannot be turned into a smaller shortage, or into a
 * different kind, on its way to being closed.
 */
CREATE FUNCTION pharmacy_assert_exception_resolution_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."goodsReceiptId" IS DISTINCT FROM OLD."goodsReceiptId"
     OR NEW."goodsReceiptLineId" IS DISTINCT FROM OLD."goodsReceiptLineId"
     OR NEW."purchaseOrderLineId" IS DISTINCT FROM OLD."purchaseOrderLineId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."detail" IS DISTINCT FROM OLD."detail"
     OR NEW."expectedUnits" IS DISTINCT FROM OLD."expectedUnits"
     OR NEW."observedUnits" IS DISTINCT FROM OLD."observedUnits"
     OR NEW."expectedMinor" IS DISTINCT FROM OLD."expectedMinor"
     OR NEW."observedMinor" IS DISTINCT FROM OLD."observedMinor"
     OR NEW."raisedAt" IS DISTINCT FROM OLD."raisedAt" THEN
    RAISE EXCEPTION 'a receiving exception may only be resolved, not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'RESOLVED' AND NEW."status" <> 'RESOLVED' THEN
    RAISE EXCEPTION 'a resolved receiving exception cannot be reopened' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_receiving_exception_resolution_only
BEFORE UPDATE ON "pharmacy_receiving_exceptions"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_exception_resolution_only();

-- §8A invariant 8: a receipt, its lines and its exceptions are never hard-deleted.
CREATE TRIGGER pharmacy_goods_receipts_no_delete BEFORE DELETE ON "pharmacy_goods_receipts"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_goods_receipt_lines_no_delete BEFORE DELETE ON "pharmacy_goods_receipt_lines"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_receiving_exceptions_no_delete BEFORE DELETE ON "pharmacy_receiving_exceptions"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();

-- ── Row level security (NFR-03) ─────────────────────────────────────────────
--
-- The same tenant-plus-optional-branch policy the PH-INV ledger tables carry:
-- organization is the boundary, and a branch-scoped session cannot reach
-- another branch's receipts even by naming their ids directly (PLAT-04).
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pharmacy_goods_receipts','pharmacy_goods_receipt_lines','pharmacy_receiving_exceptions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_branch_isolation ON %I USING (%s) WITH CHECK (%s)',
      table_name,
      'current_setting(''app.is_platform_admin'', true) = ''true'' OR ('
        || '"organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') '
        || 'AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL '
        || 'OR "branchId" = current_setting(''app.current_branch_id'', true)))',
      'current_setting(''app.is_platform_admin'', true) = ''true'' OR ('
        || '"organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') '
        || 'AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL '
        || 'OR "branchId" = current_setting(''app.current_branch_id'', true)))'
    );
  END LOOP;
END $$;
