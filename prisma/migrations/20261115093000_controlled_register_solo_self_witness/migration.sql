BEGIN;

-- Solo-pharmacy rule for controlled register restorations (DEV-293).
-- The register keeps its independent-witness check. The one exception is a
-- stock-backed restoration (a CORRECTION that names its compensating movement)
-- signed with a sole pharmacist's fresh PIN, which the application audits in
-- the same transaction. Every other row still needs a second person.
DO $$
DECLARE legacy record;
BEGIN
  FOR legacy IN
    SELECT conname FROM pg_catalog.pg_constraint
    WHERE conrelid = 'pharmacy_controlled_register_entries'::regclass
      AND contype = 'c'
      AND conname <> 'pharmacy_controlled_register_independent_witness'
      AND pg_catalog.pg_get_constraintdef(oid) ~ '"recordedByUserId" <> "witnessedByUserId"'
  LOOP
    EXECUTE format('ALTER TABLE "pharmacy_controlled_register_entries" DROP CONSTRAINT %I', legacy.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_controlled_register_independent_witness'
      AND conrelid = 'pharmacy_controlled_register_entries'::regclass
  ) THEN
    ALTER TABLE "pharmacy_controlled_register_entries"
      ADD CONSTRAINT "pharmacy_controlled_register_independent_witness"
      CHECK (
        "recordedByUserId" <> "witnessedByUserId"
        OR (
          "entryKind" = 'CORRECTION'
          AND "restorationMovementId" IS NOT NULL
          AND COALESCE("signatureRef", '') LIKE 'solo-pin:%'
        )
      );
  END IF;
END;
$$;

COMMIT;
