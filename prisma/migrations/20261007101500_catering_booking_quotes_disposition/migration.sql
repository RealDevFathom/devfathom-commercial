-- Additive catering-only continuation. Legacy NULLs intentionally remain unknown.
ALTER TABLE restaurant_catering_orders
  ADD COLUMN "bookingStartsAt" timestamptz,
  ADD COLUMN "bookingEndsAt" timestamptz,
  ADD COLUMN "fulfillmentMode" text,
  ADD COLUMN "stockLocationId" text,
  ADD COLUMN revision integer NOT NULL DEFAULT 0,
  ADD COLUMN "approvedQuoteRevisionId" text,
  ADD COLUMN "confirmedQuoteRevisionId" text,
  ADD CONSTRAINT catering_booking_interval CHECK (("bookingStartsAt" IS NULL AND "bookingEndsAt" IS NULL) OR ("bookingStartsAt" IS NOT NULL AND "bookingEndsAt" IS NOT NULL AND "bookingStartsAt" < "bookingEndsAt")),
  ADD CONSTRAINT catering_fulfillment_mode CHECK ("fulfillmentMode" IN ('PICKUP','DELIVERY')),
  ADD CONSTRAINT catering_revision_positive CHECK (revision >= 0);
CREATE INDEX catering_booking_overlap ON restaurant_catering_orders ("organizationId","branchId","bookingStartsAt","bookingEndsAt");
CREATE TABLE restaurant_catering_branch_capacity (
  "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id',true),
  "branchId" text NOT NULL,
  "maxConcurrentHeadcount" integer CHECK ("maxConcurrentHeadcount">0),
  PRIMARY KEY ("organizationId","branchId"),
  FOREIGN KEY ("organizationId","branchId") REFERENCES restaurant_branches ("organizationId",id) ON DELETE RESTRICT
);
CREATE TABLE restaurant_catering_quote_revisions (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id',true),
  "orderId" text NOT NULL,
  revision integer NOT NULL CHECK (revision>=0),
  snapshot jsonb NOT NULL CHECK (snapshot->>'schemaVersion'='1'),
  "contentHash" text NOT NULL,
  "createdByStaffId" text NOT NULL REFERENCES restaurant_staff_profiles(id) ON DELETE RESTRICT,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catering_quote_revision_key UNIQUE ("organizationId","orderId",revision),
  CONSTRAINT catering_quote_order_id_key UNIQUE ("organizationId","orderId",id),
  FOREIGN KEY ("organizationId","orderId") REFERENCES restaurant_catering_orders ("organizationId",id) ON DELETE RESTRICT
);
CREATE TABLE restaurant_catering_quote_approvals (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id',true),
  "orderId" text NOT NULL,
  "quoteRevisionId" text NOT NULL,
  "orderRevision" integer NOT NULL,
  "actorStaffProfileId" text NOT NULL REFERENCES restaurant_staff_profiles(id) ON DELETE RESTRICT,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("organizationId","orderId","quoteRevisionId"),
  FOREIGN KEY ("organizationId","orderId","quoteRevisionId") REFERENCES restaurant_catering_quote_revisions ("organizationId","orderId",id) ON DELETE RESTRICT
);
ALTER TABLE restaurant_catering_orders
  ADD CONSTRAINT catering_approved_quote_fk FOREIGN KEY ("organizationId",id,"approvedQuoteRevisionId") REFERENCES restaurant_catering_quote_revisions ("organizationId","orderId",id) ON DELETE RESTRICT,
  ADD CONSTRAINT catering_confirmed_quote_fk FOREIGN KEY ("organizationId",id,"confirmedQuoteRevisionId") REFERENCES restaurant_catering_quote_revisions ("organizationId","orderId",id) ON DELETE RESTRICT;
