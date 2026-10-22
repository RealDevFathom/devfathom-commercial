-- RATE-01: effective-dated, immutable, bigint rate-plan prices.
ALTER TABLE "hotel_rate_plans"
  ALTER COLUMN "nightlyRateMinor" TYPE bigint,
  ADD COLUMN "taxBasisPoints" integer NOT NULL DEFAULT 0
    CHECK ("taxBasisPoints" BETWEEN 0 AND 100000);

CREATE TABLE "hotel_rate_plan_prices" (
  "id" text PRIMARY KEY,
  "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" text NOT NULL,
  "roomTypeId" text NOT NULL,
  "ratePlanId" text NOT NULL,
  "validFrom" date NOT NULL,
  "validTo" date NOT NULL,
  "netMinor" bigint NOT NULL CHECK ("netMinor" >= 0),
  "published" boolean NOT NULL DEFAULT false,
  "usedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("validFrom" <= "validTo"),
  UNIQUE ("organizationId", "branchId", "id"),
  FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties" ("organizationId", "branchId") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId", "roomTypeId")
    REFERENCES "hotel_room_types" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId", "ratePlanId")
    REFERENCES "hotel_rate_plans" ("organizationId", "branchId", "id") ON DELETE RESTRICT
);

CREATE INDEX "hotel_rate_plan_prices_lookup_idx" ON "hotel_rate_plan_prices"
  ("organizationId", "branchId", "roomTypeId", "ratePlanId", "validFrom", "validTo");

CREATE FUNCTION hotel_rate_price_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."published" OR OLD."usedAt" IS NOT NULL THEN
    IF NEW."netMinor" IS DISTINCT FROM OLD."netMinor"
       OR NEW."validFrom" IS DISTINCT FROM OLD."validFrom"
       OR NEW."validTo" IS DISTINCT FROM OLD."validTo"
       OR NEW."ratePlanId" IS DISTINCT FROM OLD."ratePlanId"
       OR NEW."roomTypeId" IS DISTINCT FROM OLD."roomTypeId" THEN
      RAISE EXCEPTION 'published rate prices are immutable; insert a new version';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "hotel_rate_price_immutable_trigger"
BEFORE UPDATE ON "hotel_rate_plan_prices"
FOR EACH ROW EXECUTE FUNCTION hotel_rate_price_immutable();

CREATE FUNCTION hotel_rate_price_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."published" OR OLD."usedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'published rate prices are immutable; insert a new version';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "hotel_rate_price_no_delete_trigger"
BEFORE DELETE ON "hotel_rate_plan_prices"
FOR EACH ROW EXECUTE FUNCTION hotel_rate_price_no_delete();

ALTER TABLE "hotel_rate_plan_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_rate_plan_prices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_rate_plan_prices_scope" ON "hotel_rate_plan_prices"
  USING ("organizationId" = current_setting('app.current_organization_id', true)
    AND "branchId" = current_setting('app.current_hotel_property_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true)
    AND "branchId" = current_setting('app.current_hotel_property_id', true));
