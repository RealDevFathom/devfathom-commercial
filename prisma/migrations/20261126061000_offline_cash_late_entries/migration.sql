BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS pharmacy_late_offline_cash (
  "commandId" text PRIMARY KEY, "organizationId" text NOT NULL, "branchId" text NOT NULL,
  "deviceId" text NOT NULL, "shiftId" text, "receiptNumber" integer NOT NULL,
  "amountMinor" integer NOT NULL CHECK ("amountMinor" > 0), "soldAt" timestamp(3) NOT NULL,
  "recordedAt" timestamp(3) NOT NULL, "recordedDay" date NOT NULL,
  FOREIGN KEY ("organizationId","branchId","deviceId") REFERENCES pharmacy_registered_devices ("organizationId","branchId",id),
  FOREIGN KEY ("organizationId","shiftId") REFERENCES pharmacy_cash_shifts ("organizationId",id),
  FOREIGN KEY ("organizationId","commandId") REFERENCES pharmacy_offline_commands ("organizationId",id)
);
CREATE UNIQUE INDEX IF NOT EXISTS late_offline_cash_org_command ON pharmacy_late_offline_cash ("organizationId","commandId");
CREATE INDEX IF NOT EXISTS pharmacy_late_cash_day ON pharmacy_late_offline_cash ("organizationId","branchId","recordedDay");
CREATE INDEX IF NOT EXISTS pharmacy_late_cash_shift ON pharmacy_late_offline_cash ("organizationId","shiftId");
ALTER TABLE pharmacy_late_offline_cash ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_late_offline_cash FORCE ROW LEVEL SECURITY;
DO $policy$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid='pharmacy_late_offline_cash'::regclass AND polname='late_cash_scope') THEN
    CREATE POLICY late_cash_scope ON pharmacy_late_offline_cash USING (
      "organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND
      "branchId"=NULLIF(current_setting('app.current_branch_id',true),''));
  END IF;
END $policy$;
CREATE OR REPLACE TRIGGER late_cash_immutable BEFORE UPDATE OR DELETE ON pharmacy_late_offline_cash
FOR EACH ROW EXECUTE FUNCTION pharmacy_offline_receipt_immutable();
CREATE OR REPLACE TRIGGER late_cash_no_truncate BEFORE TRUNCATE ON pharmacy_late_offline_cash
FOR EACH STATEMENT EXECUTE FUNCTION pharmacy_offline_receipt_immutable();
COMMIT;
