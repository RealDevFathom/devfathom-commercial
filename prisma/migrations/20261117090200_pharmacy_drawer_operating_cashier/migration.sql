-- DEV-821: bind each pharmacy cash drawer to the cashier who runs it. Cash goes into a
-- drawer only from its operating cashier or a manager/owner, and a manager's handover
-- of an open till is recorded append-only.
BEGIN;

ALTER TABLE "pharmacy_drawer_sessions" ADD COLUMN IF NOT EXISTS "operatingCashierId" TEXT;
-- No backfill: pharmacy_drawer_sessions has forced tenant RLS with no platform-admin
-- clause, so an UPDATE here would touch no rows. Not needed either: an empty value
-- reads as the drawer's opener (drawerOperatingCashierId in settlement.ts).

CREATE TABLE IF NOT EXISTS "pharmacy_drawer_handovers" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "drawerSessionId" TEXT NOT NULL,
  "fromCashierId" TEXT NOT NULL,
  "toCashierId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_drawer_handovers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_drawer_handovers_organizationId_drawerSessionId_fkey" FOREIGN KEY ("organizationId", "drawerSessionId") REFERENCES "pharmacy_drawer_sessions"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_drawer_handovers_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "pharmacy_drawer_handovers_change_check" CHECK ("fromCashierId" <> "toCashierId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_drawer_handovers_organizationId_id_key" ON "pharmacy_drawer_handovers"("organizationId", "id");
CREATE INDEX IF NOT EXISTS "pharmacy_drawer_handovers_organizationId_drawerSessionId_createdAt_idx" ON "pharmacy_drawer_handovers"("organizationId", "drawerSessionId", "createdAt");

-- A handover is evidence for the close: it is never edited or removed.
CREATE OR REPLACE FUNCTION "pharmacy_drawer_handovers_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy_drawer_handovers is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "pharmacy_drawer_handovers_append_only" ON "pharmacy_drawer_handovers";
CREATE TRIGGER "pharmacy_drawer_handovers_append_only"
  BEFORE UPDATE OR DELETE ON "pharmacy_drawer_handovers"
  FOR EACH ROW EXECUTE FUNCTION "pharmacy_drawer_handovers_append_only"();

ALTER TABLE "pharmacy_drawer_handovers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_drawer_handovers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_drawer_handovers";
CREATE POLICY tenant_isolation ON "pharmacy_drawer_handovers"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

COMMIT;
