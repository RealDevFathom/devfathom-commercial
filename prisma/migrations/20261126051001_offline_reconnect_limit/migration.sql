BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE pharmacy_branches ADD COLUMN "offlineReconnectHours" integer NOT NULL DEFAULT 72
  CHECK ("offlineReconnectHours" BETWEEN 1 AND 72);
COMMIT;
