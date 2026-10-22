CREATE TYPE "PharmacyVoucherStatus" AS ENUM ('ISSUED','REDEEMED','EXPIRED','VOID');
CREATE TYPE "PharmacyVoucherScope" AS ENUM ('WHOLE_BASKET','NON_DRUG_ONLY');

CREATE TABLE pharmacy_loyalty_settings (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "voucherScope" "PharmacyVoucherScope" NOT NULL DEFAULT 'WHOLE_BASKET',
  "voucherValidityDays" INTEGER NOT NULL DEFAULT 30 CHECK ("voucherValidityDays" BETWEEN 1 AND 3650),
  "maxIssuedPerCustomerPerPeriod" INTEGER NOT NULL DEFAULT 5 CHECK ("maxIssuedPerCustomerPerPeriod" >= 0),
  "maxIssuedPerPhonePerPeriod" INTEGER NOT NULL DEFAULT 5 CHECK ("maxIssuedPerPhonePerPeriod" >= 0),
  "maxRedeemedPerCustomerPerPeriod" INTEGER NOT NULL DEFAULT 5 CHECK ("maxRedeemedPerCustomerPerPeriod" >= 0),
  "maxRedeemedPerPhonePerPeriod" INTEGER NOT NULL DEFAULT 5 CHECK ("maxRedeemedPerPhonePerPeriod" >= 0),
  "abusePeriodDays" INTEGER NOT NULL DEFAULT 30 CHECK ("abusePeriodDays" BETWEEN 1 AND 3650),
  "expiryOverrideGraceDays" INTEGER NOT NULL DEFAULT 0 CHECK ("expiryOverrideGraceDays" BETWEEN 0 AND 365),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId"), UNIQUE ("organizationId",id)
);
CREATE TABLE pharmacy_loyalty_settings_audits (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "actorId" TEXT NOT NULL, "oldValue" JSONB NOT NULL, "newValue" JSONB NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId",id)
);
CREATE INDEX pharmacy_loyalty_settings_audits_org_time_idx ON pharmacy_loyalty_settings_audits("organizationId","occurredAt");

CREATE TABLE pharmacy_vouchers (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, code TEXT NOT NULL, "valueMinor" INTEGER NOT NULL CHECK ("valueMinor" > 0),
  status "PharmacyVoucherStatus" NOT NULL DEFAULT 'ISSUED', scope "PharmacyVoucherScope" NOT NULL DEFAULT 'WHOLE_BASKET',
  "customerId" TEXT, phone TEXT, "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL, "minNextBasketMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("minNextBasketMinor" >= 0),
  "redeemedAt" TIMESTAMP(3), "redeemedSaleId" TEXT, "issuedByActorId" TEXT NOT NULL, "redeemedByActorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId",code), UNIQUE ("organizationId",id),
  UNIQUE ("organizationId","branchId",id), UNIQUE ("organizationId","redeemedSaleId"),
  CONSTRAINT pharmacy_vouchers_branch_fk FOREIGN KEY ("organizationId","branchId")
    REFERENCES pharmacy_branches("organizationId",id) ON DELETE RESTRICT,
  CONSTRAINT pharmacy_vouchers_redeemed_sale_fk FOREIGN KEY ("organizationId","branchId","redeemedSaleId")
    REFERENCES pharmacy_sales("organizationId","branchId",id) ON DELETE RESTRICT,
  CHECK (char_length(code) >= 10), CHECK (code !~ '[0O1IL]'),
  CONSTRAINT pharmacy_vouchers_state_check CHECK (
    (status = 'REDEEMED' AND "redeemedAt" IS NOT NULL AND "redeemedSaleId" IS NOT NULL AND "redeemedByActorId" IS NOT NULL)
    OR (status <> 'REDEEMED' AND "redeemedAt" IS NULL AND "redeemedSaleId" IS NULL AND "redeemedByActorId" IS NULL)
  )
);
CREATE INDEX pharmacy_vouchers_status_idx ON pharmacy_vouchers("organizationId","branchId",status,"expiresAt");
CREATE INDEX pharmacy_vouchers_customer_idx ON pharmacy_vouchers("organizationId","customerId","issuedAt");
CREATE INDEX pharmacy_vouchers_phone_idx ON pharmacy_vouchers("organizationId",phone,"issuedAt");

CREATE TABLE pharmacy_voucher_override_audits (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "voucherId" TEXT NOT NULL, "saleId" TEXT NOT NULL, "actorId" TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0), violations JSONB NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE ("organizationId",id),
  CONSTRAINT pharmacy_voucher_override_voucher_fk FOREIGN KEY ("organizationId","branchId","voucherId")
    REFERENCES pharmacy_vouchers("organizationId","branchId",id) ON DELETE RESTRICT,
  CONSTRAINT pharmacy_voucher_override_sale_fk FOREIGN KEY ("organizationId","branchId","saleId")
    REFERENCES pharmacy_sales("organizationId","branchId",id) ON DELETE RESTRICT
);
CREATE INDEX pharmacy_voucher_override_audits_lookup_idx ON pharmacy_voucher_override_audits("organizationId","branchId","voucherId","occurredAt");

-- Durable whole-operation replay record. The unique key is tenant scoped and the composite
-- references prevent a replay result from being attached to another branch's voucher or sale.
CREATE TABLE pharmacy_voucher_redemptions (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "saleId" TEXT NOT NULL, "voucherId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL CHECK (length(btrim("idempotencyKey")) > 0),
  "tenderId" TEXT NOT NULL, "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
  scope "PharmacyVoucherScope" NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId",id), UNIQUE ("organizationId","idempotencyKey"),
  CONSTRAINT pharmacy_voucher_redemption_voucher_fk FOREIGN KEY ("organizationId","branchId","voucherId")
    REFERENCES pharmacy_vouchers("organizationId","branchId",id) ON DELETE RESTRICT,
  CONSTRAINT pharmacy_voucher_redemption_sale_fk FOREIGN KEY ("organizationId","branchId","saleId")
    REFERENCES pharmacy_sales("organizationId","branchId",id) ON DELETE RESTRICT
);

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['pharmacy_loyalty_settings','pharmacy_loyalty_settings_audits','pharmacy_vouchers','pharmacy_voucher_override_audits','pharmacy_voucher_redemptions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))',t);
END LOOP; END $$;
