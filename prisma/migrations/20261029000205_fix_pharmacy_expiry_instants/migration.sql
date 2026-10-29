-- Existing printed expiries were converted to the next UTC midnight. Pharmacy
-- expiry is governed by the Pakistan calendar, whose midnight is 19:00 UTC on
-- the preceding date. Bring stored exclusive boundaries in line with new writes.
UPDATE "pharmacy_manufacturing_batches"
SET "expiresAt" = "expiresAt" - INTERVAL '5 hours';
