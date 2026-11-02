-- A custody record's witness is a user of the same tenant (DEV-124, GitHub #657).
--
-- "pharmacy_custody_records"."witnessId" was a plain TEXT column: nothing in the
-- database tied it to a person, so co-authorisation evidence for a write-off or
-- a count variance could name anyone. writeOff and the variance path now check
-- that the witness is an ACTIVE user with an active assignment to the branch
-- (#911, src/lib/pharmacy/inventory-operations.ts and
-- src/server/routers/pharmacy-inventory.ts); this makes the tenant half of that
-- rule a database guarantee for every writer. Activity and branch assignment
-- change over time, so they stay application checks made at write time; the
-- existing CHECK ("actorId" <> "witnessId") already forbids self-witnessing.
--
-- Composite (organizationId, witnessId) -> users(organizationId, id), matching
-- the other tenant references: a witness can never be another tenant's user.
-- DEFERRABLE INITIALLY DEFERRED like the tenant FKs in 20260728091000. With the
-- default NO ACTION a witnessed user cannot be hard-deleted, which is what custody
-- evidence needs; users leave by deactivation.
--
-- KNOWN GAP (pre-existing, not introduced here): the retention purge cannot
-- remove a pharmacy tenant that has custody rows. Its deletion plan orders
-- "pharmacy_custody_records" before "users" from these catalog edges, but the
-- custody table's append-only trigger (pharmacy_reject_append_only_change, which
-- also guards "pharmacy_stock_movements" and the other pharmacy ledgers) raises
-- unconditionally and has no purge-context exemption. The purge's DELETE on
-- custody or stock-movement rows therefore fails and the whole purge rolls back
-- before this FK is ever reached. Tenants without such rows purge as before.
-- Follow-up: give pharmacy_reject_append_only_change the same exact-purge-context
-- exemption the other append-only ledgers use ("app.purging_organization_id" =
-- OLD."organizationId" plus "app.is_platform_admin"), and seed custody and
-- stock-movement rows in the purge DB test.
--
-- Rows written before #911 may name a witness that is not a user of the tenant.
-- The constraint is added NOT VALID so it binds every new row without failing on
-- that history, then validated here when no such row exists. Where it cannot be
-- validated the migration raises a NOTICE; the rows are evidence and are not
-- rewritten.
--
-- Idempotent: the constraint and index are added only when absent, and the
-- count and VALIDATE are skipped once the constraint is validated.

BEGIN;

-- Both tables FORCE row-level security, including for their owner. Count as the
-- control plane, or a migration role would see no rows, skip the notice and then
-- fail VALIDATE (which, like every RI check, ignores RLS). Set it in its own
-- statement; the setting is transaction-local and is cleared by COMMIT.
SELECT set_config('app.is_platform_admin', 'true', true);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"pharmacy_custody_records"'::regclass
       AND conname = 'tenant_pharmacy_custody_witness_users_fk'
  ) THEN
    ALTER TABLE "pharmacy_custody_records"
      ADD CONSTRAINT "tenant_pharmacy_custody_witness_users_fk"
      FOREIGN KEY ("organizationId", "witnessId") REFERENCES "users" ("organizationId", "id")
      DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
END
$$;

DO $$
DECLARE
  unmatched bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"pharmacy_custody_records"'::regclass
       AND conname = 'tenant_pharmacy_custody_witness_users_fk'
       AND convalidated
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO unmatched
    FROM "pharmacy_custody_records" c
   WHERE NOT EXISTS (
     SELECT 1 FROM "users" u WHERE u."organizationId" = c."organizationId" AND u."id" = c."witnessId"
   );
  IF unmatched = 0 THEN
    ALTER TABLE "pharmacy_custody_records"
      VALIDATE CONSTRAINT "tenant_pharmacy_custody_witness_users_fk";
  ELSE
    RAISE NOTICE
      'tenant_pharmacy_custody_witness_users_fk left NOT VALID: % custody record(s) predate witness validation and name no user of their tenant',
      unmatched;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "pharmacy_custody_records_org_witness_idx"
  ON "pharmacy_custody_records" ("organizationId", "witnessId");

COMMIT;
