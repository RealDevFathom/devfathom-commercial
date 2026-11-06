-- Platform default medicine catalogue: a provenance row must agree with the
-- catalogue version and item it names.
--
-- The apply runs in the tenant's RLS scope, so tenants may insert their own
-- provenance rows (UPDATE and DELETE stay platform-only). Nothing tied a row to
-- the catalogue beyond the version foreign key, so a tenant-written row could
-- name a NARCOTICS item's source key with "controlledCandidate" = false — the
-- apply would then count that item as held and never flag it — or carry a
-- "catalogueKey"/"catalogueVersion" that disagrees with "catalogueVersionId".
--
-- Every insert, and any platform update of these columns, is now checked:
--  - "catalogueKey" and "catalogueVersion" equal the key and version of the
--    row's "catalogueVersionId";
--  - that version holds an item with exactly this "sourceKey";
--  - a NARCOTICS item ("controlledCandidate" on the item) is never recorded
--    without the flag. A row may carry the flag for an item without it (a
--    stricter review is harmless), as the link rules allow.
--
-- Both catalogue tables are readable by every session (their SELECT policies
-- are USING (true)), so the check runs with the inserting session's rights.
-- Rows written before this migration are untouched: forward-only.

CREATE FUNCTION pharmacy_validate_catalogue_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_key text;
  version_number integer;
  item_controlled boolean;
BEGIN
  SELECT "key", "version" INTO version_key, version_number
    FROM "platform_medicine_catalogue_versions"
   WHERE "id" = NEW."catalogueVersionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalogue provenance names an unknown catalogue version'
      USING ERRCODE = '23514';
  END IF;
  IF version_key IS DISTINCT FROM NEW."catalogueKey"
     OR version_number IS DISTINCT FROM NEW."catalogueVersion" THEN
    RAISE EXCEPTION 'catalogue provenance key and version must match its catalogue version'
      USING ERRCODE = '23514';
  END IF;

  SELECT "controlledCandidate" INTO item_controlled
    FROM "platform_medicine_catalogue_items"
   WHERE "versionId" = NEW."catalogueVersionId" AND "sourceKey" = NEW."sourceKey";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalogue provenance names an item its catalogue version does not hold'
      USING ERRCODE = '23514';
  END IF;
  IF item_controlled AND NOT NEW."controlledCandidate" THEN
    RAISE EXCEPTION 'catalogue provenance must carry the NARCOTICS review flag of its catalogue item'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pharmacy_catalogue_provenance_valid
  BEFORE INSERT OR UPDATE OF "catalogueKey", "catalogueVersion", "catalogueVersionId", "sourceKey", "controlledCandidate"
  ON "pharmacy_medicine_catalogue_provenance"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_catalogue_provenance();
