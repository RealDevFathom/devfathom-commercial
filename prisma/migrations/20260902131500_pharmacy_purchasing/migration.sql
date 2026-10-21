-- PH-PUR — PRD §6.3 PUR-01 (licensed suppliers), PUR-02 (requisition → quotes →
-- PO → approval) and PUR-03 (schemes, bonus units, discounts, rebates, freight,
-- landed cost). Every table below is tenant-scoped with FORCE row-level
-- security from this, its creating migration. Every child row also carries a
-- composite (organizationId, parentId) foreign key, so a cross-tenant id
-- substitution fails in the database and not only in the router.
--
-- Branch scope (PLAT-04): requisitions and purchase orders carry a nullable
-- "branchId" scope column. The pharmacy branch entity itself lands with PLAT-03,
-- so the column has no foreign key yet; organizationId remains the tenant
-- boundary, exactly as elsewhere in this schema.

CREATE TYPE "PharmacyRequisitionStatus" AS ENUM ('DRAFT','SUBMITTED','APPROVED','CANCELLED');
CREATE TYPE "PharmacyPurchaseOrderStatus" AS ENUM ('DRAFT','SUBMITTED','APPROVED','SENT','RECEIVING','CANCELLED');
CREATE TYPE "PharmacyApprovalDecision" AS ENUM ('APPROVED','REJECTED');

CREATE TABLE "pharmacy_suppliers" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "name" TEXT NOT NULL CHECK (length(btrim("name")) > 0), "legalName" TEXT,
  "authorized" BOOLEAN NOT NULL DEFAULT false, "serviceArea" TEXT,
  "contactName" TEXT, "contactPhone" TEXT,
  "paymentTermsDays" INTEGER NOT NULL DEFAULT 0 CHECK ("paymentTermsDays" >= 0),
  "creditLimitMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("creditLimitMinor" >= 0),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId", "id"),
  UNIQUE ("organizationId", "name")
);
CREATE INDEX "pharmacy_suppliers_organizationId_authorized_active_idx" ON "pharmacy_suppliers"("organizationId", "authorized", "active");

CREATE TABLE "pharmacy_supplier_licences" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "supplierId" TEXT NOT NULL,
  "licenceType" TEXT NOT NULL CHECK (length(btrim("licenceType")) > 0),
  "licenceNumber" TEXT NOT NULL CHECK (length(btrim("licenceNumber")) > 0),
  "issuingAuthority" TEXT NOT NULL CHECK (length(btrim("issuingAuthority")) > 0),
  "issuedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "evidenceUri" TEXT, "verifiedAt" TIMESTAMP(3), "verifiedByUserId" TEXT, "supersedesId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"),
  CHECK ("expiresAt" > "issuedAt"),
  FOREIGN KEY ("organizationId", "supplierId") REFERENCES "pharmacy_suppliers"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "supersedesId") REFERENCES "pharmacy_supplier_licences"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_supplier_licences_organizationId_supplierId_expire_idx" ON "pharmacy_supplier_licences"("organizationId", "supplierId", "expiresAt");

CREATE TABLE "pharmacy_requisitions" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT,
  "reference" TEXT NOT NULL CHECK (length(btrim("reference")) > 0),
  "status" "PharmacyRequisitionStatus" NOT NULL DEFAULT 'DRAFT',
  "requestedByUserId" TEXT NOT NULL, "neededBy" TIMESTAMP(3), "note" TEXT,
  "submittedAt" TIMESTAMP(3), "approvedAt" TIMESTAMP(3), "approvedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId", "id"),
  UNIQUE ("organizationId", "reference"),
  -- PUR-02: the requester can never also be the approver.
  CHECK ("approvedByUserId" IS NULL OR "approvedByUserId" <> "requestedByUserId")
);
CREATE INDEX "pharmacy_requisitions_organizationId_status_createdAt_idx" ON "pharmacy_requisitions"("organizationId", "status", "createdAt");

