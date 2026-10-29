ALTER TABLE pharmacy_loyalty_points_entries ADD COLUMN "adjustmentReason" TEXT;
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
 WHERE conrelid='pharmacy_loyalty_points_entries'::regclass AND conname='pharmacy_loyalty_points_entries_sign_check';
 EXECUTE 'ALTER TABLE pharmacy_loyalty_points_entries DROP CONSTRAINT pharmacy_loyalty_points_entries_sign_check';
 EXECUTE 'ALTER TABLE pharmacy_loyalty_points_entries ADD CONSTRAINT pharmacy_loyalty_points_entries_sign_check CHECK (' ||
 substring(definition from 8 for length(definition)-8) ||
 ' OR (kind = ''ADJUSTMENT'' AND points <> 0 AND length(btrim("adjustmentReason")) > 0 AND "tenderId" IS NULL AND "refundId" IS NULL))';
END $$;
