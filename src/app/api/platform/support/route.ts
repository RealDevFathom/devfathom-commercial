import { z } from 'zod';
import { NextResponse } from 'next/server';
import { requirePlatformSession } from '@/lib/platform/auth';
import { assertPlatformMutationOrigin, PlatformSecurityError } from '@/lib/platform/security';
import {
  createSupportSession,
  endSupportSession,
  forceEndSupportSession,
  listActiveSupportSessions,
} from '@/lib/tenancy/support-session';

const createSchema = z.object({
  organizationId: z.string().min(3).max(128),
  tenantUserId: z.string().min(3).max(128).optional(),
  reason: z.string().min(10).max(500),
  durationMinutes: z.number().int().min(5).max(60).optional(),
});

function failure(error: unknown) {
  if (error instanceof PlatformSecurityError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('Support session error:', error);
  return NextResponse.json({ error: 'Unable to manage support access.' }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    assertPlatformMutationOrigin(request);
    const actor = await requirePlatformSession(request, 'support:write');
    const input = createSchema.parse(await request.json());
    const session = await createSupportSession({ actor, ...input });
    const baseDomain = process.env.PLATFORM_BASE_DOMAIN;
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = baseDomain
      ? `${session.organizationSlug}.${baseDomain}`
      : `${session.organizationSlug}.localhost:3000`;
    const tenantBaseUrl = session.deploymentUrl ?? `${protocol}://${host}`;
    const launchUrl = new URL('/api/support-session/launch', tenantBaseUrl);
    launchUrl.searchParams.set('ticket', session.launchToken);
    const response = NextResponse.json({
      supportSessionId: session.supportSessionId,
      expiresAt: session.expiresAt,
      launchUrl: launchUrl.toString(),
    });
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Review the organization, support reason, and duration.' },
        { status: 400 }
      );
    }
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertPlatformMutationOrigin(request);
    await requirePlatformSession(request, 'support:write');
    await endSupportSession(request);
    return NextResponse.json({ success: true });
  } catch (error) {
    return failure(error);
  }
}

export async function GET(request: Request) {
  try {
    const actor = await requirePlatformSession(request, 'support:write');
    return NextResponse.json(
      { sessions: await listActiveSupportSessions(actor) },
      {
        headers: { 'Cache-Control': 'private, no-store' },
      }
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertPlatformMutationOrigin(request);
    const actor = await requirePlatformSession(request, 'support:write');
    const input = z
      .object({
        supportSessionId: z.string().min(3).max(128),
        reason: z.string().trim().min(10).max(500),
      })
      .parse(await request.json());
    await forceEndSupportSession({ actor, ...input });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Review the session and end reason.' }, { status: 400 });
    }
    return failure(error);
  }
}
