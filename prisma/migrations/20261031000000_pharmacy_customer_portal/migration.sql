-- Customer identity is independent of staff/User authentication. Only token hashes
-- are persisted; every FK carries its tenant (and branch where applicable).
CREATE TABLE pharmacy_customer_portal_settings (
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  config JSONB NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  PRIMARY KEY ("organizationId", "branchId"),
  FOREIGN KEY ("organizationId", "branchId") REFERENCES pharmacy_branches ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "updatedByUserId") REFERENCES users ("organizationId", id) ON DELETE RESTRICT
);

CREATE TABLE pharmacy_customer_otp_challenges (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "phoneHash" TEXT NOT NULL,
  digest BYTEA NOT NULL CHECK (octet_length(digest) = 32),
  salt TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "maxAttempts" INTEGER NOT NULL CHECK ("maxAttempts" BETWEEN 1 AND 10),
  "consumedAt" TIMESTAMPTZ(3),
  audit JSONB NOT NULL DEFAULT '[]',
  FOREIGN KEY ("organizationId", "customerId") REFERENCES pharmacy_customers ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId") REFERENCES pharmacy_branches ("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX pharmacy_customer_otp_expiry ON pharmacy_customer_otp_challenges ("expiresAt");

CREATE TABLE pharmacy_customer_sessions (
  "tokenHash" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "phoneHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  FOREIGN KEY ("organizationId", "customerId") REFERENCES pharmacy_customers ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId") REFERENCES pharmacy_branches ("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX pharmacy_customer_session_expiry ON pharmacy_customer_sessions ("expiresAt");

CREATE TABLE pharmacy_customer_requests (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('REFILL', 'RX_PHOTO')),
  status TEXT NOT NULL DEFAULT 'AWAITING_PHARMACIST' CHECK (status IN ('AWAITING_PHARMACIST', 'APPROVED', 'DECLINED', 'FULFILLED')),
  "sourceSaleId" TEXT,
  "sourceFileRef" TEXT,
  "fulfilledSaleId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "branchId", "customerId", "idempotencyKey"),
  UNIQUE ("organizationId", "branchId", id),
  CHECK ((kind = 'REFILL' AND "sourceSaleId" IS NOT NULL AND "sourceFileRef" IS NULL)
    OR (kind = 'RX_PHOTO' AND "sourceFileRef" IS NOT NULL AND "sourceSaleId" IS NULL)),
  CHECK ((status = 'FULFILLED') = ("fulfilledSaleId" IS NOT NULL)),
  FOREIGN KEY ("organizationId", "customerId") REFERENCES pharmacy_customers ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId") REFERENCES pharmacy_branches ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId", "sourceSaleId") REFERENCES pharmacy_sales ("organizationId", "branchId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId", "fulfilledSaleId") REFERENCES pharmacy_sales ("organizationId", "branchId", id) ON DELETE RESTRICT
);
CREATE INDEX pharmacy_customer_requests_queue ON pharmacy_customer_requests ("organizationId", "branchId", status, "createdAt");

CREATE TABLE pharmacy_customer_portal_events (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  "branchId" TEXT NOT NULL,
  "customerId" TEXT,
  "actorId" TEXT NOT NULL,
  kind TEXT NOT NULL,
  "requestId" TEXT,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId", "customerId") REFERENCES pharmacy_customers ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId") REFERENCES pharmacy_branches ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId", "requestId") REFERENCES pharmacy_customer_requests ("organizationId", "branchId", id) ON DELETE RESTRICT
);
CREATE INDEX pharmacy_customer_portal_events_scope ON pharmacy_customer_portal_events ("organizationId", "branchId", "occurredAt");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_customer_portal_settings', 'pharmacy_customer_otp_challenges',
    'pharmacy_customer_sessions', 'pharmacy_customer_requests', 'pharmacy_customer_portal_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', t);
  END LOOP;
END $$;

CREATE FUNCTION pharmacy_customer_portal_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Customer portal audit events are append-only';
END $$;
CREATE TRIGGER pharmacy_customer_portal_event_immutable BEFORE UPDATE OR DELETE ON pharmacy_customer_portal_events
  FOR EACH ROW EXECUTE FUNCTION pharmacy_customer_portal_event_immutable();
