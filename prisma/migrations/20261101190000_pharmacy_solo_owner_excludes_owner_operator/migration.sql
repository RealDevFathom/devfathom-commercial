-- The owner-operator role template is an operational bundle, not tenant
-- ownership. Only the system owner role, or an ADMIN with a live '*' grant, may
-- use the solo-owner purchase self-approval exception. Other active people,
-- including owner-operators, still count as present and keep maker-checker on.
BEGIN;

CREATE OR REPLACE FUNCTION public.pharmacy_solo_purchase_owner(org text, actor text, branch text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(current_setting('app.pharmacy_purchase_pin_verified_user_id', true) = actor, false) AND EXISTS (
    SELECT 1 FROM public.users u LEFT JOIN public.organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=org
    WHERE u.id=actor AND u."organizationId"=org AND u.status='ACTIVE'
      AND ((r."isSystem" AND r.key='owner') OR
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

COMMIT;
