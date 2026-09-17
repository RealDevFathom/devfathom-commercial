-- PROP-04 (G3/G4) — the property-access cutover.
--
-- `20260915003000_hotel_property_access` is purely additive: it creates
-- `hotel_property_assignments`, its tenant policies and its control-plane
-- policies, and restricts nothing. THIS file is the only one that closes access,
-- and it is written so that it either closes access correctly or closes nothing
-- at all.
--
-- ATOMICITY, which is the whole shape of this file. `prisma migrate deploy` runs
-- one transaction PER FILE. So the restriction and the guard that refuses to
-- install it must be in the SAME file: the policy is CREATEd here with its
-- control-plane branch already in place, and the guard runs below it in the same
-- transaction. If the guard raises — or anything else here does — the CREATE
-- POLICY rolls back with it and the database is left exactly as it was: every
-- property still reachable by whoever could reach it a moment earlier, and the
-- assignment table from `003000` still present and still writable by the control
-- plane. There is no state in which this deploy commits a lockout and promises a
-- repair afterwards.
--
-- What is NOT changed: tenant semantics stay as strict as they were specified. A
-- tenant connection needs its own organization, an ACTIVE property and an active
-- assignment held by an ACTIVE/ON_LEAVE user. Platform identity, MFA, session
-- separation (ADR-002) and the `organizations:write` capability check on
-- `/api/platform/control` are unchanged and stay server-side —
-- `app.is_platform_admin` is set only by `withPlatformDb`, and `withTenantDb`
-- sets it to 'false' on every tenant transaction, so this admits the control
-- plane and nothing else. SQL assignment membership is never a substitute for
-- the application's capability checks, and being visible in SQL is not the same
-- as resolving a tRPC property scope — `requireHotelPropertyScope` additionally
-- requires a hospitality role key, which no SQL policy here inspects.

-- 1. The restriction, CREATEd once, complete. The control-plane branch is part
--    of the policy from the moment it exists rather than being ALTERed in
--    afterwards, so there is no instant — not even a failed one — at which
--    `hotel_properties` is closed to `withPlatformDb`. That matters beyond
--    tidiness: under `withPlatformDb` the organization GUC is the empty string
--    and no user GUC is set, so without this branch the tenant expression
--    evaluates to NULL for every row and `organization.create` cannot insert a
--    property at all — its `INSERT ... RETURNING` fails the WITH CHECK that
--    `FOR ALL USING` doubles as, and the RETURNING clause is filtered by the same
--    expression. That is the creation/RETURNING circularity: the first assignment
--    cannot be written before the property exists, and the property cannot be
--    written without one.
--
--    Declaring `USING` and no `WITH CHECK` is deliberate: PostgreSQL then reuses
--    the USING expression as the write check, which is what makes one clause
--    govern reads and writes alike. `AS RESTRICTIVE` means it is ANDed with the
--    existing permissive `hotel_properties_tenant_isolation`, never ORed — no
--    Owner/GM shortcut, no organization-membership bypass and no blank-user
--    bypass can be introduced by adding a permissive policy elsewhere.
CREATE POLICY "hotel_properties_assigned_user" ON "hotel_properties"
  AS RESTRICTIVE FOR ALL
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND "active"
      AND EXISTS (
        SELECT 1 FROM "hotel_property_assignments" assignment
        JOIN "users" actor ON actor."organizationId" = assignment."organizationId"
          AND actor."id" = assignment."userId"
        WHERE assignment."organizationId" = "hotel_properties"."organizationId"
          AND assignment."branchId" = "hotel_properties"."branchId"
          AND assignment."userId" = NULLIF(current_setting('app.current_user_id', true), '')
          AND assignment."active" AND actor."status" IN ('ACTIVE', 'ON_LEAVE')
      )
    )
  );

