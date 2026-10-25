-- QA-304: intentionally do not infer contract-sync provenance from override shape.
-- The former sync and organization.module can both write DISABLED with null
-- seat/expiry/JSON fields and reason = 'Contract <same-tenant contract number>'.
-- Deleting that shape can erase a legitimate manual denial and restore package
-- access. No existing override is safe to remove on those fields alone.
--
-- Keep this migration as an explicit no-op. The forward contract-sync fix stops
-- creating new exclusions; historical ambiguous rows require separately verified
-- provenance and an explicitly approved repair, not a guessed data migration.
-- This does not restore rows if the older cleanup has already been applied.
DO $qa304$
BEGIN
  NULL;
END
$qa304$;
