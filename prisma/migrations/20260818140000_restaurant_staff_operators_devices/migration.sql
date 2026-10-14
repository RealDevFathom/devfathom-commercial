-- M2-L1 — Staff operators, credentials, devices, terminal sessions and
-- co-authorization for the Restaurant vertical (restaurant/m2).
--
-- Additive and org-scoped. Every new table carries a bare, RLS-guarded
-- organizationId (defaulting from the transaction-local setting so an INSERT
-- cannot omit or forge it) and gets forced org-level RLS with the exact clause
-- used by 20260728092000_row_level_security / the M1-L1 vertical foundation
-- (including the app.is_platform_admin control-plane escape). Cross-tenant-safe
-- composite foreign keys (matching 20260728091000_tenant_composite_integrity and
-- the M1-L1 branch precedent) make a cross-organization reference impossible even
-- inside the platform scope.
--
-- Security invariants realised here: forced org RLS on all five tables (C1);
-- operator credentials reference a staff profile and never a User, and store a
-- hash only — no plaintext column (C2/C4); credential lockout counters live
-- durably on the row (C4); device/session secrets are stored hashed and are
-- re-checkable in the DB every call (C5); the co-authorization record pins both
-- the acting operator and the approving manager with a server timestamp (C6/C7).
--
-- This migration is hand-authored (like the M1-L1 migration) rather than taken
-- verbatim from `prisma migrate dev`: the schema deliberately carries
-- migration-only constructs (deferred composite tenant FKs, (organizationId, id)
-- uniques, partial/expression unique indexes, forced RLS) that Prisma cannot
-- express, so an auto-generated diff would try to DROP them as phantom drift.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "RestaurantStaffStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
CREATE TYPE "RestaurantOperatorCredentialType" AS ENUM ('PIN', 'BADGE');
CREATE TYPE "RestaurantRegisteredDeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- C7 / audit attribution: an operator acting at a terminal is not a User. The
-- value is additive (appended last) so existing AuditActorType rows are
-- unaffected. Not referenced in this migration, so it is safe to add here.
ALTER TYPE "AuditActorType" ADD VALUE 'RESTAURANT_OPERATOR';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE "restaurant_staff_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "userId" TEXT,
    "email" TEXT,
    "displayName" TEXT NOT NULL,
    "primaryBranchId" TEXT,
    "status" "RestaurantStaffStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_staff_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_operator_credentials" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "staffProfileId" TEXT NOT NULL,
    "deviceId" TEXT,
    "type" "RestaurantOperatorCredentialType" NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_operator_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_registered_devices" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deviceSecretHash" TEXT NOT NULL,
    "status" "RestaurantRegisteredDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_registered_devices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_terminal_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "deviceId" TEXT NOT NULL,
    "activeStaffProfileId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "establishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_terminal_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_co_authorizations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "actingStaffProfileId" TEXT NOT NULL,
    "approvingStaffProfileId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "reason" TEXT NOT NULL,
    "deviceId" TEXT,
    "terminalSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_co_authorizations_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Secondary indexes (Prisma-managed shape)
-- ---------------------------------------------------------------------------
CREATE INDEX "restaurant_staff_profiles_organizationId_idx" ON "restaurant_staff_profiles"("organizationId");
CREATE INDEX "restaurant_staff_profiles_userId_idx" ON "restaurant_staff_profiles"("userId");
CREATE INDEX "restaurant_staff_profiles_primaryBranchId_idx" ON "restaurant_staff_profiles"("primaryBranchId");

CREATE INDEX "restaurant_operator_credentials_organizationId_idx" ON "restaurant_operator_credentials"("organizationId");
CREATE INDEX "restaurant_operator_credentials_staffProfileId_idx" ON "restaurant_operator_credentials"("staffProfileId");
CREATE INDEX "restaurant_operator_credentials_deviceId_idx" ON "restaurant_operator_credentials"("deviceId");

CREATE UNIQUE INDEX "restaurant_registered_devices_deviceSecretHash_key" ON "restaurant_registered_devices"("deviceSecretHash");
CREATE INDEX "restaurant_registered_devices_organizationId_idx" ON "restaurant_registered_devices"("organizationId");
CREATE INDEX "restaurant_registered_devices_branchId_idx" ON "restaurant_registered_devices"("branchId");
CREATE INDEX "restaurant_registered_devices_status_idx" ON "restaurant_registered_devices"("status");

CREATE UNIQUE INDEX "restaurant_terminal_sessions_tokenHash_key" ON "restaurant_terminal_sessions"("tokenHash");
CREATE INDEX "restaurant_terminal_sessions_organizationId_idx" ON "restaurant_terminal_sessions"("organizationId");
CREATE INDEX "restaurant_terminal_sessions_deviceId_idx" ON "restaurant_terminal_sessions"("deviceId");
CREATE INDEX "restaurant_terminal_sessions_activeStaffProfileId_idx" ON "restaurant_terminal_sessions"("activeStaffProfileId");
CREATE INDEX "restaurant_terminal_sessions_endedAt_idx" ON "restaurant_terminal_sessions"("endedAt");

CREATE INDEX "restaurant_co_authorizations_organizationId_idx" ON "restaurant_co_authorizations"("organizationId");
CREATE INDEX "restaurant_co_authorizations_actingStaffProfileId_idx" ON "restaurant_co_authorizations"("actingStaffProfileId");
CREATE INDEX "restaurant_co_authorizations_approvingStaffProfileId_idx" ON "restaurant_co_authorizations"("approvingStaffProfileId");
CREATE INDEX "restaurant_co_authorizations_targetType_targetId_idx" ON "restaurant_co_authorizations"("targetType", "targetId");
CREATE INDEX "restaurant_co_authorizations_createdAt_idx" ON "restaurant_co_authorizations"("createdAt");

