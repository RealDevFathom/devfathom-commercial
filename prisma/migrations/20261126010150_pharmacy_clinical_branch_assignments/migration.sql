BEGIN;
SET LOCAL lock_timeout = '5s';

-- Table creation and the deployment snapshot commit together. A replay must
-- leave later branches and revocations alone, even when there were zero grants.
DO $migration$
BEGIN
  IF to_regclass(format('%I.pharmacy_clinical_branch_assignments', current_schema())) IS NOT NULL THEN
    RETURN;
  END IF;

  CREATE TABLE pharmacy_clinical_branch_assignments (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" text NOT NULL,
    "userId" text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp(3) NOT NULL,
    CONSTRAINT pharmacy_clinical_branch_user_key UNIQUE ("organizationId", "branchId", "userId"),
    CONSTRAINT pharmacy_clinical_branch_fk FOREIGN KEY ("organizationId", "branchId")
      REFERENCES pharmacy_branches ("organizationId", id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT pharmacy_clinical_user_fk FOREIGN KEY ("organizationId", "userId")
      REFERENCES users ("organizationId", id) ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE INDEX pharmacy_clinical_user_active_idx ON pharmacy_clinical_branch_assignments
    ("organizationId", "userId", active);

  ALTER TABLE pharmacy_clinical_branch_assignments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE pharmacy_clinical_branch_assignments FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON pharmacy_clinical_branch_assignments
    USING (current_setting('app.is_platform_admin', true) = 'true'
      OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
      OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

  -- Same transaction-local deployment context as the original pharmacy backfill.
  PERFORM set_config('app.is_platform_admin', 'true', true);
  INSERT INTO pharmacy_clinical_branch_assignments (id, "organizationId", "branchId", "userId", "updatedAt")
    SELECT gen_random_uuid()::text, o.id, b.id, u.id, CURRENT_TIMESTAMP
    FROM organizations o
    JOIN users u ON u."organizationId" = o.id AND u.role = 'ADMIN' AND u.status = 'ACTIVE'
    JOIN pharmacy_branches b ON b."organizationId" = o.id AND b.active
    WHERE o.vertical = 'PHARMACY' AND NOT EXISTS (
      SELECT 1 FROM pharmacy_branch_assignments a
      WHERE a."organizationId" = o.id AND a."branchId" = b.id AND a."userId" = u.id AND a.active
    );
END
$migration$;
COMMIT;
