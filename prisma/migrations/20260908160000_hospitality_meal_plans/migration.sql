-- H1-07 — MEAL-01: the meal plans a property sells (05 §1.2).
--
-- A meal plan is configuration that a rate plan will point at (H1-08 adds
-- `hotel_rate_plans.meal_plan_id`) and that a reservation freezes a copy of.
-- Because the reservation carries a frozen snapshot, this table may be edited in
-- place: MEAL-01's "changing a meal plan never changes a confirmed reservation"
-- is a property of the snapshot, not of a new row per change.
--
-- `code` is TEXT rather than an enum. The pack's value list is "EP/CP/MAP/AP or
-- custom", and a custom code is exactly what an enum cannot carry without a
-- migration per property that invents one. The four standard codes are data in
-- src/lib/hotel/meal-plans.ts; the database enforces the code's *shape* and its
-- uniqueness per property, not its membership of a fixed list.

-- The `meals` document is the pack's shape verbatim:
--   [{ meal, outlets[], cutoff_time, per_person }]
-- and it is copied byte-for-byte into the reservation's meal snapshot and pushed
-- to channel managers (CH-03), so it is validated here once rather than at each
-- surface that reads it. A CHECK constraint may not contain a subquery, so the
-- shape rule is an IMMUTABLE function the constraint calls.
--
-- Rules: an array; each entry an object; `meal` one of the three services and at
-- most once per plan (a plan cannot serve two different breakfasts); `outlets`
-- an array of strings, empty meaning "any outlet of this property";
-- `per_person` a boolean; `cutoff_time` absent, null, or 24-hour HH:MM.
CREATE FUNCTION hotel_meal_plan_meals_valid(meals JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry JSONB;
  seen TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF meals IS NULL OR jsonb_typeof(meals) <> 'array' THEN RETURN FALSE; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(meals) LOOP
    IF jsonb_typeof(entry) <> 'object' THEN RETURN FALSE; END IF;
    IF COALESCE(entry->>'meal', '') NOT IN ('BREAKFAST', 'LUNCH', 'DINNER') THEN RETURN FALSE; END IF;
    IF entry->>'meal' = ANY(seen) THEN RETURN FALSE; END IF;
    seen := seen || (entry->>'meal');
    IF jsonb_typeof(entry->'outlets') <> 'array' THEN RETURN FALSE; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(entry->'outlets') AS outlet
       WHERE jsonb_typeof(outlet) <> 'string'
    ) THEN RETURN FALSE; END IF;
    IF jsonb_typeof(entry->'per_person') <> 'boolean' THEN RETURN FALSE; END IF;
    IF COALESCE(jsonb_typeof(entry->'cutoff_time'), 'null') NOT IN ('null', 'string') THEN
      RETURN FALSE;
    END IF;
    IF jsonb_typeof(entry->'cutoff_time') = 'string'
       AND entry->>'cutoff_time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END; $$;

CREATE TABLE "hotel_meal_plans" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  -- The property this plan is sold at. In hospitality the branch IS the
  -- property, so this is `hotel_properties."branchId"`.
  "branchId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  -- Bilingual per the pack's `name_ur`. Nullable: a property that invents a
  -- custom plan may not have named it in Urdu yet, and an empty string would
  -- read as a translation that exists.
  "nameUr" TEXT,
  "meals" JSONB NOT NULL DEFAULT '[]',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_meal_plans_pkey" PRIMARY KEY ("id"),
  -- Uppercase and short because it prints on a rate, a voucher and a channel
  -- push, where "EP" and "ep" must not be two plans.
  CONSTRAINT "hotel_meal_plans_code_ck" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$'),
  CONSTRAINT "hotel_meal_plans_name_ck" CHECK (
    length(btrim("name")) > 0
    AND ("nameUr" IS NULL OR length(btrim("nameUr")) > 0)
  ),
  CONSTRAINT "hotel_meal_plans_meals_ck" CHECK (hotel_meal_plan_meals_valid("meals")),
  -- The composite reference keeps the tenant on both sides: a plan can never
  -- point at a property belonging to another organization.
  CONSTRAINT "hotel_meal_plans_property_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "hotel_meal_plans_org_id_key" ON "hotel_meal_plans"("organizationId", "id");
-- One plan per code per property: EP means one thing at a property.
CREATE UNIQUE INDEX "hotel_meal_plans_org_branch_code_key"
  ON "hotel_meal_plans"("organizationId", "branchId", "code");
CREATE INDEX "hotel_meal_plans_org_branch_active_idx"
  ON "hotel_meal_plans"("organizationId", "branchId", "active");

-- Tenant isolation is the database's job and is forced for the table owner too,
-- so a migration or a job running as the owner cannot read across tenants either.
ALTER TABLE "hotel_meal_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_meal_plans" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hotel_meal_plans_tenant_isolation" ON "hotel_meal_plans"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
