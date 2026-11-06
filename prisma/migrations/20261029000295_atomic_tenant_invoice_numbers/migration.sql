BEGIN;

-- Existing invoices have forced RLS, including for the migration owner. Read
-- every tenant during the backfill, then restore scope when this migration ends.
SELECT set_config('app.is_platform_admin', 'true', true);

-- Invoice numbers are meaningful within a tenant, not globally. Replace the
-- global constraint before backfilling tenant/year allocators.
DROP INDEX "invoices_invoiceNumber_key";
CREATE UNIQUE INDEX "invoices_organizationId_invoiceNumber_key"
  ON "invoices"("organizationId", "invoiceNumber");

CREATE TABLE "invoice_number_sequences" (
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "year" INTEGER NOT NULL,
  "lastNumber" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoice_number_sequences_pkey" PRIMARY KEY ("organizationId", "year")
);

-- Preserve the greatest standard INV-YYYY-NNN suffix already issued. Nonstandard
-- legacy numbers do not participate in this allocator.
INSERT INTO "invoice_number_sequences" ("organizationId", "year", "lastNumber")
SELECT "organizationId",
       substring("invoiceNumber" from '^INV-([0-9]{4})-')::INTEGER,
       MAX(substring("invoiceNumber" from '-([0-9]+)$')::INTEGER)
FROM "invoices"
WHERE "invoiceNumber" ~ '^INV-[0-9]{4}-[0-9]{1,9}$'
GROUP BY "organizationId", substring("invoiceNumber" from '^INV-([0-9]{4})-')::INTEGER;

ALTER TABLE "invoice_number_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_number_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoice_number_sequences"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

-- Rollout safety: application instances still running the legacy count-based
-- writer keep inserting invoices after this migration commits and before the
-- allocator-aware release is live. Advance the allocator from every standard
-- invoice number written (legacy, seeded, or allocated) so it never falls behind
-- and reserves a number that already exists. GREATEST never rewinds it, and the
-- allocator's own row lock serializes this with concurrent reservations.
CREATE FUNCTION "invoice_number_sequences_sync"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."invoiceNumber" ~ '^INV-[0-9]{4}-[0-9]{1,9}$' THEN
    INSERT INTO "invoice_number_sequences" ("organizationId", "year", "lastNumber")
    VALUES (
      NEW."organizationId",
      substring(NEW."invoiceNumber" from '^INV-([0-9]{4})-')::INTEGER,
      substring(NEW."invoiceNumber" from '-([0-9]+)$')::INTEGER
    )
    ON CONFLICT ("organizationId", "year") DO UPDATE
      SET "lastNumber" = GREATEST("invoice_number_sequences"."lastNumber", EXCLUDED."lastNumber"),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "invoice_number_sequences"."lastNumber" < EXCLUDED."lastNumber";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "invoices_invoice_number_sequence_sync"
AFTER INSERT OR UPDATE OF "invoiceNumber" ON "invoices"
FOR EACH ROW EXECUTE FUNCTION "invoice_number_sequences_sync"();

COMMIT;
