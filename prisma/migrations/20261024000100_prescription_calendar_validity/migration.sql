-- Prescription validity is a pair of inclusive pharmacy calendar dates, not
-- instants. Existing captures came from YYYY-MM-DD UTC-midnight values, so the
-- UTC calendar component is the lossless date to retain.
ALTER TABLE "pharmacy_prescriptions"
  ALTER COLUMN "validFrom" TYPE DATE USING ("validFrom" AT TIME ZONE 'UTC')::date,
  ALTER COLUMN "validUntil" TYPE DATE USING ("validUntil" AT TIME ZONE 'UTC')::date;
