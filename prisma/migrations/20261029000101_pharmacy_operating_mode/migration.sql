BEGIN;

DO $$ BEGIN
  CREATE TYPE "PharmacyOperatingMode" AS ENUM ('SOLO', 'STAFFED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS "pharmacyOperatingMode" "PharmacyOperatingMode" NOT NULL DEFAULT 'STAFFED';

-- SOLO is an explicit organization policy, not a head-count inference. Only the
-- system owner may use the exception; additional staff accounts remain intact.
CREATE OR REPLACE FUNCTION pharmacy_solo_owner_eligible(org text, branch text, actor text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
   SELECT 1 FROM users u
   JOIN organizations o ON o.id=u."organizationId" AND o.vertical='PHARMACY'
     AND o."pharmacyOperatingMode"='SOLO'
   JOIN organization_roles r ON r.id=u."organizationRoleId"
     AND r."organizationId"=org AND r.key='owner' AND r."isSystem"
   WHERE u.id=actor AND u."organizationId"=org AND u.status='ACTIVE'
 ) AND (branch IS NULL OR EXISTS (
   SELECT 1 FROM pharmacy_branches b
   WHERE b.id=branch AND b."organizationId"=org AND b.active
 ));
$$;

COMMIT;
