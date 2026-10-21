BEGIN;

-- pharmacy_branches is protected by FORCE ROW LEVEL SECURITY. Elevate only for
-- this migration transaction so the backfill can see every legacy branch.
SELECT set_config('app.is_platform_admin', 'true', true);

-- Early pharmacy branches stored Pakistan subdivision codes without the
-- country prefix. Keep those branches compatible with the canonical codes used
-- by jurisdiction rule sets and all new regulatory profiles.
UPDATE "pharmacy_branches"
SET "provinceCode" = CASE "provinceCode"
  WHEN 'PB' THEN 'PK-PB'
  WHEN 'SD' THEN 'PK-SD'
  WHEN 'KP' THEN 'PK-KP'
  WHEN 'BA' THEN 'PK-BA'
  WHEN 'ICT' THEN 'PK-ICT'
  WHEN 'GB' THEN 'PK-GB'
  WHEN 'AJK' THEN 'PK-AJK'
END
WHERE "provinceCode" IN ('PB', 'SD', 'KP', 'BA', 'ICT', 'GB', 'AJK');

COMMIT;
