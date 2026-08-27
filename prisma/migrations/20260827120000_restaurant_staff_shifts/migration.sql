-- Completion wave (WHA-229) — branch-scoped staff shift scheduling and the
-- shift-aware operator sign-in boundary for the Restaurant vertical.
--
-- Additive and org-scoped. The one new table carries a bare, RLS-guarded
-- organizationId (defaulting from the transaction-local setting so an INSERT
-- cannot omit or forge it) and gets forced org-level RLS with the exact clause
-- used by 20260728092000_row_level_security / M1-L1 … M8. The only change to a
-- pre-existing table is one additive, defaulted boolean on restaurant_branches.
--
-- Binding design constraints:
--   Scheduling only        This migration ships scheduling. There is no
--                          timeclock, attendance, leave, payroll or labour
--                          optimization table here; the M8 labour-cost seam
--                          (restaurant_labour_cost_facts) remains the only
--                          imported-cost boundary.
--   Business date          businessDate is a DATE stamped once from the branch
--                          timezone + businessDayCutoff (M4-L1/C5 convention,
--                          src/lib/restaurant/business-date.ts). startAt/endAt
--                          are UTC instants; branch-local rendering is a
--                          read-time concern (the M7 convention).
--   Overlap                A staff profile may not hold two live shifts whose
--                          half-open [startAt, endAt) intervals overlap, in ANY
--                          branch and whatever the role labels say. The rule is
--                          enforced in src/lib/restaurant/shifts.ts inside the
--                          caller's transaction; the DB carries the ordering and
--                          cancellation CHECKs it can express on its own.
--   Sign-in opt-in         restaurant_branches."shiftSignInEnforced" defaults to
--                          false, so every branch enrolled before this migration
--                          keeps its M2 sign-in behaviour until an operator
--                          turns rostering on for that branch.
--
-- The CREATE TABLE / index / single-column FK section below is the curated
-- output of `prisma migrate diff` for these models (schema-datamodel to
-- schema-datamodel, so it carries no phantom drift for pre-existing tables). The
-- security section that follows is hand-authored because it uses migration-only
-- constructs (deferred composite tenant FKs, the (organizationId, id) unique,
-- CHECKs, forced RLS) that Prisma cannot express, so an auto-generated diff
-- would try to DROP them as phantom drift.

-- CreateEnum
CREATE TYPE "RestaurantShiftStatus" AS ENUM ('SCHEDULED', 'CANCELLED');

-- AlterTable
ALTER TABLE "restaurant_branches" ADD COLUMN     "shiftSignInEnforced" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "restaurant_shifts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "staffProfileId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "role" TEXT,
    "notes" TEXT,
    "status" "RestaurantShiftStatus" NOT NULL DEFAULT 'SCHEDULED',
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_shifts_organizationId_idx" ON "restaurant_shifts"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_shifts_branchId_businessDate_idx" ON "restaurant_shifts"("branchId", "businessDate");

-- CreateIndex
CREATE INDEX "restaurant_shifts_staffProfileId_startAt_idx" ON "restaurant_shifts"("staffProfileId", "startAt");

-- AddForeignKey
ALTER TABLE "restaurant_shifts" ADD CONSTRAINT "restaurant_shifts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_shifts" ADD CONSTRAINT "restaurant_shifts_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Cross-tenant-safe composite integrity (matches M1-L1 … M8): the
-- (organizationId, id) unique on the new table, so a future child could only
-- reference it inside its OWN organization, plus the composite tenant foreign
-- keys for its own parents.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_shifts" ADD CONSTRAINT "restaurant_shifts_organizationId_id_key" UNIQUE ("organizationId", "id");

ALTER TABLE "restaurant_shifts" ADD CONSTRAINT "tenant_shift_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_shifts" ADD CONSTRAINT "tenant_shift_staffProfileId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Business integrity the Prisma schema cannot express. A shift always ends
-- after it starts (a zero-length shift can never be active, so it is rejected
-- outright), and the cancellation state and its timestamp agree in both
-- directions — a SCHEDULED row can never carry a cancelledAt, and a CANCELLED
-- row can never omit one. A cancelReason stays optional.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_shifts" ADD CONSTRAINT "restaurant_shifts_window_ck" CHECK ("endAt" > "startAt");
ALTER TABLE "restaurant_shifts" ADD CONSTRAINT "restaurant_shifts_cancellation_ck" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Forced org-level RLS on the new table, identical clause to
-- 20260728092000_row_level_security / M1-L1 … M8 (incl. the
-- app.is_platform_admin control-plane escape). The table is mutable (a roster is
-- edited and cancelled), so it receives the full ALL policy rather than the
-- append-only ledger pattern.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_shifts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_shifts" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
