CREATE TYPE "PlatformModuleBand" AS ENUM ('BASELINE', 'PLATFORM', 'VERTICAL_CORE', 'VERTICAL_OPTIONAL');

ALTER TABLE "platform_modules"
  ADD COLUMN "band" "PlatformModuleBand",
  ADD COLUMN "vertical" "OrganizationVertical";

UPDATE "platform_modules"
SET
  "band" = CASE
    WHEN "key" = 'dashboard' THEN 'BASELINE'::"PlatformModuleBand"
    WHEN "key" IN ('projects', 'clients', 'finance') THEN 'VERTICAL_OPTIONAL'::"PlatformModuleBand"
    WHEN "key" = 'restaurant-core' THEN 'VERTICAL_CORE'::"PlatformModuleBand"
    WHEN "key" LIKE 'restaurant-%' THEN 'VERTICAL_OPTIONAL'::"PlatformModuleBand"
    ELSE 'PLATFORM'::"PlatformModuleBand"
  END,
  "vertical" = CASE
    WHEN "key" IN ('projects', 'clients', 'finance') THEN 'AGENCY'::"OrganizationVertical"
    WHEN "key" LIKE 'restaurant-%' THEN 'RESTAURANT'::"OrganizationVertical"
    ELSE NULL
  END;

ALTER TABLE "platform_modules" ALTER COLUMN "band" SET NOT NULL;

ALTER TABLE "platform_modules" ADD CONSTRAINT "platform_modules_band_vertical_check" CHECK (
  ("band" IN ('BASELINE', 'PLATFORM') AND "vertical" IS NULL)
  OR ("band" IN ('VERTICAL_CORE', 'VERTICAL_OPTIONAL') AND "vertical" IS NOT NULL)
);

CREATE INDEX "platform_modules_band_vertical_active_idx"
  ON "platform_modules"("band", "vertical", "active");
