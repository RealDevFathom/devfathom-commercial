BEGIN;

-- DEV-803: proposals still pending can never be confirmed. Move them to
-- NOT_APPLIED so the owner sees they were never applied. Confirmed rows and
-- all prices are untouched; the update is idempotent.
UPDATE "pharmacy_price_change_proposals"
SET "status" = 'NOT_APPLIED'
WHERE "status" = 'PROPOSED';

COMMIT;
