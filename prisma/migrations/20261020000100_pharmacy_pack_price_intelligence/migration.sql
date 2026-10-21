-- WHA-1606: additive policy history; batch/lot MRP remains untouched.
ALTER TABLE "pharmacy_drap_ingests" ADD COLUMN "priceNotice" JSONB;
ALTER TABLE "pharmacy_price_change_proposals" ADD COLUMN "packLevelId" TEXT,
  ADD COLUMN "previousRegulatoryMrpMinor" INTEGER;
ALTER TABLE "pharmacy_price_change_proposals" ADD CONSTRAINT "price_proposal_pack_fk"
  FOREIGN KEY ("organizationId", "packLevelId") REFERENCES "pharmacy_pack_levels"("organizationId", "id");
CREATE TABLE "pharmacy_pack_prices" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "presentationId" TEXT NOT NULL, "packLevelId" TEXT NOT NULL, "branchId" TEXT,
  "isOverride" BOOLEAN NOT NULL DEFAULT false,
  "mrpMinor" INTEGER NOT NULL CHECK ("mrpMinor" >= 0),
  "sellingPriceMinor" INTEGER CHECK ("sellingPriceMinor" >= 0),
  "effectiveFrom" TIMESTAMP(3) NOT NULL, "source" TEXT NOT NULL CHECK ("source" IN ('drap','manual')),
  "proposalId" TEXT, "reviewedOrgPriceId" TEXT, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"), UNIQUE ("organizationId", "proposalId"),
  CHECK ("isOverride" = ("branchId" IS NOT NULL)),
  CHECK (("source" = 'drap') = ("proposalId" IS NOT NULL)),
  CHECK ("source" <> 'drap' OR NOT "isOverride"),
  FOREIGN KEY ("organizationId", "packLevelId") REFERENCES "pharmacy_pack_levels"("organizationId", "id"),
  FOREIGN KEY ("presentationId") REFERENCES "pharmacy_presentations"("id"),
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id"),
  FOREIGN KEY ("organizationId", "proposalId") REFERENCES "pharmacy_price_change_proposals"("organizationId", "id"),
  FOREIGN KEY ("organizationId", "reviewedOrgPriceId") REFERENCES "pharmacy_pack_prices"("organizationId", "id")
);
CREATE UNIQUE INDEX pharmacy_pack_prices_org_effective_key ON "pharmacy_pack_prices"("organizationId", "packLevelId", "effectiveFrom") WHERE "branchId" IS NULL;
CREATE UNIQUE INDEX pharmacy_pack_prices_branch_effective_key ON "pharmacy_pack_prices"("organizationId", "branchId", "packLevelId", "effectiveFrom") WHERE "branchId" IS NOT NULL;
CREATE INDEX pharmacy_pack_prices_effective_idx ON "pharmacy_pack_prices"("organizationId", "packLevelId", "effectiveFrom");
-- Validate presentation/pack tenant consistency without changing existing tables.
CREATE FUNCTION pharmacy_price_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pharmacy_pack_levels p JOIN pharmacy_presentations s ON s.id=p."presentationId"
    WHERE p.id=NEW."packLevelId" AND p."organizationId"=NEW."organizationId"
      AND s.id=NEW."presentationId" AND s."organizationId"=NEW."organizationId") THEN
    RAISE EXCEPTION 'Invalid price presentation/pack identity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_price_identity BEFORE INSERT OR UPDATE ON pharmacy_pack_prices FOR EACH ROW EXECUTE FUNCTION pharmacy_price_identity_guard();
CREATE TRIGGER pharmacy_pack_prices_no_delete BEFORE DELETE ON pharmacy_pack_prices FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
ALTER TABLE pharmacy_pack_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_pack_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON pharmacy_pack_prices
USING ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND
  ("branchId" IS NULL OR NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true)))
WITH CHECK ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND
  ("branchId" IS NULL OR NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true)));
