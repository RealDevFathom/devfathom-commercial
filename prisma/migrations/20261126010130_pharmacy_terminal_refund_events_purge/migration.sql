-- DEV-1056: card-terminal refund events must not block the purge of a closed business.
--
-- 20261122010000_pharmacy_terminal_refund_events gave the table a tenant and branch policy
-- with no platform-admin exception, and an append-only trigger that refuses every DELETE.
-- The retention worker purges a tenant table by table inside the platform control plane's
-- transaction ("app.is_platform_admin" = 'true', no current organization), so it could
-- neither see these rows nor delete them, and the rows they reference (the terminal
-- attempt, the refund, the journal entry) could then not be deleted either.
--
-- The policy's USING clause gains the platform-admin exception the other tenant tables carry,
-- so the purge can see and delete the rows. WITH CHECK does not: it stays the tenant and
-- branch scope of the original migration, so the control plane still cannot INSERT a refund
-- event (nor could an UPDATE pass it, were the trigger ever to admit one). The trigger
-- admits a DELETE only inside the purge of the row's own tenant: "app.is_platform_admin" =
-- 'true' AND "app.purging_organization_id" = the row's organization, as
-- 20261021104500_purge_guards_require_platform_admin requires of every purge guard. A tenant
-- transaction that names its own organization deletes nothing, and UPDATE is always refused.
--
-- Idempotent: DROP POLICY IF EXISTS before CREATE POLICY, CREATE OR REPLACE for the function.
-- The existing trigger binding (terminal_refund_immutable, BEFORE UPDATE OR DELETE) is kept.

BEGIN;
SET LOCAL lock_timeout = '10s';

DROP POLICY IF EXISTS terminal_refund_scope ON pharmacy_terminal_refund_events;
CREATE POLICY terminal_refund_scope ON pharmacy_terminal_refund_events
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
        OR "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  )
  WITH CHECK (
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND (
      NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
      OR "branchId" = current_setting('app.current_branch_id', true)
    )
  );

CREATE OR REPLACE FUNCTION pharmacy_terminal_refund_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.is_platform_admin', true) = 'true'
     AND NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId" THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'card terminal refund events are append-only' USING ERRCODE='55000';
END $$;

COMMIT;
