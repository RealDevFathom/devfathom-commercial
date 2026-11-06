-- PUR-02 (#979, PR J): purchase-order approval is its own capability,
-- `pharmacy:procurement-approve`. Keep already-provisioned pharmacy Manager and
-- Owner / Operator system roles able to approve and send orders and authorize
-- suppliers, exactly as the catalog templates now grant. Owner roles hold it
-- through `pharmacy:*`; tenant administrators without an organization role hold
-- it through the static ABAC policy.
-- Only system roles in PHARMACY organizations are touched; tenant-authored
-- lookalikes are not widened. Idempotent. An existing row for the capability
-- (including an explicit DENY) is left untouched.
-- Wrapped in a transaction so the transaction-local set_config applies to the
-- INSERT under FORCE ROW LEVEL SECURITY on organization_roles.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "organization_role_permissions"
  ("id", "organizationId", "organizationRoleId", "capability", "effect", "createdAt")
SELECT
  'ph_po_approve_' || md5(role.id || ':pharmacy:procurement-approve'),
  role."organizationId",
  role.id,
  'pharmacy:procurement-approve',
  'ALLOW'::"PermissionEffect",
  CURRENT_TIMESTAMP
FROM "organization_roles" role
JOIN "organizations" organization ON organization.id = role."organizationId"
WHERE organization.vertical = 'PHARMACY'
  AND role."isSystem" = true
  AND role.key IN ('manager', 'owner-operator')
ON CONFLICT ("organizationRoleId", "capability") DO NOTHING;

-- PUR-01 (#979, PR J): licence verification is a second person's act. The
-- filing now records who filed it, so a later verifying filing can be refused
-- when the verifier is the filer. Nullable: earlier filings have no recorded
-- filer, and the router treats an unknown filer as "cannot prove it was someone
-- else". Adding a column does not fire the append-only row trigger.
ALTER TABLE "pharmacy_supplier_licences" ADD COLUMN IF NOT EXISTS "recordedByUserId" TEXT;

COMMIT;
