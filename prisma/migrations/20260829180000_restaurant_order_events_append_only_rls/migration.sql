-- WHA-435: restaurant_order_events is an append-only ledger. The original
-- all-command tenant policy unintentionally authorized UPDATE and DELETE.
DROP POLICY "tenant_isolation" ON "restaurant_order_events";

CREATE POLICY "tenant_isolation_select" ON "restaurant_order_events"
FOR SELECT
USING (
  current_setting('app.is_platform_admin', true) = 'true'
  OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
);

CREATE POLICY "tenant_isolation_insert" ON "restaurant_order_events"
FOR INSERT
WITH CHECK (
  current_setting('app.is_platform_admin', true) = 'true'
  OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
);
