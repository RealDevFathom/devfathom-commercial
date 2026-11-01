-- #721: Tally XML and Marg Batch Stock import presets for the PH-MIG profiler.
-- Additive only: existing ABUZAR / EXCEL_CSV sources are untouched.
ALTER TYPE "PharmacyMigrationSourceKind" ADD VALUE IF NOT EXISTS 'TALLY_XML';
ALTER TYPE "PharmacyMigrationSourceKind" ADD VALUE IF NOT EXISTS 'MARG_EXCEL';
