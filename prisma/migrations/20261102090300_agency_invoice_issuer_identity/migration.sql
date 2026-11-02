-- #458 / DEV-243: an agency's client invoice names the agency, not DevFathom, as
-- the seller. The legal name already lives on the organization; this adds the
-- two optional seller details the print/PDF view shows under it. Both are
-- nullable, so existing workspaces keep working and the invoice simply omits a
-- blank line. Additive and idempotent.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "invoiceAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "invoiceTaxId" TEXT;
