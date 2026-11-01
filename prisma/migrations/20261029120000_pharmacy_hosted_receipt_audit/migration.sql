-- Additive authorization/audit record for revocable hosted pharmacy receipts.
-- Existing sales and databases need no backfill: rows are created only when a link is issued.
CREATE TABLE "pharmacy_hosted_receipts" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "tokenDigest" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "consent" TEXT NOT NULL,
  "consentedAt" TIMESTAMP(3) NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "deliveredAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedByActorId" TEXT,
  "lastAccessedAt" TIMESTAMP(3),
  "accessCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "pharmacy_hosted_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_hosted_receipts_consent_check" CHECK ("consent" IN ('CUSTOMER_REQUEST', 'COUNTER_OPT_IN')),
  CONSTRAINT "pharmacy_hosted_receipts_version_check" CHECK ("version" = 1),
  CONSTRAINT "pharmacy_hosted_receipts_access_count_check" CHECK ("accessCount" >= 0),
  CONSTRAINT "pharmacy_hosted_receipts_expiry_check" CHECK ("expiresAt" > "issuedAt"),
  CONSTRAINT "pharmacy_hosted_receipts_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_hosted_receipts_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_hosted_receipts_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Composite user keys force the issuing and revoking staff into the receipt's tenant.
  CONSTRAINT "pharmacy_hosted_receipts_actor_fkey" FOREIGN KEY ("organizationId", "actorId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_hosted_receipts_revoker_fkey" FOREIGN KEY ("organizationId", "revokedByActorId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pharmacy_hosted_receipts_org_digest_key" ON "pharmacy_hosted_receipts"("organizationId", "tokenDigest");
CREATE INDEX "pharmacy_hosted_receipts_sale_idx" ON "pharmacy_hosted_receipts"("organizationId", "saleId", "issuedAt" DESC);
CREATE INDEX "pharmacy_hosted_receipts_expiry_idx" ON "pharmacy_hosted_receipts"("organizationId", "expiresAt", "revokedAt");

ALTER TABLE "pharmacy_hosted_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_hosted_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_hosted_receipts"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

-- Permit the existing WhatsApp audit log to describe hosted-receipt delivery.
ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT "pharmacy_message_logs_kind_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_kind_check" CHECK ("kind" IN (
  'REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_REQUEST', 'ORDER_CONFIRMATION', 'ORDER_FALLBACK',
  'OPT_OUT', 'OPT_IN', 'CONSENT_ACK', 'HOSTED_RECEIPT'
));
