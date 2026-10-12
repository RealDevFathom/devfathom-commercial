-- WHA-450: append-only relational tax refund allocation authority.
-- Legacy/v0 evidence remains readable; no tax reversal fact is inferred.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "restaurant_tax_tender_allocation_snapshots" a
    LEFT JOIN "restaurant_tax_transaction_snapshots" s
      ON (s."organizationId",s."id",s."billId") = (a."organizationId",a."snapshotId",a."billId")
    LEFT JOIN "restaurant_tax_rate_bucket_snapshots" b
      ON (b."organizationId",b."snapshotId",b."id") = (a."organizationId",a."snapshotId",a."rateBucketSnapshotId")
    LEFT JOIN "restaurant_tenders" t
      ON (t."organizationId",t."billId",t."id",t."type") = (a."organizationId",a."billId",a."originalTenderId",a."paymentCategory")
    WHERE s."id" IS NULL OR b."id" IS NULL OR t."id" IS NULL OR a."cents" <= 0
  ) THEN
    RAISE EXCEPTION 'tax refund allocation preflight: orphan, cross-key, or nonpositive original allocation' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "restaurant_tax_tender_allocation_snapshots"
    GROUP BY "organizationId","billId","originalTenderId","paymentCategory","snapshotId","rateBucketSnapshotId","id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'tax refund allocation preflight: duplicate original allocation composite' USING ERRCODE='23505';
  END IF;
END $$;

CREATE UNIQUE INDEX "restaurant_refunds_org_bill_tender_id_key"
  ON "restaurant_refunds"("organizationId","billId","originalTenderId","id");
CREATE UNIQUE INDEX "restaurant_tax_tender_allocation_refund_key"
  ON "restaurant_tax_tender_allocation_snapshots"(
    "organizationId","billId","originalTenderId","paymentCategory",
    "snapshotId","rateBucketSnapshotId","id"
  );

ALTER TABLE "restaurant_refunds" ADD COLUMN "fullReversalSnapshotId" TEXT;
CREATE UNIQUE INDEX "restaurant_refunds_full_reversal_snapshot_key"
  ON "restaurant_refunds"("fullReversalSnapshotId") WHERE "fullReversalSnapshotId" IS NOT NULL;
CREATE UNIQUE INDEX "restaurant_refunds_org_bill_full_reversal_key"
  ON "restaurant_refunds"("organizationId","billId","fullReversalSnapshotId");
ALTER TABLE "restaurant_refunds"
  ADD CONSTRAINT "restaurant_refund_full_reversal_snapshot_fkey"
  FOREIGN KEY ("organizationId","billId","fullReversalSnapshotId")
  REFERENCES "restaurant_tax_transaction_snapshots"("organizationId","billId","id")
  ON DELETE RESTRICT;

