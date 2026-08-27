import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admitAnonymousRequest } from '@/lib/auth/anonymous-rate-limit';
import { admitToMeeting, GENERIC_ADMISSION_ERROR } from '@/lib/meetings/admission';
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
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const rate = admitAnonymousRequest({
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

  const actor = await resolveTenantActor({ request });
  const { publicId } = await params;
  const admission = await admitToMeeting({
    publicId,
    guestToken: parsed.data.accessCode,
    sessionUser: actor?.session.user
      ? {
          id: actor.session.user.id,
          organizationId: actor.organization.id,
          role: actor.session.user.role,
        }
      : null,
  }).catch(() => null);

  return admission ? NextResponse.json(admission) : unavailable();
}
