import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { can, subjectFromSession } from '@/lib/abac';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';
import { publicRequestOrigin } from '@/lib/http-origin';
import {
  CommercialLimitError,
  enrollDeviceWithinCommercialLimits,
} from '@/lib/restaurant/commercial-limits';
import {
  assertAuthorizedBranch,
  resolveCapabilityBranchAuthorization,
} from '@/lib/restaurant/staff-branch-authorization';
import { TERMINAL_DEVICE_COOKIE } from '@/lib/restaurant/terminal-auth';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { ipFromHeaders, recordAudit } from '@/server/audit';

const inputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  branchId: z.string().min(1),
  kind: z.enum(['POS', 'KDS']),
  stationId: z.string().optional(),
  confirmation: z.literal('confirmed'),
});

function reject(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  let exactOrigin = false;
  try {
    exactOrigin =
      Boolean(origin) && new URL(origin!).origin.toLowerCase() === publicRequestOrigin(request);
  } catch {
    exactOrigin = false;
  }
  if (!exactOrigin) {
    return reject('Enrollment request origin was not accepted.', 403);
  }

  let actor;
  try {
    actor = await resolveTenantActor({ request });
  } catch (error) {
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    throw error;
  }
  if (!actor?.session.user || !evaluateSessionUser(actor.session.user).ok) {
    return reject('A current administrator session is required.', 401);
  }
  if (actor.support) {
    return reject('Support sessions cannot enroll restaurant terminals.', 403);
  }
  if (actor.organization.isDemo) {
    return reject('Not available in demo.', 403);
  }
  const parsed = inputSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return reject('Review the terminal enrollment fields.', 400);
  const input = parsed.data;
  if (input.kind === 'KDS' && !input.stationId) return reject('Select a KDS station.', 400);

  const result = await withTenantDb(actor.organization.id, async (db) => {
    const allowed = await can(subjectFromSession(actor.session.user), 'devices:manage', undefined, {
      db,
      source: 'REST',
    });
    if (!allowed) return { denied: true } as const;
    const authorization = await resolveCapabilityBranchAuthorization(
      db,
      actor.session.user,
      'devices:manage',
      { organizationId: actor.organization.id }
    );
    assertAuthorizedBranch(authorization, input.branchId);
    const branch = await db.restaurantBranch.findUnique({ where: { id: input.branchId } });
    if (!branch) return null;
    if (input.kind === 'KDS') {
      const station = await db.restaurantKitchenStation.findFirst({
        where: { id: input.stationId, branchId: input.branchId, active: true },
      });
      if (!station) return null;
    }
    const entitlements = await resolveOrganizationEntitlements(actor.organization.id, db);
    return enrollDeviceWithinCommercialLimits(db, entitlements.limits, {
      name: input.name,
      branchId: input.branchId,
      kind: input.kind,
      stationId: input.kind === 'KDS' ? input.stationId : null,
    });
  }).catch((error: unknown) => {
    if (error instanceof CommercialLimitError) return { commercialLimit: error.message } as const;
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') return { denied: true } as const;
    throw error;
  });
  if (result && 'denied' in result) {
    return reject('Device-management permission is required.', 403);
  }
  if (result && 'commercialLimit' in result) return reject(result.commercialLimit, 403);
  if (!result) return reject('Branch or station was not found.', 404);

  recordAudit({
    organizationId: actor.organization.id,
    actorType: 'USER',
    actorId: actor.session.user.id,
    actorName: actor.session.user.name,
    actorEmail: actor.session.user.email,
    actorRole: actor.session.user.role,
    source: 'REST_API',
    category: 'TERMINAL',
    operation: 'CREATE',
    action: 'restaurant.devices.browserEnroll',
    description: `Enrolled browser as terminal device "${result.device.name}"`,
    targetType: 'RestaurantRegisteredDevice',
    targetId: result.device.id,
    targetLabel: result.device.name,
    metadata: {
      deviceId: result.device.id,
      branchId: result.device.branchId,
      kind: result.device.kind,
      stationId: result.device.stationId,
    },
    ip: ipFromHeaders(request.headers),
    userAgent: request.headers.get('user-agent'),
    httpMethod: 'POST',
    path: '/api/restaurant/devices/browser-enroll',
    statusCode: 303,
    outcome: 'SUCCESS',
  });

  const response = NextResponse.redirect(
    new URL(input.kind === 'KDS' ? '/kds' : '/pos', publicRequestOrigin(request)),
    { status: 303 }
  );
  response.cookies.set(TERMINAL_DEVICE_COOKIE, result.secret, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 180,
  });
  for (const name of ['authjs.session-token', '__Secure-authjs.session-token']) {
    response.cookies.set(name, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: name.startsWith('__Secure-'),
      path: '/',
      maxAge: 0,
      expires: new Date(0),
    });
  }
  return response;
}
