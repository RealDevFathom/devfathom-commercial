BEGIN;

-- DEV-27: vouchers are stored records that carry their eligible-category
-- allowlist. A voucher only ever applies to non-drug goods; the POS refuses it
-- on Rx, OTC drug, supplement and medical-device lines on the server.
ALTER TYPE "PharmacyDiscountKind" ADD VALUE IF NOT EXISTS 'VOUCHER';

CREATE TABLE IF NOT EXISTS "pharmacy_vouchers" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "discountMinor" INTEGER NOT NULL,
  "eligibleCategories" TEXT[] NOT NULL DEFAULT ARRAY['NON_DRUG']::TEXT[],
  "active" BOOLEAN NOT NULL DEFAULT true,
  "validUntil" TIMESTAMP(3),
  "issuedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_vouchers_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_vouchers_org_branch_code_key" UNIQUE ("organizationId", "branchId", "code"),
  CONSTRAINT "pharmacy_vouchers_discount_positive" CHECK ("discountMinor" > 0),
  CONSTRAINT "pharmacy_vouchers_code_present" CHECK (btrim("code") <> '' AND btrim("name") <> ''),
  -- Drug categories can never be allowlisted.
  CONSTRAINT "pharmacy_vouchers_non_drug_only" CHECK (
    cardinality("eligibleCategories") > 0
    AND "eligibleCategories" <@ ARRAY['NON_DRUG']::TEXT[]
  ),
  CONSTRAINT "pharmacy_vouchers_body_no_medicine" CHECK (
    "body" !~* '(prescription|condition|allerg|medicine|diagnos|patient|drug|rx)'
  )
);

ALTER TABLE "pharmacy_sale_lines" ADD COLUMN IF NOT EXISTS "voucherId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'pharmacy_sale_lines_voucher_fkey'
  ) THEN
    ALTER TABLE "pharmacy_sale_lines"
      ADD CONSTRAINT "pharmacy_sale_lines_voucher_fkey"
      FOREIGN KEY ("organizationId", "voucherId")
      REFERENCES "pharmacy_vouchers"("organizationId", "id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'pharmacy_sale_lines_voucher_kind'
  ) THEN
    ALTER TABLE "pharmacy_sale_lines"
      ADD CONSTRAINT "pharmacy_sale_lines_voucher_kind"
      -- Compared as text: a new enum value cannot be used in the transaction that adds it.
      CHECK (("voucherId" IS NULL) = ("discountKind"::text IS DISTINCT FROM 'VOUCHER'));
  END IF;
END $$;

ALTER TABLE "pharmacy_vouchers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_vouchers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_vouchers";
CREATE POLICY tenant_branch_isolation ON "pharmacy_vouchers"
  USING (
    (current_setting('app.is_platform_admin', true) = 'true')
    OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
        OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), '')
      )
    )
  )
  WITH CHECK (
    (current_setting('app.is_platform_admin', true) = 'true')
    OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
        OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), '')
      )
    )
  );

COMMIT;
