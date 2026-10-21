-- PROP-04: explicit per-property role assignments. No grants or backfill.
--
-- This file is PURELY ADDITIVE and is safe to apply on its own. It creates the
-- assignment table, its tenant policies and its control-plane policies, and it
-- imposes NO new restriction on `hotel_properties`. Every property that is
-- readable before this migration is readable after it, by exactly the same
-- connections. The restrictive property policy that makes an assignment
-- load-bearing is created by `20260915010000_hotel_property_maintenance`, which
-- is the one file that can close access and is written so that a failure closes
-- nothing. Splitting them here is deliberate: `migrate deploy` runs one
-- transaction PER FILE, so a lockout and its guard must not live in two files.
CREATE UNIQUE INDEX "organization_roles_org_id_key" ON "organization_roles" ("organizationId", "id");

CREATE TABLE "hotel_property_assignments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationRoleId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_property_assignments_property_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties" ("organizationId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "hotel_property_assignments_user_fkey" FOREIGN KEY ("organizationId", "userId")
    REFERENCES "users" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "hotel_property_assignments_role_fkey" FOREIGN KEY ("organizationId", "organizationRoleId")
    REFERENCES "organization_roles" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "hotel_property_assignments_org_branch_user_key"
  ON "hotel_property_assignments" ("organizationId", "branchId", "userId");
CREATE INDEX "hotel_property_assignments_organizationId_userId_active_idx"
  ON "hotel_property_assignments" ("organizationId", "userId", "active");

ALTER TABLE "hotel_property_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_property_assignments" FORCE ROW LEVEL SECURITY;

-- Assignment metadata is tenant-scoped. Property contents are additionally
-- assignment-scoped below. Keep this SELECT non-recursive: write policies and
-- property policies consult it. Server endpoints expose only authorized scope.
CREATE POLICY "hotel_property_assignments_tenant_read" ON "hotel_property_assignments"
  FOR SELECT USING (
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND NULLIF(current_setting('app.current_user_id', true), '') IS NOT NULL
  );

-- No self-grant and no branch bootstrap via the tenant runtime. Management
-- capability checks remain independently enforced by the native audited API.
CREATE POLICY "hotel_property_assignments_scoped_insert" ON "hotel_property_assignments"
  FOR INSERT WITH CHECK (
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND "userId" <> NULLIF(current_setting('app.current_user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "hotel_property_assignments" actor
      WHERE actor."organizationId" = "hotel_property_assignments"."organizationId"
        AND actor."branchId" = "hotel_property_assignments"."branchId"
        AND actor."userId" = NULLIF(current_setting('app.current_user_id', true), '')
        AND actor."active"
    )
  );
CREATE POLICY "hotel_property_assignments_scoped_update" ON "hotel_property_assignments"
  FOR UPDATE USING (
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND "userId" <> NULLIF(current_setting('app.current_user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "hotel_property_assignments" actor
      WHERE actor."organizationId" = "hotel_property_assignments"."organizationId"
        AND actor."branchId" = "hotel_property_assignments"."branchId"
        AND actor."userId" = NULLIF(current_setting('app.current_user_id', true), '')
        AND actor."active"
    )
  );
-- UPDATE's USING is also its WITH CHECK; DELETE has no policy. Revoke by flag.

-- The control plane's own access to the assignment table. PERMISSIVE, so the
-- three tenant policies above keep their exact text and behaviour — permissive
-- policies are ORed, never ANDed. All three verbs, for distinct reasons: SELECT
-- to recheck a locked tuple, INSERT to write the first assignment of a
-- property's life (G1 bootstrap) and to restore one after manager loss (G2
-- recovery), UPDATE to retarget or revoke one.
--
-- These live in THIS file rather than in the cutover file on purpose. The table
-- is FORCE ROW LEVEL SECURITY, so without them nothing — the control plane and
-- the owning role included — could write a row between this migration and the
-- next, and the operator mapping step the cutover documents would be
-- unexecutable. The table must exist AND be writable by the control plane before
-- any mapping can be recorded.
--
-- There is no DELETE policy anywhere on this table, for the control plane
-- included: an assignment is revoked by lowering `active`, so the ledger keeps
-- the row that records access was once granted.
--
-- `organizationId` is DEFAULT current_setting('app.current_organization_id'),
-- which is the empty string inside a platform transaction. Requiring it to be
-- non-blank stops a command that forgot to name the tenant from writing an
-- orphan row; the composite foreign keys to `hotel_properties`, `users` and
-- `organization_roles` then force the whole tuple to belong to one organization.
CREATE POLICY "hotel_property_assignments_platform_read" ON "hotel_property_assignments"
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY "hotel_property_assignments_platform_insert" ON "hotel_property_assignments"
  FOR INSERT WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    AND length(btrim("organizationId")) > 0
  );

CREATE POLICY "hotel_property_assignments_platform_update" ON "hotel_property_assignments"
  FOR UPDATE USING (
    current_setting('app.is_platform_admin', true) = 'true'
  ) WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    AND length(btrim("organizationId")) > 0
  );

-- Deliberately NOT here: the RESTRICTIVE policy on `hotel_properties`. Holding
-- an assignment does not yet gate anything — this file only makes it possible to
-- record one. See `20260915010000_hotel_property_maintenance`.