CREATE TABLE "pharmacy_requisition_lines" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "requisitionId" TEXT NOT NULL, "lineNumber" INTEGER NOT NULL CHECK ("lineNumber" > 0),
  "medicineId" TEXT NOT NULL REFERENCES "pharmacy_medicines"("id") ON DELETE RESTRICT,
  "packLevelId" TEXT NOT NULL REFERENCES "pharmacy_pack_levels"("id") ON DELETE RESTRICT,
  "quantityPacks" INTEGER NOT NULL CHECK ("quantityPacks" > 0),
  "canonicalUnitsPerPack" INTEGER NOT NULL CHECK ("canonicalUnitsPerPack" > 0),
  "canonicalUnits" INTEGER NOT NULL CHECK ("canonicalUnits" > 0),
  "note" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"),
  UNIQUE ("organizationId", "requisitionId", "lineNumber"),
  -- Integer canonical units are the projection of packs, never an independent number.
  CHECK ("canonicalUnits" = "quantityPacks" * "canonicalUnitsPerPack"),
  FOREIGN KEY ("organizationId", "requisitionId") REFERENCES "pharmacy_requisitions"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_requisition_lines_organizationId_medicineId_idx" ON "pharmacy_requisition_lines"("organizationId", "medicineId");

CREATE TABLE "pharmacy_quotes" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "requisitionId" TEXT NOT NULL, "supplierId" TEXT NOT NULL, "reference" TEXT,
  "quotedAt" TIMESTAMP(3) NOT NULL, "validUntil" TIMESTAMP(3) NOT NULL, "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"),
  -- One live offer per supplier per requisition; a revision replaces it.
  UNIQUE ("organizationId", "requisitionId", "supplierId"),
  CHECK ("validUntil" >= "quotedAt"),
  FOREIGN KEY ("organizationId", "requisitionId") REFERENCES "pharmacy_requisitions"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "supplierId") REFERENCES "pharmacy_suppliers"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_quotes_organizationId_supplierId_validUntil_idx" ON "pharmacy_quotes"("organizationId", "supplierId", "validUntil");

CREATE TABLE "pharmacy_quote_lines" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "quoteId" TEXT NOT NULL, "requisitionLineId" TEXT NOT NULL,
  "pricePerPackMinor" INTEGER NOT NULL CHECK ("pricePerPackMinor" >= 0),
  "schemeBuyPacks" INTEGER NOT NULL DEFAULT 0 CHECK ("schemeBuyPacks" >= 0),
  "schemeFreePacks" INTEGER NOT NULL DEFAULT 0 CHECK ("schemeFreePacks" >= 0),
  "discountBps" INTEGER NOT NULL DEFAULT 0 CHECK ("discountBps" BETWEEN 0 AND 10000),
  "moqPacks" INTEGER NOT NULL DEFAULT 1 CHECK ("moqPacks" > 0),
  "leadTimeDays" INTEGER NOT NULL DEFAULT 0 CHECK ("leadTimeDays" >= 0),
  "minimumExpiryDays" INTEGER NOT NULL DEFAULT 0 CHECK ("minimumExpiryDays" >= 0),
  "canonicalUnitsPerPack" INTEGER NOT NULL CHECK ("canonicalUnitsPerPack" > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"),
  UNIQUE ("organizationId", "quoteId", "requisitionLineId"),
  -- A "buy n get m free" scheme needs both halves or neither.
  CHECK (("schemeBuyPacks" = 0) = ("schemeFreePacks" = 0)),
  FOREIGN KEY ("organizationId", "quoteId") REFERENCES "pharmacy_quotes"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "requisitionLineId") REFERENCES "pharmacy_requisition_lines"("organizationId", "id") ON DELETE RESTRICT
);

