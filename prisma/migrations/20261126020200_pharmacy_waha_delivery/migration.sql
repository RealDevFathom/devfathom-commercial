BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS pharmacy_waha_attempts (
  id uuid PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES pharmacy_waha_sessions("organizationId") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  cold boolean NOT NULL,
  purpose text NOT NULL,
  outcome text NOT NULL DEFAULT 'PENDING',
  "providerMessageId" text
);
CREATE INDEX IF NOT EXISTS waha_attempt_window ON pharmacy_waha_attempts ("organizationId", "createdAt");
ALTER TABLE pharmacy_waha_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_waha_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS waha_tenant ON pharmacy_waha_attempts;
CREATE POLICY waha_tenant ON pharmacy_waha_attempts
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
COMMIT;
