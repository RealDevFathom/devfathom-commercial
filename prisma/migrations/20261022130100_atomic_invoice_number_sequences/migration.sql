-- Replace count-based invoice numbering with a transactional counter per tenant/year.
CREATE TABLE "invoice_number_sequences" (
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_number_sequences_pkey" PRIMARY KEY ("organizationId", "year"),
    CONSTRAINT "invoice_number_sequences_lastNumber_check" CHECK ("lastNumber" > 0)
);

ALTER TABLE "invoice_number_sequences"
  ADD CONSTRAINT "invoice_number_sequences_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Continue each existing INV-YYYY-N sequence at its greatest numeric suffix.
-- Non-standard/manual invoice identifiers intentionally do not seed a yearly counter.
INSERT INTO "invoice_number_sequences" ("organizationId", "year", "lastNumber")
SELECT
  "organizationId",
  substring("invoiceNumber" FROM '^INV-([0-9]{4})-[0-9]+$')::INTEGER,
  MAX(substring("invoiceNumber" FROM '^INV-[0-9]{4}-([0-9]+)$')::INTEGER)
FROM "invoices"
WHERE "invoiceNumber" ~ '^INV-[0-9]{4}-[0-9]+$'
GROUP BY "organizationId", substring("invoiceNumber" FROM '^INV-([0-9]{4})-[0-9]+$')::INTEGER;

DROP INDEX "invoices_invoiceNumber_key";
CREATE UNIQUE INDEX "invoices_organizationId_invoiceNumber_key"
  ON "invoices"("organizationId", "invoiceNumber");

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
