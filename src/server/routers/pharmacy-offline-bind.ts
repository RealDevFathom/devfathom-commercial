import { NextResponse } from 'next/server';
import { z } from 'zod';

import { can, subjectFromSession } from '@/lib/abac';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { counterBranchAssignmentDenial } from '@/lib/pharmacy/counter-capability';
import {
  counterDeviceCookieOptions,
  exactSameOrigin,
  PHARMACY_COUNTER_DEVICE_COOKIE,
  PHARMACY_COUNTER_DEVICE_COOKIE_MAX_AGE,
} from '@/lib/pharmacy/counter-device-cookie';
import { resolvePharmacyCounterBySecret } from '@/lib/pharmacy/offline-devices';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

/**
 * DEV-957 phase 1: hand an enrolled counter's credential to this browser as a
 * host-only, httpOnly, SameSite=Strict cookie, so the counter page never keeps
 * the raw secret in JavaScript-readable storage after enrolment.
 *
 * The secret was returned once by `pharmacyOffline.enroll` or `rotate` to the
 * same manager, in this same browser. Binding needs the same authority as
 * enrolment: a live web session (no support session), this site's exact Origin,
 * the pharmacy-counter module, `admin:access`, and an assignment to the
 * counter's branch (an organization ADMIN spans the organization). The device
 * must be ACTIVE and belong to this organization: the lookup runs under the
 * tenant's row level security, so another tenant's secret resolves to nothing.
 */
const bindSchema = z.object({ secret: z.string().regex(/^pcd_[A-Za-z0-9_-]{43}$/) }).strict();

function refuse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

const cookieOptions = counterDeviceCookieOptions;

export async function bindPharmacyCounterBrowser(request: Request): Promise<Response> {
  if (!(await rateLimit(`pharmacy-counter-bind:${clientIp(request)}`, 20, 60_000)).ok)
    return refuse('rate_limited', 429);
  if (!exactSameOrigin(request)) return refuse('origin_denied', 403);
  // The credential arrives in the body exactly once; a second channel is ambiguous.
  if (request.headers.get('authorization') !== null) return refuse('unauthorized_device', 401);
  const actor = await resolveTenantActor({ request });
  if (!actor || actor.support) return refuse('unauthorized', 401);
  let secret: string;
  try {
    const raw = await request.text();
    if (raw.length > 4_096) return refuse('body_too_large', 413);
    secret = bindSchema.parse(JSON.parse(raw || '{}')).secret;
  } catch {
    return refuse('invalid_body', 400);
  }
  type BindOutcome =
    | { error: string; status: number }
    | { device: { id: string; name: string; branchId: string; organizationId: string } };
  const result = await withTenantDb(actor.organization.id, async (db): Promise<BindOutcome> => {
    if (
      !hasModule(
        await resolveOrganizationEntitlements(actor.organization.id, db),
        'pharmacy-counter'
      )
    )
      return { error: 'module_disabled', status: 403 };
    const allowed = await can(subjectFromSession(actor.session.user), 'admin:access', undefined, {
      db,
      source: 'REST',
      ip: clientIp(request),
    });
    if (!allowed) return { error: 'forbidden', status: 403 };
    const device = await resolvePharmacyCounterBySecret(db, secret);
    if (
      !device ||
      device.organizationId !== actor.organization.id ||
      device.status !== 'ACTIVE' ||
      device.revokedAt
    )
      return { error: 'unauthorized_device', status: 401 };
    const branch = await db.pharmacyBranch.findFirst({
      where: { id: device.branchId, organizationId: actor.organization.id, active: true },
      select: { id: true },
    });
    if (!branch) return { error: 'branch_unavailable', status: 403 };
    const denial = await counterBranchAssignmentDenial(
      db,
      actor.session.user,
      actor.organization.id,
      device.branchId
    );
    if (denial) return { error: denial, status: 403 };
    // Who set this browser up as which counter, in the same transaction.
    await db.auditLog.create({
      data: {
        organizationId: actor.organization.id,
        actorId: actor.session.user.id,
        actorName: actor.session.user.name ?? null,
        actorEmail: actor.session.user.email ?? null,
        actorRole: actor.session.user.role ?? null,
        source: 'REST_API',
        category: 'PHARMACY',
        operation: 'EXECUTE',
        action: 'pharmacyOffline.bindCounterBrowser',
        targetType: 'PharmacyRegisteredDevice',
        targetId: device.id,
        httpMethod: 'POST',
        path: new URL(request.url).pathname,
        ip: clientIp(request),
        userAgent: request.headers.get('user-agent'),
        metadata: { branchId: device.branchId, deviceId: device.id },
      },
    });
    return {
      device: {
        id: device.id,
        name: device.name,
        branchId: device.branchId,
        organizationId: device.organizationId,
      },
    };
  });
  if ('error' in result) return refuse(result.error, result.status);
  const response = NextResponse.json(result, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
  response.cookies.set(
    PHARMACY_COUNTER_DEVICE_COOKIE,
    secret,
    cookieOptions(request, PHARMACY_COUNTER_DEVICE_COOKIE_MAX_AGE)
  );
  return response;
}

/**
 * Forget this browser's counter credential (sign-out of the counter, revocation
 * or re-enrolment). Clearing a cookie grants nothing, so it needs no session,
 * but it still needs this site's exact Origin so another site cannot log a
 * counter out from under a cashier.
 */
export async function unbindPharmacyCounterBrowser(request: Request): Promise<Response> {
  if (!exactSameOrigin(request)) return refuse('origin_denied', 403);
  const response = NextResponse.json(
    { cleared: true },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
  response.cookies.set(PHARMACY_COUNTER_DEVICE_COOKIE, '', cookieOptions(request, 0));
  return response;
}
