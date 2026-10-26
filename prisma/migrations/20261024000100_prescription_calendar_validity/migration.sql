-- Prescription validity is a pair of inclusive pharmacy calendar dates, not
-- instants. The existing timestamp-without-time-zone values already contain the
-- entered calendar date, so retain their date component directly.
ALTER TABLE "pharmacy_prescriptions"
  ALTER COLUMN "validFrom" TYPE DATE USING "validFrom"::date,
  ALTER COLUMN "validUntil" TYPE DATE USING "validUntil"::date;
