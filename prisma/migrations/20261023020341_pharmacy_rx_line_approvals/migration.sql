SET lock_timeout = '5s';

-- #341: a pharmacist's recorded approval, with a reason, of one prescription-only or restricted
-- (non-controlled) counter sale line. It clears the counter's POS-09 missing-prescription block
-- for that line; it never lets anyone without pharmacy:dispense sell it (the #518 gate still
-- applies at addLine, tender and completion). Append-only evidence, read and written by raw SQL
-- in src/lib/pharmacy/rx-line-approval.ts.
CREATE TABLE "pharmacy_rx_line_approvals" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "saleLineId" TEXT NOT NULL,
  "pharmacistUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL CHECK (length(btrim("reason")) >= 3),
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_rx_line_approvals_org_line_key" UNIQUE ("organizationId", "saleLineId"),
  CONSTRAINT "pharmacy_rx_line_approvals_line_fkey" FOREIGN KEY ("organizationId", "saleLineId")
    REFERENCES "pharmacy_sale_lines"("organizationId", "id") ON DELETE RESTRICT
);
CREATE TRIGGER pharmacy_rx_line_approvals_append_only BEFORE UPDATE OR DELETE ON "pharmacy_rx_line_approvals"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();
ALTER TABLE "pharmacy_rx_line_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_rx_line_approvals" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_rx_line_approvals"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
