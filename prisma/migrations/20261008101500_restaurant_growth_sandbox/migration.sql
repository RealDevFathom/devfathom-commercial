-- PROPOSED ONLY. TEST_SANDBOX internal adapter; no production endpoint or sender.
CREATE TABLE restaurant_growth_fixtures (
 "organizationId" TEXT NOT NULL,"branchId" TEXT NOT NULL,"customerId" TEXT NOT NULL,
 environment TEXT NOT NULL DEFAULT 'TEST_SANDBOX' CHECK (environment='TEST_SANDBOX'),
 PRIMARY KEY ("organizationId","branchId","customerId"),
 FOREIGN KEY ("organizationId","branchId") REFERENCES restaurant_branches("organizationId",id),
 FOREIGN KEY ("organizationId","customerId") REFERENCES restaurant_customers("organizationId",id)
);
CREATE TABLE restaurant_growth_attempts (
 id UUID PRIMARY KEY,"organizationId" TEXT NOT NULL,"branchId" TEXT NOT NULL,
 "draftId" TEXT NOT NULL,"reviewId" TEXT NOT NULL,"customerId" TEXT NOT NULL,
 "requestId" UUID NOT NULL,fingerprint TEXT NOT NULL,cutoff TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('CAPTURED','UNKNOWN')),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE ("organizationId","branchId",id,"customerId"),
 UNIQUE ("organizationId","draftId","customerId"),
 FOREIGN KEY ("organizationId","branchId","draftId") REFERENCES restaurant_growth_drafts("organizationId","branchId",id),
 FOREIGN KEY ("organizationId","branchId","reviewId") REFERENCES restaurant_growth_reviews("organizationId","branchId",id),
 FOREIGN KEY ("organizationId","branchId","customerId") REFERENCES restaurant_growth_fixtures("organizationId","branchId","customerId")
);
CREATE TABLE restaurant_growth_receipt_events (
 "organizationId" TEXT NOT NULL,"branchId" TEXT NOT NULL,"attemptId" UUID NOT NULL,
 "customerId" TEXT NOT NULL,"billId" TEXT NOT NULL,"createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY ("organizationId","billId"),
 FOREIGN KEY ("organizationId","branchId","attemptId","customerId") REFERENCES restaurant_growth_attempts("organizationId","branchId",id,"customerId"),
 FOREIGN KEY ("organizationId","billId") REFERENCES restaurant_bills("organizationId",id)
);
CREATE FUNCTION restaurant_growth_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM restaurant_growth_drafts d JOIN restaurant_growth_reviews r ON r.id=d."reviewId" AND r."organizationId"=d."organizationId" AND r."branchId"=d."branchId" WHERE d.id=NEW."draftId" AND d."organizationId"=NEW."organizationId" AND d."branchId"=NEW."branchId" AND d."reviewId"=NEW."reviewId" AND d.action='LOYALTY_REVIEW' AND r.decision='APPROVE' AND r."draftId"=d.id)
 THEN RAISE EXCEPTION 'Reviewed loyalty lineage required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER restaurant_growth_attempt_guard BEFORE INSERT ON restaurant_growth_attempts FOR EACH ROW EXECUTE FUNCTION restaurant_growth_attempt_guard();
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['restaurant_growth_fixtures','restaurant_growth_attempts','restaurant_growth_receipt_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY restaurant_growth_scope ON %I USING ("organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''') AND "branchId"=NULLIF(current_setting(''app.current_branch_id'',true),'''')) WITH CHECK ("organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''') AND "branchId"=NULLIF(current_setting(''app.current_branch_id'',true),''''))',t);
  EXECUTE format('CREATE TRIGGER restaurant_growth_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION restaurant_growth_immutable()',t);
 END LOOP;
END $$;
