-- WHA-373: normalized immutable per-tender tax allocation evidence.
-- Existing v0/v1 snapshots remain valid with no allocation rows.

CREATE UNIQUE INDEX "restaurant_tax_buckets_org_snapshot_id_key"
  ON "restaurant_tax_rate_bucket_snapshots"("organizationId", "snapshotId", "id");

CREATE UNIQUE INDEX "restaurant_tenders_org_id_type_key"
  ON "restaurant_tenders"("organizationId", "id", "type");

ALTER TABLE "restaurant_tax_transaction_snapshots" ADD COLUMN "billId" TEXT;
ALTER TABLE "restaurant_tax_transaction_snapshots"
  ADD CONSTRAINT "restaurant_tax_snapshot_bill_fkey"
  FOREIGN KEY ("organizationId", "billId")
  REFERENCES "restaurant_bills"("organizationId", "id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "restaurant_tax_snapshots_org_id_bill_key"
  ON "restaurant_tax_transaction_snapshots"("organizationId", "id", "billId");

CREATE UNIQUE INDEX "restaurant_tenders_org_bill_id_type_key"
  ON "restaurant_tenders"("organizationId", "billId", "id", "type");

CREATE TABLE "restaurant_tax_tender_allocation_snapshots" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL
    DEFAULT current_setting('app.current_organization_id', true),
  "snapshotId" TEXT NOT NULL,
  "billId" TEXT NOT NULL,
  "rateBucketSnapshotId" TEXT NOT NULL,
  "originalTenderId" TEXT NOT NULL,
  "paymentCategory" "RestaurantTenderType" NOT NULL,
  "cents" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_tax_tender_allocation_nonnegative_cents_ck"
    CHECK ("cents" >= 0),
  CONSTRAINT "restaurant_tax_tender_allocation_snapshot_bill_fkey"
    FOREIGN KEY ("organizationId", "snapshotId", "billId")
    REFERENCES "restaurant_tax_transaction_snapshots"("organizationId", "id", "billId")
    ON DELETE RESTRICT,
  CONSTRAINT "restaurant_tax_tender_allocation_bucket_fkey"
    FOREIGN KEY ("organizationId", "snapshotId", "rateBucketSnapshotId")
    REFERENCES "restaurant_tax_rate_bucket_snapshots"("organizationId", "snapshotId", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "restaurant_tax_tender_allocation_tender_bill_category_fkey"
    FOREIGN KEY ("organizationId", "billId", "originalTenderId", "paymentCategory")
    REFERENCES "restaurant_tenders"("organizationId", "billId", "id", "type")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "restaurant_tax_tender_allocation_fact_key"
  ON "restaurant_tax_tender_allocation_snapshots"(
    "snapshotId", "rateBucketSnapshotId", "originalTenderId"
  );
CREATE INDEX "restaurant_tax_tender_allocation_org_idx"
  ON "restaurant_tax_tender_allocation_snapshots"("organizationId");
CREATE INDEX "restaurant_tax_tender_allocation_tender_idx"
  ON "restaurant_tax_tender_allocation_snapshots"("originalTenderId");
CREATE INDEX "restaurant_tax_tender_allocation_snapshot_idx"
  ON "restaurant_tax_tender_allocation_snapshots"("snapshotId");

CREATE TRIGGER "restaurant_tax_tender_allocation_immutable"
  BEFORE UPDATE OR DELETE ON "restaurant_tax_tender_allocation_snapshots"
  FOR EACH ROW EXECUTE FUNCTION reject_tax_immutable_mutation();

ALTER TABLE "restaurant_tax_tender_allocation_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_tax_tender_allocation_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_tax_tender_allocation_tenant"
  ON "restaurant_tax_tender_allocation_snapshots"
  USING (
    "organizationId" = current_setting('app.current_organization_id', true)
  )
  WITH CHECK (
    "organizationId" = current_setting('app.current_organization_id', true)
  );
