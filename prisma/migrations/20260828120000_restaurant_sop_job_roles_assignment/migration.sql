-- SOP-1 (WHA-224): restaurant JOB ROLES + both SOP assignment modes.
--
-- Three things land together because they are one invariant, not three:
--
--  1. JOB ROLES as first-class, staff-keyed, MANY-TO-MANY, branch-scoped records.
--     The platform `organization_roles` table could not be reused: it is reached
--     only through the SINGULAR `users"."organizationRoleId"` column, so it can
--     represent neither a login-less operator (C3) nor "barista AND cashier".
--     This is the one and only restaurant job-role concept.
--
--  2. The ASSIGNEE TARGET on an assignment (PERSON | ROLE), guarded by a CHECK so
--     exactly the id column matching the discriminant is populated.
--
--  3. The occurrence-level assignment/claim columns that turn a ROLE target into
--     a claimable branch pool. The first claim is an atomic conditional UPDATE in
--     the domain module; the DB's job here is only to keep the columns coherent.
--
-- Backfill: `assigneeTargetType` defaults to ROLE, so every pre-existing
-- assignment row would violate the CHECK with a NULL `assigneeJobRoleId`. A
-- per-organization system role (`general-staff`) is seeded for exactly the
-- organizations that already own SOP assignments, those rows are pointed at it,
-- and only THEN is the CHECK added. Deterministic ids (`jobrole_general_<org>`)
-- keep the migration re-runnable against a restored snapshot.
--
-- `restaurant_sop_assignments` and `restaurant_staff_profiles` already FORCE RLS,
-- and FORCE applies to the table owner too, so the DML below runs under
-- `SET LOCAL app.is_platform_admin = 'true'` — the same escape hatch the
-- package/module-inheritance and meeting-occurrence migrations use.

SET LOCAL app.is_platform_admin = 'true';

-- CreateEnum
CREATE TYPE "RestaurantSopAssigneeTargetType" AS ENUM ('PERSON', 'ROLE');

-- CreateEnum
CREATE TYPE "RestaurantStaffJobRoleChangeKind" AS ENUM ('GRANTED', 'REVOKED');

-- AlterTable
ALTER TABLE "restaurant_sop_assignments" ADD COLUMN     "assigneeJobRoleId" TEXT,
ADD COLUMN     "assigneeStaffProfileId" TEXT,
ADD COLUMN     "assigneeTargetType" "RestaurantSopAssigneeTargetType" NOT NULL DEFAULT 'ROLE';

-- AlterTable
ALTER TABLE "restaurant_sop_occurrences" ADD COLUMN     "assignedStaffProfileId" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedByStaffProfileId" TEXT,
ADD COLUMN     "poolJobRoleId" TEXT;

-- CreateTable
CREATE TABLE "restaurant_job_roles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_job_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_job_role_capabilities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "jobRoleId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_job_role_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_staff_job_roles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "staffProfileId" TEXT NOT NULL,
    "jobRoleId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "grantedByStaffId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_staff_job_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_staff_capability_grants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "staffProfileId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_staff_capability_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_staff_job_role_audits" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "staffProfileId" TEXT NOT NULL,
    "jobRoleId" TEXT,
    "jobRoleKey" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "change" "RestaurantStaffJobRoleChangeKind" NOT NULL,
    "actorStaffProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_staff_job_role_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_job_roles_organizationId_idx" ON "restaurant_job_roles"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_job_roles_active_idx" ON "restaurant_job_roles"("active");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_job_roles_organizationId_key_key" ON "restaurant_job_roles"("organizationId", "key");

-- CreateIndex
CREATE INDEX "restaurant_job_role_capabilities_organizationId_idx" ON "restaurant_job_role_capabilities"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_job_role_capabilities_jobRoleId_idx" ON "restaurant_job_role_capabilities"("jobRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_job_role_capabilities_jobRoleId_capability_key" ON "restaurant_job_role_capabilities"("jobRoleId", "capability");

-- CreateIndex
CREATE INDEX "restaurant_staff_job_roles_organizationId_idx" ON "restaurant_staff_job_roles"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_staff_job_roles_staffProfileId_idx" ON "restaurant_staff_job_roles"("staffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_staff_job_roles_jobRoleId_idx" ON "restaurant_staff_job_roles"("jobRoleId");

-- CreateIndex
CREATE INDEX "restaurant_staff_job_roles_branchId_idx" ON "restaurant_staff_job_roles"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_staff_job_roles_jobRoleId_branchId_idx" ON "restaurant_staff_job_roles"("jobRoleId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_staff_job_roles_staffProfileId_jobRoleId_branchI_key" ON "restaurant_staff_job_roles"("staffProfileId", "jobRoleId", "branchId");

-- CreateIndex
CREATE INDEX "restaurant_staff_capability_grants_organizationId_idx" ON "restaurant_staff_capability_grants"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_staff_capability_grants_staffProfileId_idx" ON "restaurant_staff_capability_grants"("staffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_staff_capability_grants_branchId_idx" ON "restaurant_staff_capability_grants"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_staff_capability_grants_staffProfileId_branchId__key" ON "restaurant_staff_capability_grants"("staffProfileId", "branchId", "capability");

