BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE pharmacy_offline_receipt_events (
  id text PRIMARY KEY, "organizationId" text NOT NULL, "branchId" text NOT NULL,
  "deviceId" text NOT NULL, "commandKey" text NOT NULL, sequence integer NOT NULL,
  "receiptNumber" integer NOT NULL, "actorId" text, kind text NOT NULL,
  reason text NOT NULL, "commandHash" text NOT NULL, evidence jsonb NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId", "branchId", "deviceId")
    REFERENCES pharmacy_registered_devices ("organizationId", "branchId", id),
  CHECK (kind IN ('REFUSED','REJECTED','RETRIED','QUARANTINED'))
);
CREATE INDEX offline_receipt_history ON pharmacy_offline_receipt_events
  ("organizationId","branchId","deviceId","commandKey","createdAt");

-- Include rejections that supervisors recorded before the history table existed.
SET LOCAL app.is_platform_admin = 'true';
INSERT INTO pharmacy_offline_receipt_events
  (id,"organizationId","branchId","deviceId","commandKey",sequence,"receiptNumber",kind,reason,"commandHash",evidence,"createdAt")
SELECT id,"organizationId","branchId","deviceId","idempotencyKey",sequence,"receiptNumber",'REJECTED',
  coalesce("rejectionReason",'Previously rejected'),"payloadHash",jsonb_build_object('command',payload),coalesce("settledAt","receivedAt")
FROM pharmacy_offline_commands WHERE status='REJECTED' AND "receiptNumber" IS NOT NULL;

ALTER TABLE pharmacy_offline_receipt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_offline_receipt_events FORCE ROW LEVEL SECURITY;
CREATE POLICY offline_receipt_scope ON pharmacy_offline_receipt_events USING (
  "organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND
  "branchId" = NULLIF(current_setting('app.current_branch_id',true),'')
);
CREATE FUNCTION pharmacy_offline_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'offline receipt history is append-only' USING ERRCODE='55000';
END $$;
CREATE TRIGGER offline_receipt_immutable BEFORE UPDATE OR DELETE ON pharmacy_offline_receipt_events
FOR EACH ROW EXECUTE FUNCTION pharmacy_offline_receipt_immutable();
CREATE TRIGGER offline_receipt_no_truncate BEFORE TRUNCATE ON pharmacy_offline_receipt_events
FOR EACH STATEMENT EXECUTE FUNCTION pharmacy_offline_receipt_immutable();
COMMIT;
