import { NextResponse } from 'next/server';
import { z } from 'zod';

import { can, subjectFromSession } from '@/lib/abac';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { publicRequestOrigin } from '@/lib/http-origin';
import { enrollDevice } from '@/lib/restaurant/devices';
import { TERMINAL_DEVICE_COOKIE } from '@/lib/restaurant/terminal-auth';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

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

  const actor = await resolveTenantActor({ request });
  if (!actor?.session.user || !evaluateSessionUser(actor.session.user).ok) {
    return reject('A current administrator session is required.', 401);
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
    const branch = await db.restaurantBranch.findUnique({ where: { id: input.branchId } });
    if (!branch) return null;
    if (input.kind === 'KDS') {
      const station = await db.restaurantKitchenStation.findFirst({
        where: { id: input.stationId, branchId: input.branchId, active: true },
      });
      if (!station) return null;
    }
    return enrollDevice(db, {
      name: input.name,
      branchId: input.branchId,
      kind: input.kind,
      stationId: input.kind === 'KDS' ? input.stationId : null,
    });
  });
  if (result && 'denied' in result) {
    return reject('Device-management permission is required.', 403);
  }
  if (!result) return reject('Branch or station was not found.', 404);

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
    response.cookies.set(name, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  }
  return response;
}
