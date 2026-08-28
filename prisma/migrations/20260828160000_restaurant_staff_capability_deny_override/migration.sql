-- B1 (WHA-285): the per-person capability DENY override, and its audit trail.
--
-- WHAT THIS ADDS, AND WHY IT IS NOT A THIRD PERMISSION MODEL.
-- Restaurant floor permission stays exactly two layers deep, both already
-- present: (1) the union over the job roles a staff profile holds at a branch,
-- and (2) the per-person overrides in `restaurant_staff_capability_grants`. This
-- migration gives layer (2) a DIRECTION. It previously could only add; it can
-- now also subtract, which is the only way to take one capability away from ONE
-- person without editing a role that other people hold.
--
-- FORWARD-SAFE BACKFILL. `effect` lands NOT NULL DEFAULT 'ALLOW'. Every existing
-- row in this table WAS a grant, so the default is identity-preserving: no
-- pre-existing permission changes by one bit when this migration runs, and no
-- backfill query is needed. Denial is opt-in and explicit — never inferred.
--
-- FAIL-CLOSED ORDERING. The new column is added and the audit table created
-- before anything can write a DENY, so there is no window in which a deny row
-- exists that resolution would ignore. Resolution subtracts DENY last (see
-- `resolveStaffCapabilityDecision`), so a deny that is present is a deny that
-- is enforced.
--
-- WHY A SEPARATE AUDIT TABLE. `restaurant_staff_job_role_audits` audits a (role,
-- branch) holding and its `jobRoleKey` is NOT NULL. A capability override is a
-- different subject with no role at all; recording it there would have meant
-- dropping that NOT NULL on a live append-only trail. The new table copies that
-- trail's append-only shape instead — SELECT + INSERT policies only, under FORCE
-- ROW LEVEL SECURITY, so UPDATE and DELETE are denied to every role including
-- the table owner.
--
-- `restaurant_staff_capability_grants` already FORCEs RLS and FORCE applies to
-- the owner too, so this file runs under the same platform-admin escape hatch
-- the SOP-1 migration used.

SET LOCAL app.is_platform_admin = 'true';

-- CreateEnum
CREATE TYPE "RestaurantStaffCapabilityEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "RestaurantStaffCapabilityAuditKind" AS ENUM ('ALLOWED', 'DENIED', 'CLEARED');

-- AlterTable
ALTER TABLE "restaurant_staff_capability_grants"
    ADD COLUMN "effect" "RestaurantStaffCapabilityEffect" NOT NULL DEFAULT 'ALLOW',
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "restaurant_staff_capability_audits" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "staffProfileId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "change" "RestaurantStaffCapabilityAuditKind" NOT NULL,
    "actorStaffProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_staff_capability_audits_pkey" PRIMARY KEY ("id")
);

-- No new index on the overrides table: resolution reads it by
-- (staffProfileId, branchId), which is already a covered prefix of the existing
-- UNIQUE(staffProfileId, branchId, capability). An effect-bearing index would be
-- redundant write cost.

-- CreateIndex
CREATE INDEX "restaurant_staff_capability_audits_organizationId_idx" ON "restaurant_staff_capability_audits"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_staff_capability_audits_staffProfileId_idx" ON "restaurant_staff_capability_audits"("staffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_staff_capability_audits_branchId_idx" ON "restaurant_staff_capability_audits"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_staff_capability_audits_createdAt_idx" ON "restaurant_staff_capability_audits"("createdAt");

-- AddForeignKey
ALTER TABLE "restaurant_staff_capability_audits" ADD CONSTRAINT "restaurant_staff_capability_audits_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_capability_audits" ADD CONSTRAINT "restaurant_staff_capability_audits_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_staff_capability_audits" ADD CONSTRAINT "restaurant_staff_capability_audits_actorStaffProfileId_fkey" FOREIGN KEY ("actorStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Organization FK + composite tenant FKs (defence in depth)
-- ---------------------------------------------------------------------------
-- Single-column FKs would let tenant A's audit row point at tenant B's staff
-- profile. Pairing "organizationId" into every FK makes that structurally
-- impossible; DEFERRABLE INITIALLY DEFERRED so ordinary insert order still works
-- and the constraint is proven at COMMIT.

ALTER TABLE "restaurant_staff_capability_audits"
    ADD CONSTRAINT "restaurant_staff_capability_audits_organization_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_staff_capability_audits"
    ADD CONSTRAINT "tenant_staffcapaudit_staffProfileId_fk"
    FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_staff_capability_audits"
    ADD CONSTRAINT "tenant_staffcapaudit_branchId_fk"
    FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- APPEND-ONLY (the M5/M6 ledger pattern, matching the job-role membership
-- trail): SELECT + INSERT policies only. Under FORCE ROW LEVEL SECURITY the
-- omission of UPDATE/DELETE policies denies those verbs to EVERY role including
-- the table owner, so a recorded deny can never be rewritten or erased.

ALTER TABLE "restaurant_staff_capability_audits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_staff_capability_audits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_staff_capability_audits" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_staff_capability_audits" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
