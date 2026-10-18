-- Narrow compatibility for canonical synthetic Restaurant seats only. Ordinary
-- history remains append-only; UPDATE, tenant/branch RLS and every FK stay intact.
CREATE FUNCTION public.restaurant_demo_reset_compatibility_allowed(row_organization_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
    public.restaurant_demo_reset_allowed(row_organization_id)
    AND EXISTS (
      SELECT 1 FROM public.organizations AS organization
       WHERE organization.id = row_organization_id
         AND organization.id ~ '^org_demo_restaurant_seat_([1-9]|1[0-9]|2[0-5])$'
         AND organization.slug = replace(
           organization.id, 'org_demo_restaurant_seat_', 'demo-restaurant-seat-'
         )
    ), false
  );
$$;

CREATE OR REPLACE FUNCTION public.deny_catering_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_compatibility_allowed(OLD."organizationId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'catering history is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_catering_money_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_compatibility_allowed(OLD."organizationId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Catering money evidence is append-only';
END;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_growth_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_compatibility_allowed(OLD."organizationId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Restaurant growth ledger is append only' USING ERRCODE = '23514';
END;
$$;

-- Existing tenant SELECT policies remain unchanged. Growth keeps its exact-branch
-- policy; reset must visit and verify each branch rather than widen visibility.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'restaurant_catering_events',
    'restaurant_catering_branch_capacity',
    'restaurant_catering_quote_revisions',
    'restaurant_catering_quote_approvals',
    'restaurant_catering_dispositions',
    'restaurant_catering_commands',
    'restaurant_catering_money_evidence'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY restaurant_demo_reset_delete ON public.%I FOR DELETE USING (public.restaurant_demo_reset_compatibility_allowed("organizationId"))',
      table_name
    );
  END LOOP;
END;
$$;
