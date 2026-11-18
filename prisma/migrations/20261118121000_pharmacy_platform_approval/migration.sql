BEGIN;

-- DEV-905: the super admin's manual approval of a pharmacy organization.
--
-- One explicit fact on the organization: "platformApprovedAt" is set when a platform
-- operator approves the pharmacy, with who approved it, the optional note and the
-- checks that were not met at that moment. While it is set the standing organization-
-- and branch-level gates (organization not active, onboarding gates, regulatory profile,
-- qualified person) do not refuse the pharmacy; per-sale rules still apply. Withdrawing
-- the approval clears all four columns and restores the normal checks.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "platformApprovedAt" TIMESTAMP(3);
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "platformApprovedById" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "platformApprovalNote" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "platformApprovalUnmetChecks" JSONB;

-- Only the platform control plane may approve or withdraw. Row-level security lets a
-- tenant transaction update its own organization row, so the approval columns are
-- guarded separately: a transaction without "app.is_platform_admin" = 'true' (the
-- signal `withPlatformDb` sets and the tenant-isolation policies already trust) cannot
-- set, change or clear them.
CREATE OR REPLACE FUNCTION organizations_guard_platform_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.is_platform_admin', true) = 'true' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."platformApprovedAt" IS NOT NULL
       OR NEW."platformApprovedById" IS NOT NULL
       OR NEW."platformApprovalNote" IS NOT NULL
       OR NEW."platformApprovalUnmetChecks" IS NOT NULL THEN
      RAISE EXCEPTION 'only the DevFathom platform can approve a pharmacy'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."platformApprovedAt" IS DISTINCT FROM OLD."platformApprovedAt"
     OR NEW."platformApprovedById" IS DISTINCT FROM OLD."platformApprovedById"
     OR NEW."platformApprovalNote" IS DISTINCT FROM OLD."platformApprovalNote"
     OR NEW."platformApprovalUnmetChecks" IS DISTINCT FROM OLD."platformApprovalUnmetChecks" THEN
    RAISE EXCEPTION 'only the DevFathom platform can approve a pharmacy or withdraw its approval'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS organizations_platform_approval_guard ON "organizations";
CREATE TRIGGER organizations_platform_approval_guard
  BEFORE INSERT OR UPDATE ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION organizations_guard_platform_approval();

COMMIT;
