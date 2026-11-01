-- WP-G1 — Growth foundation (ai-growth-plan.md "Data model additions").
--
-- Additive, one migration. It introduces the five growth tables
-- (customer_metrics, growth_settings, campaigns, campaign_recipients,
-- message_templates) and links pharmacy_message_logs to them. It rewrites no
-- existing rows. Three structural rules match the rest of the platform:
--
--  1. **No row can reference another tenant's row.** Every growth table carries
--     `organizationId` (defaulted from the RLS session setting) and joins its
--     parents by composite `(organizationId, …)` foreign keys into the unique
--     keys those parents already publish. Row-level security is the second wall;
--     a foreign key that cannot span tenants is the first.
--  2. **No second consent or contact store.** Campaign eligibility is decided
--     by the existing consent sources only: `PatientConsent` (#774: purpose,
--     channel, version, revocation, source) and the pharmacy customer's
--     `whatsappOptIn` / `whatsappOptInChangedAt` with its consent archive.
--     This migration adds no opt-in/opt-out timestamps, no plaintext phone
--     number and no stored message body; the sender resolves the number from
--     the existing customer/patient record at send time, the message log keeps
--     only `phoneLast4`, and provider ids stay in `providerMessageId`.
--  3. **Redemption integrity is enforced by the database.** A sale redeems at
--     most one recipient code, a recipient is redeemed iff it names its sale,
--     and campaign/recipient vocabularies and discount bounds are CHECKed.

-- Keep the schema change, constraints and policies atomic.
BEGIN;

-- ---------------------------------------------------------------------------
-- Existing tables: additive, nullable columns only.
-- ---------------------------------------------------------------------------

-- Campaign messaging reuses the existing pharmacy message log (and its
-- `providerMessageId`, `phoneLast4` and retention rules). A redeemed code is
-- linked to its sale through campaign_recipients."saleId", not a free-text
-- column on pharmacy_sales.
ALTER TABLE "pharmacy_message_logs"
  ADD COLUMN "campaignId" TEXT,
  ADD COLUMN "recipientId" TEXT;

-- ---------------------------------------------------------------------------
-- New growth tables.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "customer_metrics" (
    "customerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "lastPurchaseAt" TIMESTAMP(3),
    "orders90d" INTEGER NOT NULL DEFAULT 0,
    "spend90dMinor" BIGINT NOT NULL DEFAULT 0,
    "medianGapDays" INTEGER,
    "churnScore" INTEGER NOT NULL DEFAULT 0,
    "churnBand" TEXT NOT NULL DEFAULT 'low',
    "nextRefillDueAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_metrics_pkey" PRIMARY KEY ("customerId"),
    CONSTRAINT "customer_metrics_nonnegative_check" CHECK (
      "orders90d" >= 0 AND "spend90dMinor" >= 0 AND
      ("medianGapDays" IS NULL OR "medianGapDays" >= 0)
    ),
    CONSTRAINT "customer_metrics_churn_check" CHECK (
      "churnScore" BETWEEN 0 AND 100 AND "churnBand" IN ('low', 'medium', 'high')
    )
);

