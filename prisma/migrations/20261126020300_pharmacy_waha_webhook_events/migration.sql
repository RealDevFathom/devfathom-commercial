BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS pharmacy_waha_events (
  "organizationId" text NOT NULL REFERENCES pharmacy_waha_sessions("organizationId"),
  "eventKey" text NOT NULL,
  "requestKey" text NOT NULL,
  "semanticKey" text NOT NULL,
  "providerMessageId" text,
  ack smallint CHECK (ack IN (2,3)),
  PRIMARY KEY ("organizationId", "eventKey"),
  UNIQUE ("organizationId", "semanticKey"),
  UNIQUE ("organizationId", "requestKey")
);
CREATE INDEX IF NOT EXISTS waha_ack_event ON pharmacy_waha_events ("organizationId", "providerMessageId") WHERE ack IS NOT NULL;
ALTER TABLE pharmacy_waha_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_waha_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS waha_tenant ON pharmacy_waha_events;
CREATE POLICY waha_tenant ON pharmacy_waha_events
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE pharmacy_message_logs ADD COLUMN IF NOT EXISTS "wahaAck" smallint CHECK ("wahaAck" IN (2,3));
-- The send acknowledgement can reach the application after a delivery webhook.
CREATE OR REPLACE FUNCTION pharmacy_waha_join_ack() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."providerMessageId" LIKE 'waha:%' AND NEW.direction = 'OUTBOUND' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW."organizationId" || NEW."providerMessageId",0));
    SELECT greatest(NEW."wahaAck",max(ack)) INTO NEW."wahaAck" FROM pharmacy_waha_events
    WHERE "organizationId"=NEW."organizationId" AND "providerMessageId"=NEW."providerMessageId";
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER pharmacy_waha_join_ack
  BEFORE INSERT OR UPDATE OF "providerMessageId" ON pharmacy_message_logs
  FOR EACH ROW EXECUTE FUNCTION pharmacy_waha_join_ack();
COMMIT;
