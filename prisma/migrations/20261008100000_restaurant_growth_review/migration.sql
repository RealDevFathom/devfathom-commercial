-- PROPOSED WHA-1400 fragment. Coordinator applies after accepting shared growth_insights.
-- No shared table creation/alteration, no pharmacy dependency, no promotion publishing.
CREATE TABLE restaurant_growth_reviews (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
 "insightId" TEXT NOT NULL, recommendation INTEGER NOT NULL CHECK (recommendation BETWEEN 0 AND 2),
 revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 100),
 decision TEXT NOT NULL CHECK (decision IN ('EDIT','REJECT','APPROVE')),
 "actorId" TEXT NOT NULL, settings JSONB NOT NULL,
 "draftId" TEXT, "requestId" UUID NOT NULL, fingerprint TEXT NOT NULL,
 "inputHash" TEXT NOT NULL CHECK ("inputHash" ~ '^[a-f0-9]{64}$'),
 "schemaVersion" INTEGER NOT NULL CHECK ("schemaVersion"=1),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE ("organizationId","branchId",id),
 UNIQUE ("organizationId","branchId","insightId","requestId"),
 UNIQUE ("organizationId","insightId",recommendation,revision),
 FOREIGN KEY ("organizationId","branchId") REFERENCES restaurant_branches("organizationId",id),
 FOREIGN KEY ("organizationId","branchId","insightId") REFERENCES growth_insights("organizationId","branchId",id),
 CHECK ((decision='APPROVE') = ("draftId" IS NOT NULL)),
 CHECK (jsonb_typeof(settings)='object' AND settings ? 'objective' AND
   settings->>'objective' IN ('REVIEW_DEMAND','REVIEW_RETENTION','REVIEW_COST_COVERAGE') AND
   settings ? 'priority' AND settings->>'priority' IN ('NORMAL','HIGH') AND settings - 'objective' - 'priority' = '{}'::jsonb)
);
CREATE UNIQUE INDEX restaurant_growth_final ON restaurant_growth_reviews("organizationId","insightId",recommendation) WHERE decision IN ('APPROVE','REJECT');
CREATE TABLE restaurant_growth_drafts (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
 "insightId" TEXT NOT NULL, recommendation INTEGER NOT NULL CHECK (recommendation BETWEEN 0 AND 2),
 "reviewId" TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('LOYALTY_REVIEW','CATERING_REVIEW','INVENTORY_COST_REVIEW')),
 settings JSONB NOT NULL, "actorId" TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status='DRAFT'),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE ("organizationId","branchId",id),
 UNIQUE ("organizationId","insightId",recommendation),
 UNIQUE ("organizationId","reviewId"),
 FOREIGN KEY ("organizationId","branchId") REFERENCES restaurant_branches("organizationId",id),
 FOREIGN KEY ("organizationId","branchId","insightId") REFERENCES growth_insights("organizationId","branchId",id),
 FOREIGN KEY ("organizationId","branchId","reviewId") REFERENCES restaurant_growth_reviews("organizationId","branchId",id)
);
ALTER TABLE restaurant_growth_reviews ADD CONSTRAINT restaurant_growth_draft_fk
 FOREIGN KEY ("organizationId","branchId","draftId") REFERENCES restaurant_growth_drafts("organizationId","branchId",id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION restaurant_growth_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Restaurant growth ledger is append only' USING ERRCODE='23514'; END $$;
CREATE FUNCTION restaurant_growth_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g RECORD; prior INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(NEW."organizationId",NEW."branchId",NEW."insightId")::text,0));
 SELECT * INTO g FROM growth_insights WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND id=NEW."insightId";
 IF NOT FOUND OR g.vertical <> 'RESTAURANT' OR g.status <> 'READY' OR g."schemaVersion" <> NEW."schemaVersion" OR g."inputHash" <> NEW."inputHash"
 OR jsonb_typeof(g.output->'recommendations') IS DISTINCT FROM 'array'
 OR jsonb_array_length(g.output->'recommendations') <= NEW.recommendation
 THEN RAISE EXCEPTION 'Matching ready Restaurant insight required' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM restaurant_growth_reviews WHERE "organizationId"=NEW."organizationId" AND "insightId"=NEW."insightId" AND recommendation=NEW.recommendation AND decision IN ('APPROVE','REJECT'))
 THEN RAISE EXCEPTION 'Recommendation finalized' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(MAX(revision),0) INTO prior FROM restaurant_growth_reviews WHERE "organizationId"=NEW."organizationId" AND "insightId"=NEW."insightId" AND recommendation=NEW.recommendation;
 IF NEW.revision <> prior+1 THEN RAISE EXCEPTION 'Review revision conflict' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION restaurant_growth_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM restaurant_growth_reviews r WHERE r.id=NEW."reviewId" AND r."organizationId"=NEW."organizationId" AND r."branchId"=NEW."branchId" AND r."insightId"=NEW."insightId" AND r.recommendation=NEW.recommendation AND r.decision='APPROVE' AND r."draftId"=NEW.id AND r.settings=NEW.settings AND r."actorId"=NEW."actorId")
 OR NOT EXISTS (SELECT 1 FROM growth_insights g CROSS JOIN LATERAL jsonb_array_elements(g.snapshot->'actions') a WHERE g.id=NEW."insightId" AND g."organizationId"=NEW."organizationId" AND g."branchId"=NEW."branchId" AND a->>'ref'=g.output->'recommendations'->NEW.recommendation->>'actionRef' AND a->>'kind'=NEW.action)
 OR NEW.settings->>'objective' IS DISTINCT FROM (CASE NEW.action WHEN 'LOYALTY_REVIEW' THEN 'REVIEW_RETENTION' WHEN 'CATERING_REVIEW' THEN 'REVIEW_DEMAND' WHEN 'INVENTORY_COST_REVIEW' THEN 'REVIEW_COST_COVERAGE' END)
 THEN RAISE EXCEPTION 'Matching approved review required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER restaurant_growth_review_guard BEFORE INSERT ON restaurant_growth_reviews FOR EACH ROW EXECUTE FUNCTION restaurant_growth_review_guard();
CREATE TRIGGER restaurant_growth_draft_guard BEFORE INSERT ON restaurant_growth_drafts FOR EACH ROW EXECUTE FUNCTION restaurant_growth_draft_guard();
CREATE TRIGGER restaurant_growth_reviews_immutable BEFORE UPDATE OR DELETE ON restaurant_growth_reviews FOR EACH ROW EXECUTE FUNCTION restaurant_growth_immutable();
CREATE TRIGGER restaurant_growth_drafts_immutable BEFORE UPDATE OR DELETE ON restaurant_growth_drafts FOR EACH ROW EXECUTE FUNCTION restaurant_growth_immutable();
ALTER TABLE restaurant_growth_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_growth_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE restaurant_growth_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_growth_drafts FORCE ROW LEVEL SECURITY;
-- Exact branch required: no missing-branch widening and no platform bypass.
CREATE POLICY restaurant_growth_scope ON restaurant_growth_reviews
 USING ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND "branchId"=NULLIF(current_setting('app.current_branch_id',true),''))
 WITH CHECK ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND "branchId"=NULLIF(current_setting('app.current_branch_id',true),''));
CREATE POLICY restaurant_growth_scope ON restaurant_growth_drafts
 USING ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND "branchId"=NULLIF(current_setting('app.current_branch_id',true),''))
 WITH CHECK ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND "branchId"=NULLIF(current_setting('app.current_branch_id',true),''));