-- CreateTable
CREATE TABLE "growth_settings" (
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "monthlyBudgetMinor" INTEGER NOT NULL DEFAULT 0,
    "autoApproveUnderMinor" INTEGER NOT NULL DEFAULT 0,
    "quietHoursStart" INTEGER NOT NULL DEFAULT 21,
    "quietHoursEnd" INTEGER NOT NULL DEFAULT 9,
    "maxMsgsPerDay" INTEGER NOT NULL DEFAULT 200,
    "minSecondsBetweenMsgs" INTEGER NOT NULL DEFAULT 4,
    "lastMetricsRunAt" TIMESTAMP(3),
    "waInstanceName" TEXT,
    "waApiUrl" TEXT,
    "waApiKeyEnc" TEXT,
    "churnThreshold" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "growth_settings_pkey" PRIMARY KEY ("organizationId"),
    CONSTRAINT "growth_settings_money_check" CHECK (
      "monthlyBudgetMinor" >= 0 AND "autoApproveUnderMinor" >= 0 AND
      "autoApproveUnderMinor" <= "monthlyBudgetMinor"
    ),
    CONSTRAINT "growth_settings_limits_check" CHECK (
      "quietHoursStart" BETWEEN 0 AND 23 AND "quietHoursEnd" BETWEEN 0 AND 23 AND
      "maxMsgsPerDay" > 0 AND "minSecondsBetweenMsgs" >= 0 AND
      "churnThreshold" BETWEEN 0 AND 100
    ),
    -- Only an encryptSecret() v1 envelope (src/lib/secret-crypto.ts) may be
    -- stored, so a plaintext WhatsApp API key is rejected by the database.
    CONSTRAINT "growth_settings_wa_api_key_enc_check" CHECK (
      "waApiKeyEnc" IS NULL OR
      "waApiKeyEnc" ~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
    )
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "name" TEXT NOT NULL,
    "rationale" TEXT,
    "segment" JSONB NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "discountType" TEXT,
    "discountValue" INTEGER,
    "codeExpiresAt" TIMESTAMP(3),
    "budgetCapMinor" INTEGER NOT NULL,
    "spentMinor" INTEGER NOT NULL DEFAULT 0,
    "templateId" TEXT NOT NULL,
    "estimatedReach" INTEGER NOT NULL DEFAULT 0,
    "origin" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "campaigns_money_check" CHECK (
      "budgetCapMinor" >= 0 AND "spentMinor" >= 0 AND "spentMinor" <= "budgetCapMinor"
    ),
    CONSTRAINT "campaigns_reach_check" CHECK ("estimatedReach" >= 0),
    CONSTRAINT "campaigns_discount_check" CHECK (
      ("discountType" IS NULL AND "discountValue" IS NULL) OR
      ("discountType" = 'percent' AND "discountValue" BETWEEN 1 AND 100) OR
      ("discountType" = 'fixed' AND "discountValue" > 0)
    ),
    CONSTRAINT "campaigns_kind_check" CHECK (
      "kind" IN ('holiday', 'slow_day', 'birthday', 'refill', 'winback', 'random',
                 'manual', 'review', 'referral')
    ),
    CONSTRAINT "campaigns_status_check" CHECK (
      "status" IN ('proposed', 'approved', 'sending', 'sent', 'cancelled')
    ),
    -- A staff-created campaign names its creator; an AI proposal names none.
    CONSTRAINT "campaigns_origin_check" CHECK (
      ("origin" = 'staff' AND "createdByUserId" IS NOT NULL) OR
      ("origin" = 'ai' AND "createdByUserId" IS NULL)
    ),
    -- A campaign cannot be approved/sending/sent without an approval time; a
    -- named approver always carries one. NULL approver + approvedAt is the
    -- auto-approval policy (growth_settings."autoApproveUnderMinor").
    CONSTRAINT "campaigns_approval_check" CHECK (
      ("approvedByUserId" IS NULL OR "approvedAt" IS NOT NULL) AND
      ("status" NOT IN ('approved', 'sending', 'sent') OR "approvedAt" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "campaignId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "sentAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "saleId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "campaign_recipients_status_check" CHECK (
      "status" IN ('queued', 'skipped', 'sent', 'failed', 'redeemed')
    ),
    -- Redeemed iff a code was redeemed on a named sale at a recorded time.
    CONSTRAINT "campaign_recipients_redemption_check" CHECK (
      ("status" = 'redeemed' AND "redeemedAt" IS NOT NULL AND "saleId" IS NOT NULL
        AND "code" IS NOT NULL) OR
      ("status" <> 'redeemed' AND "redeemedAt" IS NULL AND "saleId" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "key" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'ur-en',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Indexes.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "customer_metrics_organizationId_churnBand_idx" ON "customer_metrics"("organizationId", "churnBand");

-- CreateIndex
CREATE INDEX "customer_metrics_organizationId_nextRefillDueAt_idx" ON "customer_metrics"("organizationId", "nextRefillDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_metrics_organizationId_customerId_key" ON "customer_metrics"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "campaigns_organizationId_status_sendAt_idx" ON "campaigns"("organizationId", "status", "sendAt");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_organizationId_id_key" ON "campaigns"("organizationId", "id");

-- Codes are tenant-owned. Keeping organizationId in the key avoids a cross-tenant
-- uniqueness side channel; redemption must use the authenticated tenant plus code.
CREATE UNIQUE INDEX "campaign_recipients_organizationId_code_key" ON "campaign_recipients"("organizationId", "code");

-- A sale redeems at most one campaign code.
CREATE UNIQUE INDEX "campaign_recipients_organizationId_saleId_key" ON "campaign_recipients"("organizationId", "saleId");

-- CreateIndex
CREATE INDEX "campaign_recipients_organizationId_status_campaignId_idx" ON "campaign_recipients"("organizationId", "status", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_organizationId_id_key" ON "campaign_recipients"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_organizationId_campaignId_customerId_key" ON "campaign_recipients"("organizationId", "campaignId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_organizationId_id_key" ON "message_templates"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_organizationId_key_language_key" ON "message_templates"("organizationId", "key", "language");

-- No index is built on an existing table, so this migration takes no
-- long write lock on pharmacy_customers or pharmacy_message_logs.

-- ---------------------------------------------------------------------------
-- Composite tenant foreign keys.
-- ---------------------------------------------------------------------------

-- AddForeignKey
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_organizationId_campaignId_fkey" FOREIGN KEY ("organizationId", "campaignId") REFERENCES "campaigns"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_organizationId_recipientId_fkey" FOREIGN KEY ("organizationId", "recipientId") REFERENCES "campaign_recipients"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_metrics" ADD CONSTRAINT "customer_metrics_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "growth_settings" ADD CONSTRAINT "growth_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organizationId_createdByUserId_fkey" FOREIGN KEY ("organizationId", "createdByUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organizationId_approvedByUserId_fkey" FOREIGN KEY ("organizationId", "approvedByUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organizationId_templateId_fkey" FOREIGN KEY ("organizationId", "templateId") REFERENCES "message_templates"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organizationId_campaignId_fkey" FOREIGN KEY ("organizationId", "campaignId") REFERENCES "campaigns"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organizationId_saleId_fkey" FOREIGN KEY ("organizationId", "saleId") REFERENCES "pharmacy_sales"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security. Every growth table is enabled AND forced (so even the
-- table owner is subject to it) and carries the platform's organization
-- isolation policy: a platform admin sees all rows, every other session sees
-- only its own organization's rows, and a write must stay in that organization.
-- ---------------------------------------------------------------------------

ALTER TABLE "customer_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_metrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_metrics_tenant_isolation" ON "customer_metrics"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "growth_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growth_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "growth_settings_tenant_isolation" ON "growth_settings"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "campaigns_tenant_isolation" ON "campaigns"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "campaign_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaign_recipients" FORCE ROW LEVEL SECURITY;
CREATE POLICY "campaign_recipients_tenant_isolation" ON "campaign_recipients"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "message_templates_tenant_isolation" ON "message_templates"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

COMMIT;
