-- Printed pharmacy expiry dates are Pakistan-local dates. Existing exclusive
-- expiry boundaries were stored at UTC midnight, five hours after PKT midnight.
UPDATE "pharmacy_manufacturing_batches"
SET "expiresAt" = "expiresAt" - INTERVAL '5 hours';