CREATE TABLE "pharmacy_purchase_orders" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT,
  "reference" TEXT NOT NULL CHECK (length(btrim("reference")) > 0),
  "status" "PharmacyPurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "supplierId" TEXT NOT NULL, "requisitionId" TEXT, "quoteId" TEXT,
  "createdByUserId" TEXT NOT NULL, "expectedDeliveryAt" TIMESTAMP(3),
  "freightMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("freightMinor" >= 0),
  "otherChargesMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("otherChargesMinor" >= 0),
  "note" TEXT, "submittedAt" TIMESTAMP(3), "approvedAt" TIMESTAMP(3), "approvedByUserId" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId", "id"),
  UNIQUE ("organizationId", "reference"),
  -- PUR-02: approval by the person who drafted the order is refused in the database too.
  CHECK ("approvedByUserId" IS NULL OR "approvedByUserId" <> "createdByUserId"),
  -- An approved order names its approver; an unapproved one does not.
  CHECK (("approvedAt" IS NULL) = ("approvedByUserId" IS NULL)),
  FOREIGN KEY ("organizationId", "supplierId") REFERENCES "pharmacy_suppliers"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "requisitionId") REFERENCES "pharmacy_requisitions"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "quoteId") REFERENCES "pharmacy_quotes"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_purchase_orders_organizationId_status_createdAt_idx" ON "pharmacy_purchase_orders"("organizationId", "status", "createdAt");
CREATE INDEX "pharmacy_purchase_orders_organizationId_supplierId_status_idx" ON "pharmacy_purchase_orders"("organizationId", "supplierId", "status");

CREATE TABLE "pharmacy_purchase_order_lines" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "purchaseOrderId" TEXT NOT NULL, "lineNumber" INTEGER NOT NULL CHECK ("lineNumber" > 0),
  "medicineId" TEXT NOT NULL REFERENCES "pharmacy_medicines"("id") ON DELETE RESTRICT,
  "packLevelId" TEXT NOT NULL REFERENCES "pharmacy_pack_levels"("id") ON DELETE RESTRICT,
  "orderedPacks" INTEGER NOT NULL CHECK ("orderedPacks" > 0),
  "bonusPacks" INTEGER NOT NULL DEFAULT 0 CHECK ("bonusPacks" >= 0),
  "canonicalUnitsPerPack" INTEGER NOT NULL CHECK ("canonicalUnitsPerPack" > 0),
  "orderedCanonicalUnits" INTEGER NOT NULL CHECK ("orderedCanonicalUnits" > 0),
  "bonusCanonicalUnits" INTEGER NOT NULL DEFAULT 0 CHECK ("bonusCanonicalUnits" >= 0),
  "listPricePerPackMinor" INTEGER NOT NULL CHECK ("listPricePerPackMinor" >= 0),
  "discountBps" INTEGER NOT NULL DEFAULT 0 CHECK ("discountBps" BETWEEN 0 AND 10000),
  "rebateBps" INTEGER NOT NULL DEFAULT 0 CHECK ("rebateBps" BETWEEN 0 AND 10000),
  "taxBps" INTEGER NOT NULL DEFAULT 0 CHECK ("taxBps" BETWEEN 0 AND 10000),
  "taxCreditable" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"),
  UNIQUE ("organizationId", "purchaseOrderId", "lineNumber"),
  -- PUR-03: canonical units are the projection of packs on both the paid and
  -- the free side, so a bonus can only ever add quantity.
  CHECK ("orderedCanonicalUnits" = "orderedPacks" * "canonicalUnitsPerPack"),
  CHECK ("bonusCanonicalUnits" = "bonusPacks" * "canonicalUnitsPerPack"),
  FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "pharmacy_purchase_orders"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_purchase_order_lines_organizationId_medicineId_idx" ON "pharmacy_purchase_order_lines"("organizationId", "medicineId");