CREATE TABLE "restaurant_tax_refund_allocations" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "billId" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  "originalTenderId" TEXT NOT NULL,
  "paymentCategory" "RestaurantTenderType" NOT NULL,
  "originalSnapshotId" TEXT NOT NULL,
  "originalRateBucketSnapshotId" TEXT NOT NULL,
  "originalTenderAllocationId" TEXT NOT NULL,
  "cents" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_tax_refund_allocation_positive_cents_ck" CHECK ("cents" > 0),
  CONSTRAINT "restaurant_tax_refund_allocation_refund_fkey"
    FOREIGN KEY ("organizationId","billId","originalTenderId","refundId")
    REFERENCES "restaurant_refunds"("organizationId","billId","originalTenderId","id") ON DELETE RESTRICT,
  CONSTRAINT "restaurant_tax_refund_allocation_original_fkey"
    FOREIGN KEY ("organizationId","billId","originalTenderId","paymentCategory","originalSnapshotId","originalRateBucketSnapshotId","originalTenderAllocationId")
    REFERENCES "restaurant_tax_tender_allocation_snapshots"("organizationId","billId","originalTenderId","paymentCategory","snapshotId","rateBucketSnapshotId","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "restaurant_tax_refund_allocation_replay_key"
  ON "restaurant_tax_refund_allocations"("refundId","originalTenderAllocationId");
CREATE INDEX "restaurant_tax_refund_allocation_org_idx" ON "restaurant_tax_refund_allocations"("organizationId");
CREATE INDEX "restaurant_tax_refund_allocation_original_idx" ON "restaurant_tax_refund_allocations"("originalTenderAllocationId");

CREATE FUNCTION "guard_tax_refund_allocation_cap"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_cents BIGINT; refunded_cents NUMERIC;
BEGIN
  SELECT "cents" INTO original_cents
  FROM "restaurant_tax_tender_allocation_snapshots"
  WHERE "id"=NEW."originalTenderAllocationId"
    AND "organizationId"=NEW."organizationId"
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tax refund allocation original fact unavailable' USING ERRCODE='23503';
  END IF;
  SELECT COALESCE(sum("cents"),0) INTO refunded_cents
  FROM "restaurant_tax_refund_allocations"
  WHERE "originalTenderAllocationId"=NEW."originalTenderAllocationId";
  IF refunded_cents > original_cents THEN
    RAISE EXCEPTION 'cumulative tax refund cents exceed original allocation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "restaurant_tax_refund_allocation_cap"
  AFTER INSERT ON "restaurant_tax_refund_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "guard_tax_refund_allocation_cap"();

CREATE TRIGGER "restaurant_tax_refund_allocation_immutable"
  BEFORE UPDATE OR DELETE ON "restaurant_tax_refund_allocations"
  FOR EACH ROW EXECUTE FUNCTION reject_tax_immutable_mutation();

CREATE FUNCTION "guard_refund_full_reversal_link"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reversal_target TEXT; original_count BIGINT; matched_count BIGINT;
BEGIN
  IF OLD."fullReversalSnapshotId" IS NOT NULL
     OR NEW."fullReversalSnapshotId" IS NULL
     OR NEW."fullReversalSnapshotId" = OLD."fullReversalSnapshotId"
     OR (to_jsonb(NEW) - 'fullReversalSnapshotId') <> (to_jsonb(OLD) - 'fullReversalSnapshotId') THEN
    RAISE EXCEPTION 'refund full reversal link may only transition NULL to id once' USING ERRCODE='55000';
  END IF;
  SELECT "reversesSnapshotId" INTO reversal_target
  FROM "restaurant_tax_transaction_snapshots"
  WHERE ("organizationId","billId","id")=(NEW."organizationId",NEW."billId",NEW."fullReversalSnapshotId");
  IF reversal_target IS NULL THEN
    RAISE EXCEPTION 'full reversal snapshot must reverse an original snapshot' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "restaurant_tax_refund_allocations" WHERE "refundId"=NEW."id" AND "originalSnapshotId"<>reversal_target) THEN
    RAISE EXCEPTION 'full reversal link targets the wrong original snapshot' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO original_count FROM "restaurant_tax_tender_allocation_snapshots"
    WHERE "organizationId"=NEW."organizationId" AND "billId"=NEW."billId" AND "snapshotId"=reversal_target;
  SELECT count(*) INTO matched_count
  FROM "restaurant_tax_tender_allocation_snapshots" a
  JOIN "restaurant_tax_refund_allocations" r ON r."originalTenderAllocationId"=a."id"
  WHERE r."refundId"=NEW."id" AND r."cents"=a."cents";
  IF original_count=0 OR matched_count<>original_count THEN
    RAISE EXCEPTION 'full reversal refund must alone exhaust every original allocation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "restaurant_refund_full_reversal_link_guard"
  BEFORE UPDATE ON "restaurant_refunds"
  FOR EACH ROW EXECUTE FUNCTION "guard_refund_full_reversal_link"();

ALTER TABLE "restaurant_refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_refunds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tax_full_reversal_link_update" ON "restaurant_refunds" FOR UPDATE
  USING (current_setting('app.is_platform_admin', true)='true' OR "organizationId"=NULLIF(current_setting('app.current_organization_id', true),''))
  WITH CHECK (current_setting('app.is_platform_admin', true)='true' OR "organizationId"=NULLIF(current_setting('app.current_organization_id', true),''));

ALTER TABLE "restaurant_tax_refund_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_tax_refund_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_tax_refund_allocation_select" ON "restaurant_tax_refund_allocations" FOR SELECT
  USING (current_setting('app.is_platform_admin', true)='true' OR "organizationId"=NULLIF(current_setting('app.current_organization_id', true),''));
CREATE POLICY "restaurant_tax_refund_allocation_insert" ON "restaurant_tax_refund_allocations" FOR INSERT
  WITH CHECK (current_setting('app.is_platform_admin', true)='true' OR "organizationId"=NULLIF(current_setting('app.current_organization_id', true),''));