CREATE TABLE restaurant_catering_dispositions (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id',true),
  "orderId" text NOT NULL,
  "originalMovementId" text NOT NULL REFERENCES restaurant_stock_movements(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('UNUSED_RETURN','WASTE','NO_RETURN')),
  quantity numeric(18,6) NOT NULL CHECK (quantity>0),
  "resultMovementId" text REFERENCES restaurant_stock_movements(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(trim(reason))>0),
  "actorStaffProfileId" text NOT NULL REFERENCES restaurant_staff_profiles(id) ON DELETE RESTRICT,
  "idempotencyKey" text NOT NULL,
  "payloadHash" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("organizationId","orderId","idempotencyKey"),
  CHECK ((kind='UNUSED_RETURN')=("resultMovementId" IS NOT NULL)),
  FOREIGN KEY ("organizationId","orderId") REFERENCES restaurant_catering_orders ("organizationId",id) ON DELETE RESTRICT
);
CREATE TABLE restaurant_catering_commands (
  "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id',true),
  "orderId" text NOT NULL,
  "idempotencyKey" text NOT NULL,
  "payloadHash" text NOT NULL,
  result jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organizationId","orderId","idempotencyKey"),
  FOREIGN KEY ("organizationId","orderId") REFERENCES restaurant_catering_orders ("organizationId",id) ON DELETE RESTRICT
);
-- References not expressible without changing shared inventory/staff indexes.
CREATE FUNCTION validate_catering_continuation_refs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE staff_id text; source_id text; result_id text;
BEGIN
  IF TG_TABLE_NAME='restaurant_catering_orders' THEN
    IF NEW."stockLocationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM restaurant_stock_locations WHERE id=NEW."stockLocationId" AND "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId") THEN
      RAISE EXCEPTION 'catering stock location must belong to order branch' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  staff_id=COALESCE(to_jsonb(NEW)->>'createdByStaffId',to_jsonb(NEW)->>'actorStaffProfileId');
  IF staff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM restaurant_staff_profiles WHERE id=staff_id AND "organizationId"=NEW."organizationId") THEN
    RAISE EXCEPTION 'catering staff must belong to tenant' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='restaurant_catering_quote_approvals' THEN
    IF NOT EXISTS (SELECT 1 FROM restaurant_catering_quote_revisions WHERE id=NEW."quoteRevisionId" AND revision=NEW."orderRevision" AND "orderId"=NEW."orderId" AND "organizationId"=NEW."organizationId") THEN
    RAISE EXCEPTION 'catering approval revision mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME='restaurant_catering_dispositions' THEN
    source_id=NEW."originalMovementId"; result_id=NEW."resultMovementId";
    IF NOT EXISTS (SELECT 1 FROM restaurant_stock_movements m JOIN restaurant_stock_locations l ON l.id=m."locationId" JOIN restaurant_catering_orders o ON o."branchId"=l."branchId" AND o."organizationId"=m."organizationId" WHERE m.id=source_id AND m."organizationId"=NEW."organizationId" AND o.id=NEW."orderId" AND m.reason='RECIPE_CONSUMPTION' AND m.quantity<0) THEN
      RAISE EXCEPTION 'catering consumption tenant or branch mismatch' USING ERRCODE='23514';
    END IF;
    IF result_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM restaurant_stock_movements r JOIN restaurant_stock_movements s ON s.id=source_id WHERE r.id=result_id AND r."organizationId"=NEW."organizationId" AND r."stockItemId"=s."stockItemId" AND r."locationId"=s."locationId" AND r.quantity=NEW.quantity AND r.reason='SALE_REVERSAL') THEN
      RAISE EXCEPTION 'catering return movement mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_order_continuation_refs BEFORE INSERT OR UPDATE ON restaurant_catering_orders FOR EACH ROW EXECUTE FUNCTION validate_catering_continuation_refs();
CREATE TRIGGER catering_quote_refs BEFORE INSERT ON restaurant_catering_quote_revisions FOR EACH ROW EXECUTE FUNCTION validate_catering_continuation_refs();
CREATE TRIGGER catering_approval_refs BEFORE INSERT ON restaurant_catering_quote_approvals FOR EACH ROW EXECUTE FUNCTION validate_catering_continuation_refs();
CREATE TRIGGER catering_disposition_refs BEFORE INSERT ON restaurant_catering_dispositions FOR EACH ROW EXECUTE FUNCTION validate_catering_continuation_refs();
CREATE FUNCTION deny_catering_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'catering history is append-only' USING ERRCODE='23514'; END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['restaurant_catering_branch_capacity','restaurant_catering_quote_revisions','restaurant_catering_quote_approvals','restaurant_catering_dispositions','restaurant_catering_commands'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY catering_select ON %I FOR SELECT USING ("organizationId"=current_setting(''app.current_organization_id'',true))',t);
    EXECUTE format('CREATE POLICY catering_insert ON %I FOR INSERT WITH CHECK ("organizationId"=current_setting(''app.current_organization_id'',true))',t);
    IF t='restaurant_catering_branch_capacity' THEN
      EXECUTE format('CREATE POLICY catering_update ON %I FOR UPDATE USING ("organizationId"=current_setting(''app.current_organization_id'',true)) WITH CHECK ("organizationId"=current_setting(''app.current_organization_id'',true))',t);
    ELSE
      EXECUTE format('CREATE TRIGGER catering_history_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION deny_catering_history_mutation()',t);
    END IF;
  END LOOP;
END $$;
