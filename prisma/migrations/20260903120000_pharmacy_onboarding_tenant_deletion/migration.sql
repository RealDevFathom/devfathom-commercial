-- WHA-1209 — tenant deletion versus the append-only onboarding history.
--
-- PLAT-03 (20260902160000_pharmacy_onboarding_and_branch) made
-- "pharmacy_onboarding_events" append-only with an unconditional
-- BEFORE UPDATE OR DELETE trigger. That is right for a regulated activation
-- decision while the tenant exists. It also refused the ON DELETE CASCADE the
-- same migration declared on the row's own parent, so once an operator confirmed
-- a single onboarding step the tenant could not be deleted by any role — the
-- table owner included — and the platform's PURGING → PURGED retention path
-- could never finish. Only ALTER TABLE ... DISABLE TRIGGER got past it, which is
-- why the PLAT-03 database suite has to do exactly that to drop its own fixture.
--
-- The history stays append-only for the life of the tenant. It is destroyed only
-- when the tenant itself is destroyed, and only through the two paths that carry
-- that decision:
--
--   1. The organization row is already gone. "pharmacy_onboarding_states"
--      declares ON DELETE CASCADE onto "organizations", and PostgreSQL deletes
--      the parent row before running the referential action — so inside a
--      cascading delete the owning organization can no longer be found. A direct
--      DELETE against the history of a tenant that still exists does find that
--      row, and is still refused.
--
--      The lookup cannot be spoofed by hiding the parent: "organizations" is
--      FORCE row-level security under the same predicate as this table, so any
--      role that can see an event row can also see its organization. A role that
--      cannot see the organization cannot see the event either, and so has
--      nothing here to delete.
--
--   2. "app.purging_organization_id" names this row's tenant. The retention
--      worker deletes tenant data table by table rather than through a cascade,
--      so it has no parent row to remove first and case 1 cannot apply to it.
--      The setting is written with set_config(..., true) inside the purge
--      transaction, names one organization, and is set in no other code path —
--      so it authorises the purge of one named tenant's history and nothing else.
--
-- UPDATE stays refused unconditionally. No path rewrites this history; the only
-- question this migration answers is when it may be destroyed with its tenant.

CREATE OR REPLACE FUNCTION pharmacy_assert_onboarding_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The sanctioned purge of this row's own tenant.
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId" THEN
      RETURN OLD;
    END IF;
    -- The declared ON DELETE CASCADE: the organization row is already gone.
    IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'pharmacy onboarding events are append-only; delete or purge the organization to remove its onboarding history'
      USING ERRCODE = 'P0001';
  END IF;

  RAISE EXCEPTION 'pharmacy onboarding events are append-only' USING ERRCODE = 'P0001';
END $$;
