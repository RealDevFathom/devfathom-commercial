import { z } from 'zod';
import { NextResponse } from 'next/server';
import { readBoundedJson } from '@/lib/http/read-bounded-body';
import {
  createPlatformSession,
  getPlatformSession,
  PLATFORM_SESSION_COOKIE,
  platformCookieOptions,
  revokePlatformSession,
} from '@/lib/platform/auth';
import { assertPlatformMutationOrigin, PlatformSecurityError } from '@/lib/platform/security';

export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(256),
  authenticationCode: z.string().trim().max(32).optional(),
});

function failure(error: unknown) {
  if (error instanceof PlatformSecurityError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('Platform session error:', error);
  return NextResponse.json(
    { error: 'Unable to complete platform authentication.' },
    { status: 500 }
  );
}

export async function GET(request: Request) {
  const identity = await getPlatformSession(request);
  if (!identity) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
  return NextResponse.json(
    {
      authenticated: true,
      user: {
        id: identity.id,
        name: identity.name,
        email: identity.email,
        role: identity.role,
        expiresAt: identity.expiresAt,
      },
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
}

export async function POST(request: Request) {
  try {
    assertPlatformMutationOrigin(request);
    const body = await readBoundedJson(request, 4 * 1024);
    if (body.tooLarge)
      return NextResponse.json({ error: 'Request body is too large.' }, { status: 413 });
    const input = loginSchema.parse(body.value);
    const session = await createPlatformSession(
      input.email,
      input.password,
      input.authenticationCode,
      request
    );
    const response = NextResponse.json({
      authenticated: !session.identity.enrollmentOnly,
      enrollmentRequired: Boolean(session.identity.enrollmentOnly),
      user: {
        id: session.identity.id,
        name: session.identity.name,
        email: session.identity.email,
        role: session.identity.role,
        expiresAt: session.identity.expiresAt,
      },
    });
    response.cookies.set(
      PLATFORM_SESSION_COOKIE,
      session.token,
      platformCookieOptions(session.expiresAt)
    );
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Enter valid platform credentials and authentication code.' },
        { status: 400 }
      );
    }
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertPlatformMutationOrigin(request);
    await revokePlatformSession(request);
    const response = NextResponse.json({ success: true });
    response.cookies.set(PLATFORM_SESSION_COOKIE, '', {
      ...platformCookieOptions(new Date(0)),
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}
