import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admitAnonymousRequest } from '@/lib/auth/anonymous-rate-limit';
import { clientIp } from '@/lib/rate-limit';
import { admitToMeeting, GENERIC_ADMISSION_ERROR } from '@/lib/meetings/admission';
import { requestHost } from '@/lib/tenancy/host';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

export const dynamic = 'force-dynamic';

const inputSchema = z.object({ accessCode: z.string().trim().max(512).optional() });

function unavailable(status = 404) {
  return NextResponse.json({ error: GENERIC_ADMISSION_ERROR }, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> }
) {
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return unavailable();
  const ip = clientIp(request);
  const rate = await admitAnonymousRequest({
    kind: 'token',
    token: parsed.data.accessCode ?? null,
    ip,
  });
  if (!rate.ok) {
    return NextResponse.json(
      { error: GENERIC_ADMISSION_ERROR },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } }
    );
  }

  // This route is reachable without a session, and a session that disagrees
  // with the host makes `resolveTenantActor` throw (404/409/423). None of those
  // are answerable here: distinguishing them would leak whether the host names
  // a workspace at all. Fall back to the anonymous path and let admission
  // decide on the credential alone.
  const actor = await resolveTenantActor({ request }).catch(() => null);
  const { publicId } = await params;
  const outcome = await admitToMeeting({
    publicId,
    host: requestHost(request),
    guestToken: parsed.data.accessCode,
    sessionUser: actor?.session.user
      ? {
          id: actor.session.user.id,
          organizationId: actor.organization.id,
          role: actor.session.user.role,
        }
      : null,
  }).catch(() => ({ status: 'refused' }) as const);

  if (outcome.status === 'admitted') return NextResponse.json(outcome.admission);
  // 200, not an error: the caller proved a credential and is being held in the
  // lobby. A refusal below stays byte-identical to every other refusal.
  if (outcome.status === 'waiting') return NextResponse.json({ waiting: true } as const);
  return unavailable();
}
