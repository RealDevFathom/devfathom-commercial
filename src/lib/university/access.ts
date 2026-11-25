import 'server-only';
import { decideFromRules } from '@/lib/abac/capabilities';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import type { EntitlementView } from '@/lib/module-catalog';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { officeRoleAllowed, type UniversityContext, type UniversityOffice } from './office-types';

export class UniversityAccessError extends Error {
  constructor() {
    super('You do not have access to this university office.');
  }
}
type Rule = { capability: string; effect: string };
export interface StaffContext extends UniversityContext {
  rules: Rule[];
  coverage: 'INSTITUTION' | 'CAMPUS' | 'UNIT' | 'NONE';
  entitlements: EntitlementView;
}

export async function universityStaffContext(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  entitlements: EntitlementView
): Promise<StaffContext> {
  if (entitlements.vertical !== 'UNIVERSITY' || !hasModule(entitlements, 'university-core'))
    throw new UniversityAccessError();
  const member = await db.user.findFirst({
    where: { id: userId, organizationId, status: 'ACTIVE' },
    select: {
      role: true,
      organizationRole: {
        select: {
          organizationId: true,
          key: true,
          isSystem: true,
          permissions: { select: { capability: true, effect: true } },
        },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (
    !member ||
    (member.organizationRole && member.organizationRole.organizationId !== organizationId)
  )
    throw new UniversityAccessError();
  const roleKey = member.organizationRole?.isSystem ? member.organizationRole.key : '';
  const admin =
    member.role === 'ADMIN' && (!member.organizationRole || roleKey === 'university-admin');
  const scopes = admin
    ? []
    : await db.$queryRaw<
        { level: 'INSTITUTION' | 'CAMPUS' | 'UNIT' }[]
      >`SELECT DISTINCT level FROM university_staff_scopes WHERE organization_id=${organizationId} AND user_id=${userId}`;
  const coverage =
    admin || scopes.some((s) => s.level === 'INSTITUTION')
      ? 'INSTITUTION'
      : scopes.some((s) => s.level === 'CAMPUS')
        ? 'CAMPUS'
        : scopes.length
          ? 'UNIT'
          : 'NONE';
  await db.$queryRaw`SELECT set_config('app.university_staff_scope', ${coverage === 'INSTITUTION' ? 'institution' : 'bounded'}, true)`;
  return {
    db,
    organizationId,
    userId,
    roleKey,
    entitlements,
    admin,
    coverage,
    rules: [...member.permissionOverrides, ...(member.organizationRole?.permissions ?? [])],
  };
}

export function canAccessOffice(ctx: StaffContext, office: UniversityOffice) {
  if (ctx.coverage === 'NONE') return false;
  if (
    ctx.coverage !== 'INSTITUTION' &&
    ![
      'university-admissions',
      'university-academics',
      ...(ctx.coverage === 'CAMPUS' ? ['university-services'] : []),
    ].includes(office.moduleKey)
  )
    return false;
  const capability = office.moduleKey.replace('university-', 'university:');
  return (
    hasModule(ctx.entitlements, office.moduleKey) &&
    decideFromRules(ctx.rules, capability) === true &&
    officeRoleAllowed(ctx, office.roles)
  );
}

export async function withUniversityStaff<T>(run: (ctx: StaffContext) => Promise<T>) {
  const actor = await resolveTenantActor();
  if (
    !actor?.session.user?.id ||
    actor.support ||
    actor.session.user.mustChangePassword ||
    actor.session.user.approvalAuthenticatorSetupRequired
  )
    throw new UniversityAccessError();
  const organizationId = actor.organization.id;
  const userId = actor.session.user.id;
  return withTenantDb(
    organizationId,
    async (db) => {
      const entitlements = await resolveOrganizationEntitlements(organizationId, db);
      return run(await universityStaffContext(db, organizationId, userId, entitlements));
    },
    { userId }
  );
}

export function canPerformOfficeAction(
  ctx: StaffContext,
  office: UniversityOffice,
  action: UniversityOffice['actions'][number]
) {
  if (action.strictRoles && !(action.roles ?? office.roles).includes(ctx.roleKey)) return false;
  if (action.institutionWide && ctx.coverage !== 'INSTITUTION') return false;
  return canAccessOffice(ctx, office) && officeRoleAllowed(ctx, action.roles ?? office.roles);
}

export async function bindOfficeScope(ctx: StaffContext, office: UniversityOffice) {
  await ctx.db.$queryRaw`SELECT set_config('app.university_office',${office.moduleKey},true)`;
}
