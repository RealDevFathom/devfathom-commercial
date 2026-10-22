-- Counter phone lookup. Numbers are E.164 and unique inside one organization.
-- Existing collisions are retained and reported; no customer identity is deleted or merged.
ALTER TABLE "pharmacy_customers" ADD COLUMN "normalizedPhone" TEXT;

CREATE FUNCTION pharmacy_normalize_phone_e164(value TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  digits TEXT;
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN RETURN NULL; END IF;
  digits := translate(value, '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789');
  digits := regexp_replace(digits, '[^0-9]', '', 'g');
  IF digits LIKE '00%' THEN digits := substr(digits, 3); END IF;
  IF digits ~ '^03[0-9]{9}$' THEN digits := '92' || substr(digits, 2); END IF;
  IF digits ~ '^3[0-9]{9}$' THEN digits := '92' || digits; END IF;
  IF digits !~ '^[1-9][0-9]{7,14}$' THEN RETURN NULL; END IF;
  RETURN '+' || digits;
END $$;

CREATE TABLE "pharmacy_customer_phone_backfill_conflicts" (
  "organizationId" TEXT NOT NULL,
  "normalizedPhone" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("organizationId", "normalizedPhone", "customerId"),
  CONSTRAINT "pharmacy_customer_phone_conflict_customer_fkey"
    FOREIGN KEY ("organizationId", "customerId")
    REFERENCES "pharmacy_customers" ("organizationId", "id") ON DELETE RESTRICT
);

WITH candidates AS (
  SELECT c."organizationId", c.id AS "customerId", c."patientId",
         pharmacy_normalize_phone_e164(p.phone) AS phone
  FROM "pharmacy_customers" c
  JOIN "pharmacy_patients" p
    ON p."organizationId" = c."organizationId" AND p.id = c."patientId"
), conflicts AS (
  SELECT "organizationId", phone FROM candidates WHERE phone IS NOT NULL
  GROUP BY "organizationId", phone HAVING count(*) > 1
)
INSERT INTO "pharmacy_customer_phone_backfill_conflicts"
  ("organizationId", "normalizedPhone", "customerId", "patientId")
SELECT c."organizationId", c.phone, c."customerId", c."patientId"
FROM candidates c JOIN conflicts d
  ON d."organizationId" = c."organizationId" AND d.phone = c.phone;

WITH candidates AS (
  SELECT c."organizationId", c.id,
         pharmacy_normalize_phone_e164(p.phone) AS phone
  FROM "pharmacy_customers" c
  JOIN "pharmacy_patients" p
    ON p."organizationId" = c."organizationId" AND p.id = c."patientId"
), unique_candidates AS (
  SELECT "organizationId", phone FROM candidates WHERE phone IS NOT NULL
  GROUP BY "organizationId", phone HAVING count(*) = 1
)
UPDATE "pharmacy_customers" c SET "normalizedPhone" = source.phone
FROM candidates source JOIN unique_candidates u
  ON u."organizationId" = source."organizationId" AND u.phone = source.phone
WHERE c."organizationId" = source."organizationId" AND c.id = source.id;

ALTER TABLE "pharmacy_customers" ADD CONSTRAINT "pharmacy_customers_normalized_phone_check"
  CHECK ("normalizedPhone" IS NULL OR "normalizedPhone" ~ '^\\+[1-9][0-9]{7,14}$');
CREATE UNIQUE INDEX "pharmacy_customers_org_normalized_phone_key"
  ON "pharmacy_customers" ("organizationId", "normalizedPhone");

CREATE FUNCTION pharmacy_customer_sync_normalized_phone() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  SELECT pharmacy_normalize_phone_e164(p.phone) INTO NEW."normalizedPhone"
  FROM "pharmacy_patients" p
  WHERE p."organizationId" = NEW."organizationId" AND p.id = NEW."patientId";
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_customer_sync_normalized_phone
BEFORE INSERT OR UPDATE OF "patientId" ON "pharmacy_customers"
FOR EACH ROW EXECUTE FUNCTION pharmacy_customer_sync_normalized_phone();

CREATE FUNCTION pharmacy_patient_sync_customer_phone() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    UPDATE "pharmacy_customers"
    SET "normalizedPhone" = pharmacy_normalize_phone_e164(NEW.phone)
    WHERE "organizationId" = NEW."organizationId" AND "patientId" = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_patient_sync_customer_phone
AFTER UPDATE OF phone ON "pharmacy_patients"
FOR EACH ROW EXECUTE FUNCTION pharmacy_patient_sync_customer_phone();

ALTER TABLE "pharmacy_customer_phone_backfill_conflicts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_customer_phone_backfill_conflicts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_customer_phone_backfill_conflicts"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

CREATE FUNCTION pharmacy_lookup_customer_by_phone(input_phone TEXT)
RETURNS TABLE (id TEXT, "displayName" TEXT, "phoneLast4" TEXT)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c."displayName", c."phoneLast4"
  FROM "pharmacy_customers" c
  WHERE c."organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND c."normalizedPhone" = pharmacy_normalize_phone_e164(input_phone)
    AND c.active = true
  LIMIT 1
$$;
