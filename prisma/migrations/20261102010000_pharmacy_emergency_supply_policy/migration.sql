BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

-- One-time policy backfill, not a statement of provincial law. The transaction
-- holds the table lock until the original immutability trigger is restored.
ALTER TABLE "pharmacy_jurisdiction_rule_sets"
  DISABLE TRIGGER pharmacy_jurisdiction_rule_sets_immutable;

UPDATE "pharmacy_jurisdiction_rule_sets"
SET "controlledRegisterFlags" = jsonb_set(
  "controlledRegisterFlags",
  '{values}',
  COALESCE("controlledRegisterFlags" -> 'values', '{}'::jsonb) ||
    '{"emergencySupply":{"maxUnits":10,"repeatWindowHours":72,"source":"DEFAULT_POLICY"}}'::jsonb
)
WHERE jsonb_typeof("controlledRegisterFlags") = 'object'
  AND (
    "controlledRegisterFlags" -> 'values' IS NULL
    OR jsonb_typeof("controlledRegisterFlags" -> 'values') = 'object'
  )
  AND NOT COALESCE(("controlledRegisterFlags" -> 'values') ? 'emergencySupply', false);

-- Existing policies and malformed JSON remain untouched; the resolver handles
-- malformed values with the same conservative fallback. Future edits need a new version.
ALTER TABLE "pharmacy_jurisdiction_rule_sets"
  ENABLE TRIGGER pharmacy_jurisdiction_rule_sets_immutable;

COMMIT;