-- 2. Refuse the cutover on any database the cutover would strand.
--
--    A `hotel_properties` row that predates this file was written before anything
--    created assignments, so once the restriction lands its tenant cannot see it
--    — and cannot fix that from inside the tenant, because the tenant write
--    policy requires an assignment the tenant does not have. There is no correct
--    automatic repair: which user is the real manager of an existing property is
--    an operator's decision about actual identities, and inferring one (oldest
--    admin, first employee, everyone in the organization) would invent an access
--    grant nobody made. Nothing here derives a mapping.
--
--    WHAT "ELIGIBLE" MEANS HERE, and why it is not just "a row exists". The
--    check below is the restrictive policy's own tenant predicate: an ACTIVE
--    assignment whose holder is an ACTIVE/ON_LEAVE user. A revoked assignment or
--    one held by someone who has left grants nothing, so counting it would let
--    the guard pass on a database this migration is about to strand. It
--    validates explicit targets that can genuinely reach the property, not the
--    mere presence of a row.
--
--    NON-VACUITY. The GUC is set deliberately: `hotel_properties` is FORCE ROW
--    LEVEL SECURITY, so this block runs as the owning role and is filtered like
--    anyone else — and the policy created above is already in force inside this
--    transaction. With no flag the count would be 0 on every database and the
--    guard would pass vacuously, which is the one failure mode a fail-closed
--    check must not have. It is set transaction-locally and cleared below, and
--    Prisma runs each migration in its own transaction, so it cannot leak past
--    this file.
--
--    THE SUPPORTED CUTOVER, executable in this order. No claim is made about what
--    any particular environment currently contains; that is what the guard is
--    for, and this file inspected nothing.
--
--      a. Deploy `20260915003000_hotel_property_access` alone. It is additive:
--         it creates the table and its policies and restricts nothing, so it is
--         safe to leave applied for as long as the mapping takes.
--             prisma migrate deploy   # stops here if 010000 is withheld, or
--                                     # continues to (c) and fails closed.
--
--      b. With the table now existing, the operator records the real mapping,
--         one explicit tuple per property, from a control-plane connection. The
--         platform INSERT policy added in `003000` is what admits this, and the
--         GUC below is what satisfies it:
--             BEGIN;
--             SELECT set_config('app.is_platform_admin', 'true', true);
--             INSERT INTO "hotel_property_assignments"
--               ("id", "organizationId", "branchId", "userId", "organizationRoleId",
--                "active", "updatedAt")
--             VALUES
--               (<id>, <organizationId>, <branchId>, <userId>, <organizationRoleId>,
--                true, CURRENT_TIMESTAMP);
--             COMMIT;
--         `id` and `updatedAt` are supplied because neither column has a database
--         default (Prisma's `@updatedAt` is client-side). `organizationId` must be
--         named explicitly: its column default reads the organization GUC, which
--         is blank on a platform connection, and the platform INSERT policy
--         rejects a blank one rather than writing an orphan. The composite foreign
--         keys then force the property, the user and the role to belong to that
--         one organization. The user must be ACTIVE or ON_LEAVE and the role must
--         be one of that organization's hospitality roles for the assignment to
--         resolve a tRPC scope as well as a SQL row.
--
--      c. Deploy this file. The guard re-checks (b) against the same predicate the
--         policy enforces and the deploy proceeds only if nothing is stranded.
--
--    IF THIS FILE RAISES. The transaction rolls back whole — the policy above is
--    not installed and access is unchanged — but `_prisma_migrations` keeps a
--    row for `20260915010000_hotel_property_maintenance` with `finished_at` NULL
--    and the error in `logs`, and Prisma refuses every later deploy until it is
--    resolved. Clear it explicitly before redeploying:
--        prisma migrate resolve --rolled-back 20260915010000_hotel_property_maintenance
--    then complete step (b) for the properties the error named and deploy again.
--    Do not edit this file to get past the guard.
--
--    AFTERWARDS, `organization.hotelproperty.recover`
--    { organizationId, branchId, userId, organizationRoleId, reason } is the
--    audited command that assigns or retargets a manager, and
--    `organization.hotelproperty.deactivate` / `.reactivate` take one named
--    property out of and back into service.
DO $$
DECLARE
  stranded text;
  stranded_count integer;
  closing text;
  closing_count integer;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);

  SELECT count(*), string_agg(format('%s/%s', "organizationId", "branchId"), ', ' ORDER BY "organizationId", "branchId")
    INTO stranded_count, stranded
    FROM "hotel_properties" property
   WHERE NOT EXISTS (
     SELECT 1
       FROM "hotel_property_assignments" assignment
       JOIN "users" actor ON actor."organizationId" = assignment."organizationId"
        AND actor."id" = assignment."userId"
      WHERE assignment."organizationId" = property."organizationId"
        AND assignment."branchId" = property."branchId"
        AND assignment."active"
        AND actor."status" IN ('ACTIVE', 'ON_LEAVE')
   );

  -- Reported, not raised on. An INACTIVE property is denied to its tenant after
  -- this file even when an eligible manager holds it, because the policy's own
  -- `"active"` predicate closes it. That is the deactivation semantics working
  -- rather than a lockout — `organization.hotelproperty.reactivate` is the named
  -- way back and the control plane still reaches the row — so it is said out
  -- loud instead of raised on, and so the operator is not surprised by a property
  -- becoming invisible for a reason that is not the assignment.
  SELECT count(*), string_agg(format('%s/%s', "organizationId", "branchId"), ', ' ORDER BY "organizationId", "branchId")
    INTO closing_count, closing
    FROM "hotel_properties" property
   WHERE NOT property."active";

  PERFORM set_config('app.is_platform_admin', 'false', true);

  IF closing_count > 0 THEN
    RAISE NOTICE
      'PROP-04: % inactive hotel property/properties (%) stay closed to their tenants after this cutover, by the policy''s own "active" predicate. Use organization.hotelproperty.reactivate to return one to service.',
      closing_count, closing;
  END IF;

  IF stranded_count > 0 THEN
    RAISE EXCEPTION
      'PROP-04 cutover refused: % hotel property/properties have no eligible assignment — an ACTIVE assignment held by an ACTIVE/ON_LEAVE user — and would be unreachable by their tenants (%). This migration rolled back whole, so access is unchanged; run "prisma migrate resolve --rolled-back 20260915010000_hotel_property_maintenance", insert the operator-decided hotel_property_assignments rows for these properties, then redeploy. No mapping is inferred.',
      stranded_count, stranded
      USING ERRCODE = 'raise_exception';
  END IF;
END
$$;
