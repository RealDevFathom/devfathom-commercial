import { NextResponse } from 'next/server';
import { assertPlatformMutationOrigin, PlatformSecurityError } from '@/lib/platform/security';
import { publicRequestOrigin } from '@/lib/http-origin';
import {
  endSupportSession,
  getSupportSession,
  SUPPORT_SESSION_COOKIE,
  supportCookieOptions,
} from '@/lib/tenancy/support-session';

export async function DELETE(request: Request) {
  try {
    assertPlatformMutationOrigin(request);
    const session = await getSupportSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Support access is no longer active.' }, { status: 401 });
    }
    await endSupportSession(request);
    const baseDomain = process.env.PLATFORM_BASE_DOMAIN;
    const publicUrl = new URL(publicRequestOrigin(request));
    const platformUrl = baseDomain
      ? `${publicUrl.protocol}//admin.${baseDomain}/platform`
      : `${publicUrl.protocol}//admin.localhost${publicUrl.port ? `:${publicUrl.port}` : ''}/platform`;
    const response = NextResponse.json({ success: true, platformUrl });
    response.cookies.set(SUPPORT_SESSION_COOKIE, '', {
      ...supportCookieOptions(new Date(0)),
      maxAge: 0,
    });
    return response;
  } catch (error) {
    if (error instanceof PlatformSecurityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Unable to end support session:', error);
    return NextResponse.json({ error: 'Unable to end support access.' }, { status: 500 });
  }
}
