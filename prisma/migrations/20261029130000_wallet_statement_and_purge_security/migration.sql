-- Apply to already deployed wallets without rewriting migration history.
ALTER VIEW "stored_value_customer_statements" SET (security_invoker = true);

-- Match the platform retention worker's transaction settings. Naming a tenant
-- alone never grants deletion, and UPDATE is forbidden even during a purge.
CREATE OR REPLACE FUNCTION stored_value_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
     AND current_setting('app.is_platform_admin', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'stored-value ledger is append-only';
END $$;
