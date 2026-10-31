-- Public supplier-link budgets use existing rows and require no schema change.
-- This migration only permits the mandatory solo-owner purchasing workflow.
-- It retains database-level refusal for ordinary self approval, including an
-- owner with another active person in the tenant / affected branch.
BEGIN;

-- search_path is pinned and every relation is schema-qualified so a caller's
-- session search_path cannot redirect the lookups.
CREATE FUNCTION public.pharmacy_solo_purchase_owner(org text, actor text, branch text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(current_setting('app.pharmacy_purchase_pin_verified_user_id', true) = actor, false) AND EXISTS (
    SELECT 1 FROM public.users u LEFT JOIN public.organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=org
    WHERE u.id=actor AND u."organizationId"=org AND u.status='ACTIVE'
      AND ((r."isSystem" AND r.key IN ('owner','owner-operator')) OR
        (u.role='ADMIN' AND EXISTS (
          SELECT 1 FROM public.organization_role_permissions p WHERE p."organizationRoleId"=r.id AND p.capability='*' AND p.effect='ALLOW'
          UNION ALL
          SELECT 1 FROM public.user_permission_overrides p WHERE p."userId"=u.id AND p.capability='*' AND p.effect='ALLOW' AND (p."expiresAt" IS NULL OR p."expiresAt">now())
        )))
  ) AND NOT EXISTS (
    SELECT 1 FROM public.users u LEFT JOIN public.organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=org
    WHERE u."organizationId"=org AND u.status='ACTIVE' AND u.id<>actor
      AND (branch IS NULL OR EXISTS (
        SELECT 1 FROM public.pharmacy_branch_assignments a WHERE a."organizationId"=org AND a."userId"=u.id AND a."branchId"=branch AND a.active
      ) OR (r."isSystem" AND r.key IN ('owner','owner-operator')) OR
        (u.role='ADMIN' AND EXISTS (
          SELECT 1 FROM public.organization_role_permissions p WHERE p."organizationRoleId"=r.id AND p.capability='*' AND p.effect='ALLOW'
          UNION ALL
          SELECT 1 FROM public.user_permission_overrides p WHERE p."userId"=u.id AND p.capability='*' AND p.effect='ALLOW' AND (p."expiresAt" IS NULL OR p."expiresAt">now())
        )))
  );
$$;

-- Locate the original anonymous CHECK by its expression rather than relying on
-- PostgreSQL's ordinal-generated name.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid='pharmacy_purchase_orders'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%"approvedByUserId" <> "createdByUserId"%';
  EXECUTE format('ALTER TABLE pharmacy_purchase_orders DROP CONSTRAINT %I', constraint_name);
END $$;
ALTER TABLE pharmacy_goods_receipts DROP CONSTRAINT pharmacy_goods_receipts_bypass_actor_check;

-- Validate approval events, not every later stock/status update. A receipt
-- approved while the owner was solo remains valid if another person joins.
CREATE FUNCTION public.pharmacy_check_solo_order_approval() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."approvedByUserId" = NEW."createdByUserId" THEN
    IF TG_OP = 'UPDATE' THEN
      IF (NEW."organizationId", NEW."approvedByUserId", NEW."createdByUserId", NEW."branchId", NEW."approvedAt")
        IS NOT DISTINCT FROM (OLD."organizationId", OLD."approvedByUserId", OLD."createdByUserId", OLD."branchId", OLD."approvedAt")
        AND NOT (NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED') THEN RETURN NEW; END IF;
    END IF;
    IF NOT public.pharmacy_solo_purchase_owner(NEW."organizationId", NEW."approvedByUserId", NEW."branchId") THEN
      RAISE EXCEPTION 'purchase order self approval requires solo owner PIN reauthentication' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_purchase_order_approval_actor_check BEFORE INSERT OR UPDATE ON pharmacy_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.pharmacy_check_solo_order_approval();

CREATE FUNCTION public.pharmacy_check_solo_receipt_approval() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."bypassApprovedByUserId" = NEW."receivedByUserId" THEN
    IF TG_OP = 'UPDATE' THEN
      IF (NEW."organizationId", NEW."bypassApprovedByUserId", NEW."receivedByUserId", NEW."branchId", NEW."bypassApprovedAt", NEW."bypassReason")
        IS NOT DISTINCT FROM (OLD."organizationId", OLD."bypassApprovedByUserId", OLD."receivedByUserId", OLD."branchId", OLD."bypassApprovedAt", OLD."bypassReason") THEN RETURN NEW; END IF;
    END IF;
    IF NOT public.pharmacy_solo_purchase_owner(NEW."organizationId", NEW."bypassApprovedByUserId", NEW."branchId") THEN
      RAISE EXCEPTION 'receipt self approval requires solo owner PIN reauthentication' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_goods_receipts_bypass_actor_check BEFORE INSERT OR UPDATE ON pharmacy_goods_receipts
  FOR EACH ROW EXECUTE FUNCTION public.pharmacy_check_solo_receipt_approval();

COMMIT;