CREATE TABLE "pharmacy_purchase_order_approvals" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "purchaseOrderId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL,
  "policy" TEXT NOT NULL CHECK (length(btrim("policy")) > 0),
  "decision" "PharmacyApprovalDecision" NOT NULL,
  "fromStatus" "PharmacyPurchaseOrderStatus" NOT NULL, "toStatus" "PharmacyPurchaseOrderStatus" NOT NULL,
  "reason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"),
  FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "pharmacy_purchase_orders"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_purchase_order_approvals_organizationId_purchaseOr_idx" ON "pharmacy_purchase_order_approvals"("organizationId", "purchaseOrderId", "createdAt");

-- PUR-01/PUR-02: licence evidence and approval events are regulated records.
-- Append-only in the database, so a lapsed licence or a refused approval cannot
-- be edited away after the fact; a correction supersedes instead.
CREATE FUNCTION pharmacy_purchasing_reject_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514'; END $$;
CREATE TRIGGER pharmacy_supplier_licence_append_only BEFORE UPDATE OR DELETE ON "pharmacy_supplier_licences"
FOR EACH ROW EXECUTE FUNCTION pharmacy_purchasing_reject_append_only_change();
CREATE TRIGGER pharmacy_purchase_order_approval_append_only BEFORE UPDATE OR DELETE ON "pharmacy_purchase_order_approvals"
FOR EACH ROW EXECUTE FUNCTION pharmacy_purchasing_reject_append_only_change();

-- PUR-01: refuse a purchase order for a supplier that is not authorized, or has
-- no unexpired verified licence, at the moment the order is raised, approved or
-- sent. The router refuses first with a typed error; this is the backstop that
-- also covers a direct write.
CREATE FUNCTION pharmacy_assert_supplier_orderable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE supplier_authorized boolean;
BEGIN
  IF NEW."status" = 'CANCELLED' THEN RETURN NEW; END IF;
  -- Scoped by tenant, so a supplier id borrowed from another tenant reads as
  -- absent here and is refused before the composite foreign key is even checked.
  SELECT "authorized" INTO supplier_authorized
  FROM "pharmacy_suppliers"
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
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_purchase_order_supplier_licensed
BEFORE INSERT OR UPDATE OF "supplierId", "status" ON "pharmacy_purchase_orders"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_supplier_orderable();

-- PUR-02: the purchase order status machine, enforced on the row itself so that
-- no writer can skip approval on the way to SENT.
CREATE FUNCTION pharmacy_assert_purchase_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN RETURN NEW; END IF;
  IF NOT (
    (OLD."status" = 'DRAFT'     AND NEW."status" IN ('SUBMITTED','CANCELLED')) OR
    (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('APPROVED','DRAFT','CANCELLED')) OR
    (OLD."status" = 'APPROVED'  AND NEW."status" IN ('SENT','CANCELLED')) OR
    (OLD."status" = 'SENT'      AND NEW."status" IN ('RECEIVING','CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'purchase order cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'APPROVED' AND NEW."approvedByUserId" IS NULL THEN
    RAISE EXCEPTION 'an approved purchase order must name its approver' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_purchase_order_status_machine BEFORE UPDATE OF "status" ON "pharmacy_purchase_orders"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_purchase_order_transition();

CREATE FUNCTION pharmacy_assert_requisition_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN RETURN NEW; END IF;
  IF NOT (
    (OLD."status" = 'DRAFT'     AND NEW."status" IN ('SUBMITTED','CANCELLED')) OR
    (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('APPROVED','DRAFT','CANCELLED')) OR
    (OLD."status" = 'APPROVED'  AND NEW."status" = 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'requisition cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_requisition_status_machine BEFORE UPDATE OF "status" ON "pharmacy_requisitions"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_requisition_transition();

-- NFR-03: tenant RLS on every new table from its creating migration, FORCED so
-- that the owning role is subject to it too.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['pharmacy_suppliers','pharmacy_supplier_licences','pharmacy_requisitions','pharmacy_requisition_lines','pharmacy_quotes','pharmacy_quote_lines','pharmacy_purchase_orders','pharmacy_purchase_order_lines','pharmacy_purchase_order_approvals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', table_name);
  END LOOP;
END $$;
