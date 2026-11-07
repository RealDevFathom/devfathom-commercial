import { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { isAdmin } from '@/lib/authz';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { portalStaffCommand } from '@/lib/pharmacy/customer-portal-contract';
import {
  CustomerPortalError,
  portalSettings,
  savePortalSettings,
  updatePortalRequest,
  portalEvent,
  type PortalRequest,
} from '@/lib/pharmacy/customer-portal';
import {
  assertPortalStaffBranch,
  reauthenticatePortalStaff,
} from '@/lib/pharmacy/customer-portal-staff';
import {
  assertPortalOrigin,
  portalBody,
  portalFailure,
  portalJson,
} from '@/lib/pharmacy/customer-portal-http';

export const runtime = 'nodejs';

async function actorFor(request: Request) {
  const actor = await resolveTenantActor({ request });
  if (!actor?.session.user.id)
    throw new CustomerPortalError(401, 'Sign in to the staff workspace.');
  if (actor.session.user.mustChangePassword)
    throw new CustomerPortalError(403, 'Change your temporary password first.');
  return actor;
}

async function authorize(
  db: Parameters<typeof portalSettings>[0],
  actor: NonNullable<Awaited<ReturnType<typeof resolveTenantActor>>>
) {
  const entitlements = await resolveOrganizationEntitlements(actor.organization.id, db);
  if (
    !hasModule(entitlements, 'pharmacy-crm') ||
    !hasModule(entitlements, 'pharmacy-dispensing') ||
    !(await can(subjectFromSession(actor.session.user), 'pharmacy:dispense', undefined, { db }))
  )
    throw new CustomerPortalError(403, 'Pharmacist access is required.');
}

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request);
    return await withTenantDb(
      actor.organization.id,
      async (db) => {
        await authorize(db, actor);
        const branches = await db.pharmacyBranch.findMany({
          where: {
            organizationId: actor.organization.id,
            active: true,
            ...(isAdmin(actor.session.user.role)
              ? {}
              : { branchAssignments: { some: { userId: actor.session.user.id, active: true } } }),
          },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        });
        const branchId = new URL(request.url).searchParams.get('branchId') || branches[0]?.id;
        if (!branchId)
          return portalJson({ branches, requests: [], settings: null, canConfigure: false });
        await assertPortalStaffBranch(db, actor.organization.id, actor.session.user, branchId);
        const requests = await db.$queryRaw<
          (PortalRequest & { customerName: string; patientId: string })[]
        >(Prisma.sql`
        SELECT r.*, c."displayName" AS "customerName", c."patientId" FROM pharmacy_customer_requests r
        JOIN pharmacy_customers c ON c."organizationId"=r."organizationId" AND c.id=r."customerId"
        WHERE r."organizationId"=${actor.organization.id} AND r."branchId"=${branchId}
        ORDER BY CASE WHEN r.status='AWAITING_PHARMACIST' THEN 0 WHEN r.status='APPROVED' THEN 1 ELSE 2 END, r."createdAt" DESC LIMIT 100`);
        await portalEvent(
          db,
          { organizationId: actor.organization.id, branchId },
          'QUEUE_READ',
          actor.session.user.id
        );
        return portalJson({
          branches,
          branchId,
          requests,
          settings: await portalSettings(db, actor.organization.id, branchId),
          canConfigure:
            isAdmin(actor.session.user.role) &&
            (await can(subjectFromSession(actor.session.user), 'admin:access', undefined, { db })),
        });
      },
      { userId: actor.session.user.id }
    );
  } catch (error) {
    return portalFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertPortalOrigin(request);
    const actor = await actorFor(request);
    const parsed = portalStaffCommand.safeParse(await portalBody(request, 16 * 1024));
    if (!parsed.success) throw new CustomerPortalError(400, 'Check the form fields.');
    const input = parsed.data;
    return await withTenantDb(
      actor.organization.id,
      async (db) => {
        await authorize(db, actor);
        await assertPortalStaffBranch(
          db,
          actor.organization.id,
          actor.session.user,
          input.branchId
        );
        if (
          input.action === 'settings' &&
          (!isAdmin(actor.session.user.role) ||
            !(await can(subjectFromSession(actor.session.user), 'admin:access', undefined, { db })))
        )
          throw new CustomerPortalError(
            403,
            'Only the pharmacy administrator can configure customer service.'
          );
        const scope = {
          organizationId: actor.organization.id,
          branchId: input.branchId,
          actorId: actor.session.user.id,
        };
        if (!(await reauthenticatePortalStaff(db, scope, input.pin)))
          return portalJson({ error: 'Your PIN is invalid or locked. Try again later.' }, 403);
        if (input.action === 'settings')
          return portalJson(await savePortalSettings(db, scope, input.settings));
        return portalJson(
          await updatePortalRequest(db, scope, input.requestId, input.action, input.saleId)
        );
      },
      { userId: actor.session.user.id }
    );
  } catch (error) {
    return portalFailure(error);
  }
}
