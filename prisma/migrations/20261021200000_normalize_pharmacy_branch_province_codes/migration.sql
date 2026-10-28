-- Normalize historical short codes so branch jurisdiction matching uses the
-- ISO 3166-2 values stored by published rule sets. The CASE is idempotent.
SELECT set_config('app.is_platform_admin', 'true', true);

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
