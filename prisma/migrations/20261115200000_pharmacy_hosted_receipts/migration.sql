-- DEV-16: neutral WhatsApp receipt with a tokenized hosted receipt link.
-- Additive and idempotent: one new tenant table under forced tenant and branch
-- RLS, plus two new WhatsApp message-log kinds.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_hosted_receipts" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "rxProtected" BOOLEAN NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "otpHash" TEXT,
  "otpExpiresAt" TIMESTAMP(3),
  "otpSendCount" INTEGER NOT NULL DEFAULT 0,
  "otpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastOtpSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_hosted_receipts_pkey" PRIMARY KEY ("id"),
  -- Only a SHA-256 hex digest is ever stored; the token itself never is.
  CONSTRAINT "pharmacy_hosted_receipts_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pharmacy_hosted_receipts_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "pharmacy_hosted_receipts_otp_counts_check"
    CHECK ("otpSendCount" >= 0 AND "otpFailedAttempts" >= 0),
  CONSTRAINT "pharmacy_hosted_receipts_organization_fkey" FOREIGN KEY ("organizationId")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_hosted_receipts_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId")
    REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_hosted_receipts_customer_fkey" FOREIGN KEY ("organizationId", "customerId")
    REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_hosted_receipts_tokenHash_key"
  ON "pharmacy_hosted_receipts"("tokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_hosted_receipts_org_id_key"
  ON "pharmacy_hosted_receipts"("organizationId", "id");
CREATE INDEX IF NOT EXISTS "pharmacy_hosted_receipts_sale_idx"
  ON "pharmacy_hosted_receipts"("organizationId", "branchId", "saleId");

ALTER TABLE "pharmacy_hosted_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_hosted_receipts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pharmacy_hosted_receipts_tenant_branch" ON "pharmacy_hosted_receipts";
CREATE POLICY "pharmacy_hosted_receipts_tenant_branch" ON "pharmacy_hosted_receipts"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
        "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
        "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  );

-- The WhatsApp kind guard gains the receipt link and its one-time code.
ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT IF EXISTS "pharmacy_message_logs_kind_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_kind_check"
  CHECK ("kind" IN (
    'REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_READY', 'ORDER_REQUEST', 'ORDER_CONFIRMATION',
    'ORDER_FALLBACK', 'OPT_OUT', 'OPT_IN', 'CONSENT_ACK', 'RECEIPT_LINK', 'RECEIPT_OTP'
  ));

COMMIT;
