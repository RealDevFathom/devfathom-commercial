-- Isolated WHA-1622 fragment; final Prisma/root composition belongs to WHA-1618.
CREATE TABLE growth_insights (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES organizations(id),
 "branchId" TEXT NOT NULL, vertical TEXT NOT NULL CHECK (vertical IN ('PHARMACY','RESTAURANT')),
 "actorId" TEXT NOT NULL, "schemaVersion" INTEGER NOT NULL CHECK ("schemaVersion" = 1),
 "inputHash" TEXT NOT NULL CHECK ("inputHash" ~ '^[a-f0-9]{64}$'),
 status TEXT NOT NULL CHECK (status IN ('READY','UNAVAILABLE','INVALID','INSUFFICIENT_DATA')),
 "failureCode" TEXT CHECK ("failureCode" IN ('CONFIGURATION','TIMEOUT','PROVIDER','OUTPUT','SPARSE')),
 provider TEXT, model TEXT, snapshot JSONB NOT NULL, output JSONB,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE ("organizationId","branchId",id),
 CHECK ((status = 'READY' AND output IS NOT NULL AND "failureCode" IS NULL AND provider IS NOT NULL AND model IS NOT NULL)
   OR (status <> 'READY' AND output IS NULL AND "failureCode" IS NOT NULL))
);
CREATE INDEX growth_insights_scope ON growth_insights("organizationId","branchId","createdAt");
CREATE TABLE pharmacy_growth_reviews (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
 "insightId" TEXT NOT NULL, recommendation INTEGER NOT NULL CHECK (recommendation BETWEEN 0 AND 2),
 decision TEXT NOT NULL CHECK (decision IN ('EDIT','REJECT','APPROVE')),
 "actorId" TEXT NOT NULL, settings JSONB, "campaignId" TEXT,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY ("organizationId","branchId","insightId") REFERENCES growth_insights("organizationId","branchId",id),
 FOREIGN KEY ("organizationId","campaignId") REFERENCES pharmacy_campaigns("organizationId",id),
 CHECK ((decision = 'APPROVE' AND "campaignId" IS NOT NULL AND settings IS NOT NULL) OR (decision <> 'APPROVE' AND "campaignId" IS NULL))
);
CREATE UNIQUE INDEX pharmacy_growth_final_decision ON pharmacy_growth_reviews("organizationId","insightId",recommendation) WHERE decision IN ('APPROVE','REJECT');
CREATE UNIQUE INDEX pharmacy_growth_campaign_lineage ON pharmacy_growth_reviews("organizationId","campaignId") WHERE "campaignId" IS NOT NULL;
CREATE FUNCTION pharmacy_growth_validate_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM growth_insights g WHERE g."organizationId" = NEW."organizationId" AND g."branchId" = NEW."branchId" AND g.id = NEW."insightId" AND g.vertical = 'PHARMACY' AND g.status = 'READY' AND jsonb_array_length(g.output->'recommendations') > NEW.recommendation)
 THEN RAISE EXCEPTION 'Ready authorized recommendation required' USING ERRCODE='23514'; END IF;
 IF NEW."campaignId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_campaigns c WHERE c."organizationId" = NEW."organizationId" AND c."branchId" = NEW."branchId" AND c.id = NEW."campaignId" AND c.status = 'DRAFT')
 THEN RAISE EXCEPTION 'Matching draft required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_growth_lineage BEFORE INSERT ON pharmacy_growth_reviews FOR EACH ROW EXECUTE FUNCTION pharmacy_growth_validate_lineage();
CREATE TRIGGER growth_insights_immutable BEFORE UPDATE OR DELETE ON growth_insights FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_growth_reviews_immutable BEFORE UPDATE OR DELETE ON pharmacy_growth_reviews FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
ALTER TABLE growth_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_insights FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_isolation ON growth_insights
 USING ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId" = current_setting('app.current_branch_id',true)))
 WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId" = current_setting('app.current_branch_id',true)));
ALTER TABLE pharmacy_growth_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_growth_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_isolation ON pharmacy_growth_reviews
 USING ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId" = current_setting('app.current_branch_id',true)))
 WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId" = current_setting('app.current_branch_id',true)));