-- ---------------------------------------------------------------------------
-- Business uniqueness the Prisma schema cannot express
-- ---------------------------------------------------------------------------
-- C3: a staff email is optional, but unique within the organization when present.
CREATE UNIQUE INDEX "restaurant_staff_profiles_organizationId_email_key"
    ON "restaurant_staff_profiles"("organizationId", "email")
    WHERE "email" IS NOT NULL;

-- C4: at most one ACTIVE (non-revoked) credential per operator, type and device
-- scope. COALESCE folds the nullable device scope so an org-wide (null-device)
-- credential is still singular per (organization, staff, type).
CREATE UNIQUE INDEX "restaurant_operator_credentials_active_key"
    ON "restaurant_operator_credentials"("organizationId", "staffProfileId", "type", COALESCE("deviceId", ''))
    WHERE "revokedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- Single-column foreign keys (Prisma-managed) — keep the ON DELETE actions.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_staff_profiles" ADD CONSTRAINT "restaurant_staff_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_staff_profiles" ADD CONSTRAINT "restaurant_staff_profiles_primaryBranchId_fkey" FOREIGN KEY ("primaryBranchId") REFERENCES "restaurant_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "restaurant_operator_credentials" ADD CONSTRAINT "restaurant_operator_credentials_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_operator_credentials" ADD CONSTRAINT "restaurant_operator_credentials_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_registered_devices" ADD CONSTRAINT "restaurant_registered_devices_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_terminal_sessions" ADD CONSTRAINT "restaurant_terminal_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_terminal_sessions" ADD CONSTRAINT "restaurant_terminal_sessions_activeStaffProfileId_fkey" FOREIGN KEY ("activeStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- C7: the co-authorization evidence must not be silently erased by deleting a
-- staff profile, so both identity FKs are ON DELETE RESTRICT (archival, not
-- deletion, is the intended path).
ALTER TABLE "restaurant_co_authorizations" ADD CONSTRAINT "restaurant_co_authorizations_actingStaffProfileId_fkey" FOREIGN KEY ("actingStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_co_authorizations" ADD CONSTRAINT "restaurant_co_authorizations_approvingStaffProfileId_fkey" FOREIGN KEY ("approvingStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_co_authorizations" ADD CONSTRAINT "restaurant_co_authorizations_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_co_authorizations" ADD CONSTRAINT "restaurant_co_authorizations_terminalSessionId_fkey" FOREIGN KEY ("terminalSessionId") REFERENCES "restaurant_terminal_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Cross-tenant-safe composite integrity (matches 20260728091000 and M1-L1):
-- every FK is also expressed as a deferred (organizationId, <fk>) composite so a
-- child can never reference a parent in another organization, even under the
-- platform scope. Nullable FK columns use MATCH SIMPLE (the default), so the
-- composite is checked only when the reference is present.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_staff_profiles"
    ADD CONSTRAINT "restaurant_staff_profiles_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_registered_devices"
    ADD CONSTRAINT "restaurant_registered_devices_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_terminal_sessions"
    ADD CONSTRAINT "restaurant_terminal_sessions_organizationId_id_key" UNIQUE ("organizationId", "id");

ALTER TABLE "restaurant_staff_profiles"
    ADD CONSTRAINT "tenant_rest_staff_userId_fk"
    FOREIGN KEY ("organizationId", "userId")
    REFERENCES "users" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_staff_profiles"
    ADD CONSTRAINT "tenant_rest_staff_primaryBranchId_fk"
    FOREIGN KEY ("organizationId", "primaryBranchId")
    REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_operator_credentials"
    ADD CONSTRAINT "tenant_rest_cred_staffProfileId_fk"
    FOREIGN KEY ("organizationId", "staffProfileId")
    REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_operator_credentials"
    ADD CONSTRAINT "tenant_rest_cred_deviceId_fk"
    FOREIGN KEY ("organizationId", "deviceId")
    REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_registered_devices"
    ADD CONSTRAINT "tenant_rest_device_branchId_fk"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_terminal_sessions"
    ADD CONSTRAINT "tenant_rest_session_deviceId_fk"
    FOREIGN KEY ("organizationId", "deviceId")
    REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_terminal_sessions"
    ADD CONSTRAINT "tenant_rest_session_activeStaffId_fk"
    FOREIGN KEY ("organizationId", "activeStaffProfileId")
    REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_co_authorizations"
    ADD CONSTRAINT "tenant_rest_coauth_actingStaffId_fk"
    FOREIGN KEY ("organizationId", "actingStaffProfileId")
    REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_co_authorizations"
    ADD CONSTRAINT "tenant_rest_coauth_approvingStaffId_fk"
    FOREIGN KEY ("organizationId", "approvingStaffProfileId")
    REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_co_authorizations"
    ADD CONSTRAINT "tenant_rest_coauth_deviceId_fk"
    FOREIGN KEY ("organizationId", "deviceId")
    REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_co_authorizations"
    ADD CONSTRAINT "tenant_rest_coauth_terminalSessionId_fk"
    FOREIGN KEY ("organizationId", "terminalSessionId")
    REFERENCES "restaurant_terminal_sessions" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Forced org-level RLS, identical clause to 20260728092000_row_level_security
-- and the M1-L1 branch tables (including the app.is_platform_admin control-plane
-- escape). No branch-level policy is invented here (D12 seam); branch scope is
-- enforced in server code above this org boundary.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_staff_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_staff_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_staff_profiles" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_operator_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_operator_credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_operator_credentials" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_registered_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_registered_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_registered_devices" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_terminal_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_terminal_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_terminal_sessions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_co_authorizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_co_authorizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_co_authorizations" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
