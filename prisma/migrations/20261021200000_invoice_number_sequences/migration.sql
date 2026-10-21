CREATE TABLE "invoice_number_sequences" (
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invoice_number_sequences_pkey" PRIMARY KEY ("organizationId", "year")
);

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
