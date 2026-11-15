BEGIN;

-- DEV-15 (#762): customer PWA. A staff-minted link names exactly one customer;
-- a one-time code sent to that customer's phone opens a session scoped to that
-- customer. Customer requests (refill, prescription-photo order, khata payment)
-- wait for staff: a prescription order needs a pharmacist's verification.

CREATE TABLE IF NOT EXISTS "pharmacy_customer_portal_links" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "otpHash" TEXT,
  "otpExpiresAt" TIMESTAMP(3),
  "otpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_portal_links_token_key" UNIQUE ("tokenHash"),
  CONSTRAINT "pharmacy_portal_links_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_portal_links_org_branch_id_key" UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_portal_links_attempts_check" CHECK ("otpFailedAttempts" >= 0),
  CONSTRAINT "pharmacy_portal_links_branch_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_portal_links_customer_fkey"
    FOREIGN KEY ("organizationId", "customerId")
    REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_portal_links_creator_fkey"
    FOREIGN KEY ("organizationId", "createdByUserId")
    REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "pharmacy_portal_links_org_customer_idx"
  ON "pharmacy_customer_portal_links"("organizationId", "customerId");

CREATE TABLE IF NOT EXISTS "pharmacy_customer_portal_sessions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "linkId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_portal_sessions_token_key" UNIQUE ("tokenHash"),
  CONSTRAINT "pharmacy_portal_sessions_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_portal_sessions_branch_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_portal_sessions_customer_fkey"
    FOREIGN KEY ("organizationId", "customerId")
    REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_portal_sessions_link_fkey"
    FOREIGN KEY ("organizationId", "branchId", "linkId")
    REFERENCES "pharmacy_customer_portal_links"("organizationId", "branchId", "id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "pharmacy_portal_sessions_org_customer_idx"
  ON "pharmacy_customer_portal_sessions"("organizationId", "customerId");

CREATE TABLE IF NOT EXISTS "pharmacy_customer_portal_requests" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "note" TEXT,
  "prescriptionFileRef" TEXT,
  "refillSaleId" TEXT,
  "familyAccountId" TEXT,
  "amountMinor" INTEGER,
  "payerReference" TEXT,
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "khataReceiptReference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_portal_requests_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_portal_requests_kind_check"
    CHECK ("kind" IN ('REFILL', 'RX_ORDER', 'KHATA_PAYMENT')),
  CONSTRAINT "pharmacy_portal_requests_status_check"
    CHECK ("status" IN ('PENDING', 'VERIFIED', 'REJECTED', 'CANCELLED')),
  -- A prescription order always carries its photo; a refill names a past receipt.
  CONSTRAINT "pharmacy_portal_requests_rx_photo_check"
    CHECK ("kind" <> 'RX_ORDER' OR "prescriptionFileRef" IS NOT NULL),
  CONSTRAINT "pharmacy_portal_requests_refill_check"
    CHECK ("kind" <> 'REFILL' OR "refillSaleId" IS NOT NULL),
  CONSTRAINT "pharmacy_portal_requests_payment_check"
    CHECK (
      "kind" <> 'KHATA_PAYMENT' OR (
        "familyAccountId" IS NOT NULL AND "amountMinor" > 0 AND "payerReference" IS NOT NULL
      )
    ),
  -- Staff decisions are attributable: no verification or rejection without a decider.
  CONSTRAINT "pharmacy_portal_requests_decision_check"
    CHECK (
      "status" NOT IN ('VERIFIED', 'REJECTED') OR
      ("decidedByUserId" IS NOT NULL AND "decidedAt" IS NOT NULL)
    ),
  CONSTRAINT "pharmacy_portal_requests_branch_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_portal_requests_customer_fkey"
    FOREIGN KEY ("organizationId", "customerId")
    REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_portal_requests_sale_fkey"
    FOREIGN KEY ("organizationId", "branchId", "refillSaleId")
    REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_portal_requests_family_fkey"
    FOREIGN KEY ("organizationId", "branchId", "familyAccountId")
    REFERENCES "pharmacy_family_accounts"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_portal_requests_decider_fkey"
    FOREIGN KEY ("organizationId", "decidedByUserId")
    REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "pharmacy_portal_requests_org_customer_idx"
  ON "pharmacy_customer_portal_requests"("organizationId", "customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "pharmacy_portal_requests_org_branch_status_idx"
  ON "pharmacy_customer_portal_requests"("organizationId", "branchId", "status", "createdAt");

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'pharmacy_customer_portal_links',
    'pharmacy_customer_portal_sessions',
    'pharmacy_customer_portal_requests'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies
      WHERE tablename = target AND policyname = 'tenant_branch_isolation'
    ) THEN
      EXECUTE format($policy$
        CREATE POLICY tenant_branch_isolation ON %I
          USING (
            current_setting('app.is_platform_admin', true) = 'true' OR
            (
              "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
              (
                NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
                "branchId" = current_setting('app.current_branch_id', true)
              )
            )
          )
          WITH CHECK (
            current_setting('app.is_platform_admin', true) = 'true' OR
            (
              "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
              (
                NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
                "branchId" = current_setting('app.current_branch_id', true)
              )
            )
          )
      $policy$, target);
    END IF;
  END LOOP;
END;
$$;

COMMIT;
