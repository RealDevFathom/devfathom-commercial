-- Invoice numbers (INV-<year>-<n>) are a per-organization sequence, so two
-- organizations must be able to hold the same number. Replace the global unique
-- index with one scoped to the organization.
--
-- Build the tenant-scoped index before dropping the global one so the table is
-- never without a uniqueness guarantee. Existing rows are globally unique, so
-- they are unique per organization as well and this cannot fail on old data.
CREATE UNIQUE INDEX "invoices_organizationId_invoiceNumber_key" ON "invoices"("organizationId", "invoiceNumber");

DROP INDEX "invoices_invoiceNumber_key";
