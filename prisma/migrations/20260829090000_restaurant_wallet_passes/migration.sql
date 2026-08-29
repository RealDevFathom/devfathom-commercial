-- WHA-298 wallet L1 foundation (additive).
-- Rollback: drop these six tables in reverse dependency order. WALLET cannot
-- be removed from a PostgreSQL enum in place: rolled-back code must stop minting
-- it, delete WALLET identifier rows, and leave the inert value in the enum.
-- Keep this ALTER first and do not use WALLET in data statements in this file;
-- older PostgreSQL versions restrict use of a newly-added enum value in the
-- transaction that added it. The immutable text projection below lets the
-- required partial index compare a text literal without using the new enum
-- value as an enum literal before commit.
ALTER TYPE "CustomerIdentifierKind" ADD VALUE 'WALLET';

CREATE FUNCTION "wallet_identifier_kind_text"("CustomerIdentifierKind") RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE
AS 'SELECT $1::text';

CREATE TYPE "WalletPassPlatform" AS ENUM ('APPLE', 'GOOGLE');
CREATE TYPE "WalletPassStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "WalletPassUpdateReason" AS ENUM ('LEDGER', 'PROGRAM', 'REVOKE', 'RECONCILE');
CREATE TYPE "WalletPassUpdateStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "restaurant_wallet_passes" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "customerId" TEXT NOT NULL,
  "loyaltyAccountId" TEXT NOT NULL,
  "platform" "WalletPassPlatform" NOT NULL,
  "serialNumber" TEXT NOT NULL,
  "status" "WalletPassStatus" NOT NULL DEFAULT 'ACTIVE',
  "appleAuthTokenHash" TEXT,
  "lastPushedBalance" INTEGER,
  "lastPushedAt" TIMESTAMP(3),
  "contentRevision" INTEGER NOT NULL DEFAULT 1,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_wallet_passes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_wallet_pass_registrations" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "passId" TEXT NOT NULL,
  "deviceLibraryIdentifier" TEXT NOT NULL,
  "pushToken" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_wallet_pass_registrations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_wallet_pass_updates" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "passId" TEXT NOT NULL,
  "reason" "WalletPassUpdateReason" NOT NULL,
  "status" "WalletPassUpdateStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_wallet_pass_updates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_wallet_tenant_config" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "programDisplayName" TEXT NOT NULL,
  "logoFileId" TEXT,
  "backgroundColor" TEXT,
  "foregroundColor" TEXT,
  "googleClassSuffix" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_wallet_tenant_config_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_wallet_enrollment_links" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "restaurant_wallet_enrollment_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_wallet_enrollment_attempts" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "identifierKind" "CustomerIdentifierKind" NOT NULL,
  "normalizedValue" TEXT NOT NULL,
  "otpHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_wallet_enrollment_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_customer_identifiers_active_wallet_key" ON "restaurant_customer_identifiers"("organizationId", "customerId") WHERE "wallet_identifier_kind_text"("kind") = 'WALLET';

CREATE UNIQUE INDEX "restaurant_wallet_passes_serialNumber_key" ON "restaurant_wallet_passes"("serialNumber");
CREATE UNIQUE INDEX "restaurant_wallet_passes_organizationId_id_key" ON "restaurant_wallet_passes"("organizationId", "id");
CREATE UNIQUE INDEX "restaurant_wallet_passes_active_customer_platform_key" ON "restaurant_wallet_passes"("organizationId", "customerId", "platform") WHERE "status" = 'ACTIVE';
CREATE INDEX "restaurant_wallet_passes_organizationId_idx" ON "restaurant_wallet_passes"("organizationId");
CREATE INDEX "restaurant_wallet_passes_customerId_idx" ON "restaurant_wallet_passes"("customerId");
CREATE INDEX "restaurant_wallet_passes_loyaltyAccountId_idx" ON "restaurant_wallet_passes"("loyaltyAccountId");

CREATE UNIQUE INDEX "restaurant_wallet_pass_registrations_organizationId_id_key" ON "restaurant_wallet_pass_registrations"("organizationId", "id");
CREATE UNIQUE INDEX "restaurant_wallet_pass_registrations_passId_deviceLibraryIdentifier_key" ON "restaurant_wallet_pass_registrations"("passId", "deviceLibraryIdentifier");
CREATE INDEX "restaurant_wallet_pass_registrations_organizationId_idx" ON "restaurant_wallet_pass_registrations"("organizationId");
CREATE INDEX "restaurant_wallet_pass_registrations_passId_idx" ON "restaurant_wallet_pass_registrations"("passId");

