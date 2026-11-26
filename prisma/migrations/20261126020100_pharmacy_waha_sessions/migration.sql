BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS pharmacy_waha_sessions (
  "organizationId" text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  "sessionName" text NOT NULL UNIQUE,
  selector text NOT NULL UNIQUE,
  "encryptedApiKey" text NOT NULL,
  "encryptedWebhookSecret" text NOT NULL,
  status text NOT NULL DEFAULT 'DISCONNECTED',
  "connectedNumber" text,
  "statusAt" timestamptz,
  "restrictionCode" integer CHECK ("restrictionCode" IN (463, 475)),
  "perMinute" integer NOT NULL DEFAULT 1 CHECK ("perMinute" BETWEEN 1 AND 60),
  "perDay" integer NOT NULL DEFAULT 0 CHECK ("perDay" BETWEEN 0 AND 1000),
  "portalCodes" boolean NOT NULL DEFAULT false
);
ALTER TABLE pharmacy_waha_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_waha_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS waha_tenant ON pharmacy_waha_sessions;
CREATE POLICY waha_tenant ON pharmacy_waha_sessions
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

COMMIT;
