BEGIN;

-- Record that an approved resignation's scheduled offboarding has been applied.
-- This prevents a historical resignation from deactivating a deliberately
-- reactivated user on a later worker run.
ALTER TABLE "resignations" ADD COLUMN "offboardedAt" TIMESTAMP(3);

-- Reconcile legacy offboarding before enabling the sweep. The router already
-- offboarded approvals reviewed on/after the confirmed day. Manual offboarding
-- and reactivation are evidenced by tenant user-status audit entries. Do not
-- consume future-approved overdue requests that have never been offboarded:
-- those are precisely the backlog this worker must process.
-- RLS also applies to migration owners on these tenant tables.
SELECT set_config('app.is_platform_admin', 'true', true);

UPDATE "resignations" AS r
SET "offboardedAt" = COALESCE(r."reviewedAt", r."lastWorkingDay")
FROM "users" AS u
WHERE r."userId" = u."id"
  AND r."organizationId" = u."organizationId"
  AND r."status" = 'APPROVED'
  AND r."lastWorkingDay" <= CURRENT_TIMESTAMP
  AND r."offboardedAt" IS NULL
  AND (
    u."status" = 'INACTIVE'
    OR r."reviewedAt" >= r."lastWorkingDay"
    OR EXISTS (
      SELECT 1 FROM "audit_logs" AS a
      WHERE a."organizationId" = r."organizationId"
        AND a."targetType" = 'User' AND a."targetId" = r."userId"
        AND a."outcome" = 'SUCCESS'
        AND a."createdAt" >= COALESCE(r."reviewedAt", r."createdAt")
        AND (a."changes" #>> '{status,after}' = 'INACTIVE'
          OR a."changes" #>> '{status,before}' = 'INACTIVE')
    )
  );

COMMIT;
