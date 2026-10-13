-- PROPOSED FRAGMENT ONLY. Coordinator composes after the WHA-1294 quote fragment.
-- No migration is registered or applied by this lane.
CREATE UNIQUE INDEX IF NOT EXISTS catering_order_money_scope_key
  ON restaurant_catering_orders ("organizationId", "branchId", id);
CREATE UNIQUE INDEX IF NOT EXISTS catering_quote_money_scope_key
  ON restaurant_catering_quote_revisions ("organizationId", "orderId", id);
CREATE UNIQUE INDEX IF NOT EXISTS catering_money_staff_scope_key
  ON restaurant_staff_profiles ("organizationId", id);
CREATE UNIQUE INDEX IF NOT EXISTS catering_money_device_scope_key
  ON restaurant_registered_devices ("organizationId", "branchId", id);
CREATE UNIQUE INDEX IF NOT EXISTS catering_money_movement_scope_key
  ON restaurant_drawer_movements ("organizationId", id);

CREATE TABLE restaurant_catering_money_evidence (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" text NOT NULL,
  "cateringOrderId" text NOT NULL,
  "quoteRevisionId" text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('DEPOSIT', 'BALANCE', 'REFUND')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source text NOT NULL CHECK (source IN ('CASH', 'OPERATOR_ATTESTED')),
  "originalEvidenceId" text,
  "externalEvidenceSource" text,
  "externalEvidenceReference" text,
  "drawerMovementId" text,
  "actorStaffProfileId" text NOT NULL,
  "deviceId" text NOT NULL,
  "businessDate" date NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "branchId", "cateringOrderId", currency, source, id),
  UNIQUE ("organizationId", "drawerMovementId"),
  UNIQUE ("organizationId", "externalEvidenceSource", "externalEvidenceReference"),
  FOREIGN KEY ("organizationId", "branchId", "cateringOrderId")
    REFERENCES restaurant_catering_orders ("organizationId", "branchId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "cateringOrderId", "quoteRevisionId")
    REFERENCES restaurant_catering_quote_revisions ("organizationId", "orderId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId", "cateringOrderId", currency, source, "originalEvidenceId")
    REFERENCES restaurant_catering_money_evidence ("organizationId", "branchId", "cateringOrderId", currency, source, id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "actorStaffProfileId")
    REFERENCES restaurant_staff_profiles ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId", "deviceId")
    REFERENCES restaurant_registered_devices ("organizationId", "branchId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "drawerMovementId")
    REFERENCES restaurant_drawer_movements ("organizationId", id) ON DELETE RESTRICT,
  CHECK ((kind = 'REFUND') = ("originalEvidenceId" IS NOT NULL)),
  CHECK ("originalEvidenceId" IS DISTINCT FROM id),
  CHECK (
    (source = 'CASH' AND "drawerMovementId" IS NOT NULL AND "externalEvidenceSource" IS NULL AND "externalEvidenceReference" IS NULL)
    OR (source = 'OPERATOR_ATTESTED' AND "drawerMovementId" IS NULL
      AND length(btrim("externalEvidenceSource")) > 0 AND "externalEvidenceSource" IS NOT NULL
      AND length(btrim("externalEvidenceReference")) > 0 AND "externalEvidenceReference" IS NOT NULL)
  )
);
CREATE INDEX catering_money_order_idx ON restaurant_catering_money_evidence ("organizationId", "cateringOrderId");
ALTER TABLE restaurant_catering_money_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_catering_money_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY catering_money_read ON restaurant_catering_money_evidence FOR SELECT
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY catering_money_insert ON restaurant_catering_money_evidence FOR INSERT
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
-- No UPDATE/DELETE policy, including for platform scope. Defense against owner accidents.
CREATE FUNCTION reject_catering_money_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Catering money evidence is append-only'; END $$;
CREATE TRIGGER catering_money_append_only BEFORE UPDATE OR DELETE ON restaurant_catering_money_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_catering_money_mutation();
