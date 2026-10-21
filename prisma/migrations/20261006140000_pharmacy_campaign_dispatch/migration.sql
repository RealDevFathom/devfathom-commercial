-- WHA-1622: additive reservation + append-only evidence. Existing log constraints unchanged.
CREATE TABLE pharmacy_campaign_dispatch_attempts (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "captureId" TEXT NOT NULL,
 "requestKey" TEXT NOT NULL CHECK (length("requestKey") BETWEEN 1 AND 128),
 "attemptNumber" INTEGER NOT NULL CHECK ("attemptNumber" > 0),
 provider TEXT NOT NULL CHECK (provider IN ('sandbox', 'meta')),
 "senderId" TEXT NOT NULL CHECK (length("senderId") BETWEEN 1 AND 128),
 "sandboxOutcome" TEXT CHECK ("sandboxOutcome" IN ('DELIVERED','REJECTED','TIMEOUT','FAULT')),
 "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("organizationId", id), UNIQUE ("organizationId", id, provider, "senderId"),
 CONSTRAINT campaign_attempt_request_key UNIQUE ("organizationId", "captureId", "requestKey"),
 CONSTRAINT campaign_attempt_number_key UNIQUE ("organizationId", "captureId", "attemptNumber"),
 FOREIGN KEY ("organizationId", "captureId") REFERENCES pharmacy_campaign_captures("organizationId",id) ON DELETE RESTRICT,
 CHECK ((provider = 'sandbox' AND "sandboxOutcome" IS NOT NULL AND "senderId" = 'sandbox-local-v1') OR
        (provider = 'meta' AND "sandboxOutcome" IS NULL))
);
CREATE TABLE pharmacy_campaign_delivery_events (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "attemptId" TEXT NOT NULL,
 "eventKey" TEXT NOT NULL CHECK (length("eventKey") BETWEEN 1 AND 256),
 state TEXT NOT NULL CHECK (state IN ('PROVIDER_ACCEPTED','DELIVERED','FAILED','UNKNOWN','SUPPRESSED')),
 provider TEXT NOT NULL, "senderId" TEXT NOT NULL, "providerMessageId" TEXT,
 "acceptanceId" TEXT, reason TEXT CHECK (reason IN ('DEFINITE_REJECTION','TRANSPORT_UNKNOWN','ADAPTER_FAULT','OPTED_OUT','NO_CONSENT','INACTIVE','FREQUENCY_CAP','WINDOW_CLOSED','PROVIDER_FAILURE')),
 "occurredAt" TIMESTAMP(3) NOT NULL, "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("organizationId","eventKey"),
 UNIQUE ("organizationId",id,"attemptId","providerMessageId"),
 FOREIGN KEY ("organizationId","attemptId",provider,"senderId") REFERENCES pharmacy_campaign_dispatch_attempts("organizationId",id,provider,"senderId") ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId","acceptanceId","attemptId","providerMessageId") REFERENCES pharmacy_campaign_delivery_events("organizationId",id,"attemptId","providerMessageId") ON DELETE RESTRICT,
 CHECK ("providerMessageId" IS NULL OR length("providerMessageId") BETWEEN 1 AND 256),
 CHECK ((state = 'PROVIDER_ACCEPTED' AND "providerMessageId" IS NOT NULL AND "acceptanceId" IS NULL AND reason IS NULL)
 OR (state = 'DELIVERED' AND "providerMessageId" IS NOT NULL AND "acceptanceId" IS NOT NULL AND reason IS NULL)
 OR (state = 'FAILED' AND reason IS NOT NULL AND ((reason = 'DEFINITE_REJECTION' AND "providerMessageId" IS NULL AND "acceptanceId" IS NULL) OR (reason = 'PROVIDER_FAILURE' AND "providerMessageId" IS NOT NULL AND "acceptanceId" IS NOT NULL)))
 OR (state IN ('UNKNOWN','SUPPRESSED') AND "providerMessageId" IS NULL AND "acceptanceId" IS NULL AND reason IS NOT NULL))
);
-- One acceptance identity per attempt and per provider/sender/message across tenants.
CREATE UNIQUE INDEX pharmacy_campaign_acceptance_attempt ON pharmacy_campaign_delivery_events("organizationId","attemptId") WHERE state = 'PROVIDER_ACCEPTED';
CREATE UNIQUE INDEX pharmacy_campaign_acceptance_message ON pharmacy_campaign_delivery_events(provider,"senderId","providerMessageId") WHERE state = 'PROVIDER_ACCEPTED';
CREATE INDEX pharmacy_campaign_delivery_events_attempt_idx ON pharmacy_campaign_delivery_events("organizationId","attemptId","recordedAt");
CREATE FUNCTION pharmacy_campaign_validate_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."acceptanceId" IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM pharmacy_campaign_delivery_events e WHERE e."organizationId" = NEW."organizationId"
   AND e.id = NEW."acceptanceId" AND e.state = 'PROVIDER_ACCEPTED'
 ) THEN RAISE EXCEPTION 'Callback requires bound acceptance' USING ERRCODE = '23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_campaign_validate_acceptance BEFORE INSERT ON pharmacy_campaign_delivery_events
 FOR EACH ROW EXECUTE FUNCTION pharmacy_campaign_validate_acceptance();
CREATE TRIGGER pharmacy_campaign_attempts_append_only BEFORE UPDATE OR DELETE ON pharmacy_campaign_dispatch_attempts
 FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_campaign_events_append_only BEFORE UPDATE OR DELETE ON pharmacy_campaign_delivery_events
 FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
ALTER TABLE pharmacy_campaign_dispatch_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_campaign_dispatch_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY capture_isolation ON pharmacy_campaign_dispatch_attempts
 USING ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND EXISTS (
 SELECT 1 FROM pharmacy_campaign_captures c WHERE c."organizationId" = pharmacy_campaign_dispatch_attempts."organizationId" AND c.id = pharmacy_campaign_dispatch_attempts."captureId"
 AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL
 OR c."branchId" = NULLIF(current_setting('app.current_branch_id',true),''))))
 WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND EXISTS (
 SELECT 1 FROM pharmacy_campaign_captures c WHERE c."organizationId" = pharmacy_campaign_dispatch_attempts."organizationId" AND c.id = pharmacy_campaign_dispatch_attempts."captureId"
 AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL
 OR c."branchId" = NULLIF(current_setting('app.current_branch_id',true),''))));
ALTER TABLE pharmacy_campaign_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_campaign_delivery_events FORCE ROW LEVEL SECURITY;
CREATE POLICY capture_isolation ON pharmacy_campaign_delivery_events
 USING ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND EXISTS (
 SELECT 1 FROM pharmacy_campaign_dispatch_attempts a WHERE a."organizationId" = pharmacy_campaign_delivery_events."organizationId" AND a.id = pharmacy_campaign_delivery_events."attemptId"))
 WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND EXISTS (
 SELECT 1 FROM pharmacy_campaign_dispatch_attempts a WHERE a."organizationId" = pharmacy_campaign_delivery_events."organizationId" AND a.id = pharmacy_campaign_delivery_events."attemptId"));
-- Capture identity anchors RLS and attribution; reassignment must not rebind evidence.
CREATE TRIGGER pharmacy_campaign_captures_append_only BEFORE UPDATE OR DELETE ON pharmacy_campaign_captures
 FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
