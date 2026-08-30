CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "restaurant_service_charge_policy_versions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "rate" DECIMAL(9,6) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3) NOT NULL,
  "acknowledgementRef" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "endIdempotencyKey" TEXT,
  "endPayloadHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_service_charge_policy_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_service_charge_policy_rate_check" CHECK ("rate" > 0 AND "rate" <= 1),
  CONSTRAINT "restaurant_service_charge_policy_interval_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
  CONSTRAINT "restaurant_service_charge_policy_ack_check" CHECK (length(btrim("acknowledgementRef")) > 0),
  CONSTRAINT "restaurant_service_charge_policy_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "restaurant_service_charge_policy_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "restaurant_service_charge_policy_org_idem_key" UNIQUE ("organizationId", "idempotencyKey"),
  CONSTRAINT "restaurant_service_charge_policy_org_end_idem_key" UNIQUE ("organizationId", "endIdempotencyKey"),
  CONSTRAINT "restaurant_service_charge_policy_no_overlap" EXCLUDE USING gist (
    "organizationId" WITH =,
    "branchId" WITH =,
    tsrange("effectiveFrom", "effectiveTo", '[)') WITH &&
  )
);
CREATE INDEX "restaurant_service_charge_policy_org_idx" ON "restaurant_service_charge_policy_versions"("organizationId");
CREATE INDEX "restaurant_service_charge_policy_branch_effective_idx" ON "restaurant_service_charge_policy_versions"("branchId", "effectiveFrom");

ALTER TABLE "restaurant_orders" ADD COLUMN "serviceChargePolicyVersionId" TEXT;
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_service_charge_policy_fkey"
  FOREIGN KEY ("organizationId", "serviceChargePolicyVersionId")
  REFERENCES "restaurant_service_charge_policy_versions"("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "restaurant_bills"
  ADD COLUMN "serviceChargePolicyVersionId" TEXT,
  ADD COLUMN "serviceChargeRate" DECIMAL(9,6),
  ADD COLUMN "serviceChargeBasis" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "serviceChargeTaxTreatment" VARCHAR(24);
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_service_charge_policy_fkey"
  FOREIGN KEY ("organizationId", "serviceChargePolicyVersionId")
  REFERENCES "restaurant_service_charge_policy_versions"("organizationId", "id") ON DELETE RESTRICT;
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_service_charge_evidence_check" CHECK (
  ("serviceChargeTotal" = 0 AND "serviceChargeBasis" = 0 AND "serviceChargePolicyVersionId" IS NULL AND "serviceChargeRate" IS NULL AND "serviceChargeTaxTreatment" IS NULL)
  OR
  ("serviceChargeTotal" >= 0 AND "serviceChargeBasis" > 0 AND "serviceChargePolicyVersionId" IS NOT NULL AND "serviceChargeRate" > 0 AND "serviceChargeRate" <= 1 AND "serviceChargeTaxTreatment" = 'NON_TAXABLE')
);

ALTER TABLE "restaurant_refunds"
  ADD COLUMN "serviceChargeRefundAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxRefundAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_frozen_refund_amounts_check"
  CHECK ("serviceChargeRefundAmount" >= 0 AND "taxRefundAmount" >= 0 AND "serviceChargeRefundAmount" + "taxRefundAmount" <= "amount");

ALTER TABLE "restaurant_service_charge_policy_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_service_charge_policy_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_service_charge_policy_select" ON "restaurant_service_charge_policy_versions" FOR SELECT
  USING ("organizationId" = current_setting('app.current_organization_id', true));
CREATE POLICY "restaurant_service_charge_policy_insert" ON "restaurant_service_charge_policy_versions" FOR INSERT
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
CREATE POLICY "restaurant_service_charge_policy_update" ON "restaurant_service_charge_policy_versions" FOR UPDATE
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

CREATE OR REPLACE FUNCTION reject_restaurant_service_charge_policy_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."effectiveTo" IS NULL AND NEW."effectiveTo" IS NOT NULL
     AND NEW."effectiveTo" > OLD."effectiveFrom"
     AND (to_jsonb(NEW) - ARRAY['effectiveTo', 'endIdempotencyKey', 'endPayloadHash'])
       = (to_jsonb(OLD) - ARRAY['effectiveTo', 'endIdempotencyKey', 'endPayloadHash']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'restaurant service charge policy versions are immutable';
END $$;
CREATE TRIGGER restaurant_service_charge_policy_immutable
  BEFORE UPDATE OR DELETE ON "restaurant_service_charge_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION reject_restaurant_service_charge_policy_mutation();