CREATE UNIQUE INDEX "restaurant_wallet_pass_updates_organizationId_id_key" ON "restaurant_wallet_pass_updates"("organizationId", "id");
CREATE UNIQUE INDEX "restaurant_wallet_pass_updates_pending_pass_key" ON "restaurant_wallet_pass_updates"("passId") WHERE "status" = 'PENDING';
CREATE INDEX "restaurant_wallet_pass_updates_organizationId_idx" ON "restaurant_wallet_pass_updates"("organizationId");
CREATE INDEX "restaurant_wallet_pass_updates_passId_idx" ON "restaurant_wallet_pass_updates"("passId");
CREATE INDEX "restaurant_wallet_pass_updates_status_nextAttemptAt_idx" ON "restaurant_wallet_pass_updates"("status", "nextAttemptAt");

CREATE UNIQUE INDEX "restaurant_wallet_tenant_config_organizationId_key" ON "restaurant_wallet_tenant_config"("organizationId");
CREATE UNIQUE INDEX "restaurant_wallet_tenant_config_googleClassSuffix_key" ON "restaurant_wallet_tenant_config"("googleClassSuffix");
CREATE UNIQUE INDEX "restaurant_wallet_tenant_config_organizationId_id_key" ON "restaurant_wallet_tenant_config"("organizationId", "id");

CREATE UNIQUE INDEX "restaurant_wallet_enrollment_links_tokenHash_key" ON "restaurant_wallet_enrollment_links"("tokenHash");
CREATE UNIQUE INDEX "restaurant_wallet_enrollment_links_organizationId_id_key" ON "restaurant_wallet_enrollment_links"("organizationId", "id");
CREATE UNIQUE INDEX "restaurant_wallet_enrollment_links_active_branch_key" ON "restaurant_wallet_enrollment_links"("organizationId", "branchId") WHERE "active" = true;
CREATE INDEX "restaurant_wallet_enrollment_links_organizationId_idx" ON "restaurant_wallet_enrollment_links"("organizationId");
CREATE INDEX "restaurant_wallet_enrollment_links_branchId_idx" ON "restaurant_wallet_enrollment_links"("branchId");

CREATE UNIQUE INDEX "restaurant_wallet_enrollment_attempts_organizationId_id_key" ON "restaurant_wallet_enrollment_attempts"("organizationId", "id");
CREATE INDEX "restaurant_wallet_enrollment_attempts_organizationId_idx" ON "restaurant_wallet_enrollment_attempts"("organizationId");
CREATE INDEX "restaurant_wallet_enrollment_attempts_branchId_idx" ON "restaurant_wallet_enrollment_attempts"("branchId");
CREATE INDEX "restaurant_wallet_enrollment_attempts_expiresAt_idx" ON "restaurant_wallet_enrollment_attempts"("expiresAt");

ALTER TABLE "restaurant_wallet_passes" ADD CONSTRAINT "restaurant_wallet_passes_customer_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "restaurant_customers"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_wallet_passes" ADD CONSTRAINT "restaurant_wallet_passes_loyalty_account_fkey" FOREIGN KEY ("organizationId", "loyaltyAccountId") REFERENCES "restaurant_loyalty_accounts"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_wallet_pass_registrations" ADD CONSTRAINT "restaurant_wallet_pass_registrations_pass_fkey" FOREIGN KEY ("organizationId", "passId") REFERENCES "restaurant_wallet_passes"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_wallet_pass_updates" ADD CONSTRAINT "restaurant_wallet_pass_updates_pass_fkey" FOREIGN KEY ("organizationId", "passId") REFERENCES "restaurant_wallet_passes"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_wallet_enrollment_links" ADD CONSTRAINT "restaurant_wallet_enrollment_links_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_wallet_enrollment_attempts" ADD CONSTRAINT "restaurant_wallet_enrollment_attempts_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE wallet_table TEXT;
BEGIN
  FOREACH wallet_table IN ARRAY ARRAY[
    'restaurant_wallet_passes',
    'restaurant_wallet_pass_registrations',
    'restaurant_wallet_pass_updates',
    'restaurant_wallet_tenant_config',
    'restaurant_wallet_enrollment_links',
    'restaurant_wallet_enrollment_attempts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', wallet_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', wallet_table);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', wallet_table);
  END LOOP;
END $$;
