BEGIN;

CREATE TABLE "invoice_number_sequences" (
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invoice_number_sequences_pkey" PRIMARY KEY ("organizationId", "year")
);

-- Hold invoice writes until both the snapshot and compatibility trigger exist.
-- Without this cutover lock, an old application instance could insert between
-- the MAX() backfill and trigger installation, leaving the sequence stale.
LOCK TABLE "invoices" IN SHARE ROW EXCLUSIVE MODE;

-- Preserve the highest already-issued sequence for every tenant/year. Invalid or
-- custom invoice numbers intentionally do not influence the generated sequence.
INSERT INTO "invoice_number_sequences" ("organizationId", "year", "nextNumber", "updatedAt")
SELECT
    "organizationId",
    substring("invoiceNumber" FROM '^INV-([0-9]{4})-[0-9]+$')::INTEGER,
    MAX(substring("invoiceNumber" FROM '^INV-[0-9]{4}-([0-9]+)$')::INTEGER),
    CURRENT_TIMESTAMP
FROM "invoices"
WHERE "invoiceNumber" ~ '^INV-[0-9]{4}-[0-9]+$'
GROUP BY "organizationId", substring("invoiceNumber" FROM '^INV-([0-9]{4})-[0-9]+$')::INTEGER;

DROP INDEX "invoices_invoiceNumber_key";
CREATE UNIQUE INDEX "invoices_organizationId_invoiceNumber_key"
    ON "invoices"("organizationId", "invoiceNumber");

ALTER TABLE "invoice_number_sequences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoice_number_sequences_tenant_isolation" ON "invoice_number_sequences"
USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
)
WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
);

-- Keep the sequence synchronized while old application instances are still
-- creating invoices during a rolling deployment. Installing the trigger in the
-- same migration as the backfill makes the DDL lock the cutover boundary: every
-- later canonical invoice write advances (and can never decrease) its tenant's
-- annual high-water mark.
CREATE FUNCTION sync_invoice_number_sequence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    invoice_year INTEGER;
    invoice_sequence INTEGER;
BEGIN
    IF NEW."invoiceNumber" ~ '^INV-[0-9]{4}-[0-9]+$' THEN
        invoice_year := substring(NEW."invoiceNumber" FROM '^INV-([0-9]{4})-[0-9]+$')::INTEGER;
        invoice_sequence := substring(NEW."invoiceNumber" FROM '^INV-[0-9]{4}-([0-9]+)$')::INTEGER;

        INSERT INTO public.invoice_number_sequences
            ("organizationId", "year", "nextNumber", "updatedAt")
        VALUES (NEW."organizationId", invoice_year, invoice_sequence, CURRENT_TIMESTAMP)
        ON CONFLICT ("organizationId", "year") DO UPDATE
        SET "nextNumber" = GREATEST(
                public.invoice_number_sequences."nextNumber",
                EXCLUDED."nextNumber"
            ),
            "updatedAt" = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_sync_number_sequence
AFTER INSERT OR UPDATE OF "invoiceNumber", "organizationId" ON invoices
FOR EACH ROW EXECUTE FUNCTION sync_invoice_number_sequence();

COMMIT;
