BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS pharmacy_offline_receipt_events (
  id text PRIMARY KEY, "organizationId" text NOT NULL, "branchId" text NOT NULL,
  "deviceId" text NOT NULL, "commandKey" text NOT NULL, sequence integer NOT NULL,
  "receiptNumber" integer NOT NULL, "actorId" text, kind text NOT NULL,
  reason text NOT NULL, "commandHash" text NOT NULL, evidence jsonb NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId", "branchId", "deviceId")
    REFERENCES pharmacy_registered_devices ("organizationId", "branchId", id),
  CHECK (kind IN ('REFUSED','REJECTED','RETRIED','QUARANTINED'))
);
CREATE INDEX IF NOT EXISTS offline_receipt_history ON pharmacy_offline_receipt_events
  ("organizationId","branchId","deviceId","commandKey","createdAt");

ALTER TABLE pharmacy_offline_receipt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_offline_receipt_events FORCE ROW LEVEL SECURITY;
DO $policy$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='pharmacy_offline_receipt_events'::regclass
                AND polname='offline_receipt_scope') THEN
CREATE POLICY offline_receipt_scope ON pharmacy_offline_receipt_events USING (
  "organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND
  "branchId" = NULLIF(current_setting('app.current_branch_id',true),'')
);
 END IF;
END $policy$;

-- Offline selling has never been enabled. History begins with the first review;
-- no historical command rows are read or rewritten during deployment.
CREATE OR REPLACE FUNCTION pharmacy_offline_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'offline receipt history is append-only' USING ERRCODE='55000';
END $$;
CREATE OR REPLACE TRIGGER offline_receipt_immutable BEFORE UPDATE OR DELETE ON pharmacy_offline_receipt_events
FOR EACH ROW EXECUTE FUNCTION pharmacy_offline_receipt_immutable();
CREATE OR REPLACE TRIGGER offline_receipt_no_truncate BEFORE TRUNCATE ON pharmacy_offline_receipt_events
FOR EACH STATEMENT EXECUTE FUNCTION pharmacy_offline_receipt_immutable();
COMMIT;