-- CreateIndex
CREATE INDEX "restaurant_staff_job_role_audits_organizationId_idx" ON "restaurant_staff_job_role_audits"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_staff_job_role_audits_staffProfileId_idx" ON "restaurant_staff_job_role_audits"("staffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_staff_job_role_audits_jobRoleId_idx" ON "restaurant_staff_job_role_audits"("jobRoleId");

-- CreateIndex
CREATE INDEX "restaurant_staff_job_role_audits_branchId_idx" ON "restaurant_staff_job_role_audits"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_staff_job_role_audits_createdAt_idx" ON "restaurant_staff_job_role_audits"("createdAt");

-- CreateIndex
CREATE INDEX "restaurant_sop_assignments_assigneeStaffProfileId_idx" ON "restaurant_sop_assignments"("assigneeStaffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_sop_assignments_assigneeJobRoleId_idx" ON "restaurant_sop_assignments"("assigneeJobRoleId");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrences_assignedStaffProfileId_idx" ON "restaurant_sop_occurrences"("assignedStaffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrences_claimedByStaffProfileId_idx" ON "restaurant_sop_occurrences"("claimedByStaffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrences_poolJobRoleId_branchId_claimedBy_idx" ON "restaurant_sop_occurrences"("poolJobRoleId", "branchId", "claimedByStaffProfileId");

-- AddForeignKey
ALTER TABLE "restaurant_sop_assignments" ADD CONSTRAINT "restaurant_sop_assignments_assigneeStaffProfileId_fkey" FOREIGN KEY ("assigneeStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_assignments" ADD CONSTRAINT "restaurant_sop_assignments_assigneeJobRoleId_fkey" FOREIGN KEY ("assigneeJobRoleId") REFERENCES "restaurant_job_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "restaurant_sop_occurrences_assignedStaffProfileId_fkey" FOREIGN KEY ("assignedStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "restaurant_sop_occurrences_poolJobRoleId_fkey" FOREIGN KEY ("poolJobRoleId") REFERENCES "restaurant_job_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "restaurant_sop_occurrences_claimedByStaffProfileId_fkey" FOREIGN KEY ("claimedByStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_job_role_capabilities" ADD CONSTRAINT "restaurant_job_role_capabilities_jobRoleId_fkey" FOREIGN KEY ("jobRoleId") REFERENCES "restaurant_job_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_job_roles" ADD CONSTRAINT "restaurant_staff_job_roles_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_job_roles" ADD CONSTRAINT "restaurant_staff_job_roles_jobRoleId_fkey" FOREIGN KEY ("jobRoleId") REFERENCES "restaurant_job_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_job_roles" ADD CONSTRAINT "restaurant_staff_job_roles_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_job_roles" ADD CONSTRAINT "restaurant_staff_job_roles_grantedByStaffId_fkey" FOREIGN KEY ("grantedByStaffId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_capability_grants" ADD CONSTRAINT "restaurant_staff_capability_grants_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_capability_grants" ADD CONSTRAINT "restaurant_staff_capability_grants_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_job_role_audits" ADD CONSTRAINT "restaurant_staff_job_role_audits_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_job_role_audits" ADD CONSTRAINT "restaurant_staff_job_role_audits_jobRoleId_fkey" FOREIGN KEY ("jobRoleId") REFERENCES "restaurant_job_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_job_role_audits" ADD CONSTRAINT "restaurant_staff_job_role_audits_actorStaffProfileId_fkey" FOREIGN KEY ("actorStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Organization FK + composite ownership key
-- ---------------------------------------------------------------------------
-- Every new table is organization-scoped, so it gets the org FK plus the
-- UNIQUE("organizationId","id") that lets OTHER tables point at it with a
-- composite tenant FK.

ALTER TABLE "restaurant_job_roles"
    ADD CONSTRAINT "restaurant_job_roles_organization_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_job_role_capabilities"
    ADD CONSTRAINT "restaurant_job_role_capabilities_organization_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_staff_job_roles"
    ADD CONSTRAINT "restaurant_staff_job_roles_organization_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_staff_capability_grants"
    ADD CONSTRAINT "restaurant_staff_capability_grants_organization_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_staff_job_role_audits"
    ADD CONSTRAINT "restaurant_staff_job_role_audits_organization_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_job_roles"
    ADD CONSTRAINT "restaurant_job_roles_organizationId_id_key" UNIQUE ("organizationId", "id");

-- ---------------------------------------------------------------------------
-- Deferred composite tenant FKs (defence in depth)
-- ---------------------------------------------------------------------------
-- A single-column FK would happily let tenant A's staff profile hold tenant B's
-- job role. Pairing "organizationId" into every FK makes that structurally
-- impossible. DEFERRABLE INITIALLY DEFERRED so ordinary seeding order still
-- works; the constraint is proven at COMMIT.

ALTER TABLE "restaurant_job_role_capabilities"
    ADD CONSTRAINT "tenant_jobrolecap_jobRoleId_fk"
    FOREIGN KEY ("organizationId", "jobRoleId") REFERENCES "restaurant_job_roles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_staff_job_roles"
    ADD CONSTRAINT "tenant_staffjobrole_staffProfileId_fk"
    FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_staff_job_roles"
    ADD CONSTRAINT "tenant_staffjobrole_jobRoleId_fk"
    FOREIGN KEY ("organizationId", "jobRoleId") REFERENCES "restaurant_job_roles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_staff_job_roles"
    ADD CONSTRAINT "tenant_staffjobrole_branchId_fk"
    FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_staff_capability_grants"
    ADD CONSTRAINT "tenant_staffcapgrant_staffProfileId_fk"
    FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_staff_capability_grants"
    ADD CONSTRAINT "tenant_staffcapgrant_branchId_fk"
    FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_staff_job_role_audits"
    ADD CONSTRAINT "tenant_staffjobroleaudit_staffProfileId_fk"
    FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_staff_job_role_audits"
    ADD CONSTRAINT "tenant_staffjobroleaudit_branchId_fk"
    FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_sop_assignments"
    ADD CONSTRAINT "tenant_sopasg_assigneeStaffProfileId_fk"
    FOREIGN KEY ("organizationId", "assigneeStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_assignments"
    ADD CONSTRAINT "tenant_sopasg_assigneeJobRoleId_fk"
    FOREIGN KEY ("organizationId", "assigneeJobRoleId") REFERENCES "restaurant_job_roles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_sop_occurrences"
    ADD CONSTRAINT "tenant_sopocc_assignedStaffProfileId_fk"
    FOREIGN KEY ("organizationId", "assignedStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_occurrences"
    ADD CONSTRAINT "tenant_sopocc_poolJobRoleId_fk"
    FOREIGN KEY ("organizationId", "poolJobRoleId") REFERENCES "restaurant_job_roles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_occurrences"
    ADD CONSTRAINT "tenant_sopocc_claimedByStaffProfileId_fk"
    FOREIGN KEY ("organizationId", "claimedByStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Backfill, then constrain
-- ---------------------------------------------------------------------------
-- Seed one system `general-staff` role per organization that already owns SOP
-- assignments, point the legacy ROLE-defaulted rows at it, and only then add the
-- CHECK — otherwise the CHECK would reject the very rows this migration is
-- responsible for making valid.

INSERT INTO "restaurant_job_roles" ("id", "organizationId", "key", "name", "description", "isSystem", "active", "createdAt", "updatedAt")
SELECT DISTINCT
    'jobrole_general_' || a."organizationId",
    a."organizationId",
    'general-staff',
    'General staff',
    'Seeded by the SOP-1 migration so pre-existing SOP assignments have a concrete role target. Safe to rename; deleting it re-points nothing.',
    TRUE,
    TRUE,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "restaurant_sop_assignments" a
ON CONFLICT ("organizationId", "key") DO NOTHING;

UPDATE "restaurant_sop_assignments" a
SET "assigneeJobRoleId" = 'jobrole_general_' || a."organizationId"
WHERE a."assigneeTargetType" = 'ROLE' AND a."assigneeJobRoleId" IS NULL;

-- Exactly one target id, and it must be the one the discriminant names.
ALTER TABLE "restaurant_sop_assignments"
    ADD CONSTRAINT "restaurant_sop_assignments_assignee_target_check" CHECK (
        ("assigneeTargetType" = 'PERSON' AND "assigneeStaffProfileId" IS NOT NULL AND "assigneeJobRoleId" IS NULL)
     OR ("assigneeTargetType" = 'ROLE'   AND "assigneeJobRoleId" IS NOT NULL AND "assigneeStaffProfileId" IS NULL)
    );

-- An occurrence carries at most one owner path, and a claim is never half-written.
ALTER TABLE "restaurant_sop_occurrences"
    ADD CONSTRAINT "restaurant_sop_occurrences_owner_path_check" CHECK (
        NOT ("assignedStaffProfileId" IS NOT NULL AND "poolJobRoleId" IS NOT NULL)
    );
ALTER TABLE "restaurant_sop_occurrences"
    ADD CONSTRAINT "restaurant_sop_occurrences_claim_pair_check" CHECK (
        ("claimedByStaffProfileId" IS NULL) = ("claimedAt" IS NULL)
    );

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE "restaurant_job_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_job_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_job_roles" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_job_role_capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_job_role_capabilities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_job_role_capabilities" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_staff_job_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_staff_job_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_staff_job_roles" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_staff_capability_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_staff_capability_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_staff_capability_grants" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- APPEND-ONLY (the M5/M6 ledger pattern): SELECT + INSERT policies only. With
-- FORCE ROW LEVEL SECURITY the omission of UPDATE/DELETE policies denies those
-- verbs to EVERY role including the table owner, so a revoke entry can never be
-- rewritten or erased — which is the whole point of auditing role membership.
ALTER TABLE "restaurant_staff_job_role_audits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_staff_job_role_audits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_staff_job_role_audits" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_staff_job_role_audits" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
