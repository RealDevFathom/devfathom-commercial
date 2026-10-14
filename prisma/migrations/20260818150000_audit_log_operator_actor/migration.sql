-- M2 audit durability fix: attribute terminal-operator audit rows correctly.
--
-- A restaurant terminal operator is a `RestaurantStaffProfile`, NOT a `User`
-- (C2/C3). The M2 terminal mutations (unlock/switch/co-authorize/lock) were
-- writing the acting operator's staff-profile id into `audit_logs.actorId`,
-- whose FK references `users(id)` — so every such write failed with a foreign
-- key violation (P2003) against a real database and was silently swallowed by
-- the fire-and-forget audit core, leaving ZERO durable operator audit rows.
--
-- This migration is additive and requires no backfill: existing rows
-- (USER/API_TOKEN/ANONYMOUS/SYSTEM) keep `actorId` and leave the new
-- `actorStaffProfileId` NULL. Only RESTAURANT_OPERATOR rows use the new column.

-- 1. The new, nullable actor column.
ALTER TABLE "audit_logs" ADD COLUMN "actorStaffProfileId" TEXT;

-- 2. Prisma-style single-column FK to the staff profile. Mirrors the existing
--    actorId -> users FK: ON DELETE SET NULL so deleting a profile preserves the
--    historical (and now orphaned) audit row rather than erasing the trail.
ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_actorStaffProfileId_fkey"
    FOREIGN KEY ("actorStaffProfileId") REFERENCES "restaurant_staff_profiles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Tenant-integrity composite FK, matching the M2-L1 pattern used for every
--    other reference to restaurant_staff_profiles: an operator audit row may only
--    attribute to a staff profile in its OWN organization. The column is nullable
--    so MATCH SIMPLE skips the check when actorStaffProfileId IS NULL (every
--    non-operator row). DEFERRABLE INITIALLY DEFERRED for consistency with the
--    other tenant FKs.
ALTER TABLE "audit_logs"
    ADD CONSTRAINT "tenant_audit_actorStaffProfileId_fk"
    FOREIGN KEY ("organizationId", "actorStaffProfileId")
    REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- 4. Index parallel to the existing (actorId, createdAt) index, for actor-scoped
--    audit queries over operator activity.
CREATE INDEX "audit_logs_actorStaffProfileId_createdAt_idx"
    ON "audit_logs"("actorStaffProfileId", "createdAt");

-- 5. Actor-column integrity CHECK. A RESTAURANT_OPERATOR row attributes via the
--    staff-profile column and NEVER via the user FK; every other actor type
--    leaves the staff column NULL (actorId keeps its own nullability). This
--    encodes the fix at the database level: a future regression that mis-routes
--    an operator id back into actorId (the original P2003 bug) now fails LOUDLY
--    at write time instead of being swallowed. NULL actorType cannot occur
--    (NOT NULL column with a default), so no separate NULL branch is needed.
ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_operator_actor_ck" CHECK (
        CASE
            WHEN "actorType" = 'RESTAURANT_OPERATOR'
                THEN "actorStaffProfileId" IS NOT NULL AND "actorId" IS NULL
            ELSE "actorStaffProfileId" IS NULL
        END
    );
