-- Pharmacy opt-in for deep strategy on the deep model (DEV-576). Off by default.
-- The weekly owner summary uses the deep model regardless of this switch.
ALTER TABLE "organizations" ADD COLUMN "aiDeepStrategyEnabled" BOOLEAN NOT NULL DEFAULT false;
