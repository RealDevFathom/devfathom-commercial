import { NextResponse } from 'next/server';
import { publicRequestOrigin } from '@/lib/http-origin';
import { requireOrganizationForRequest, TenantHostError } from '@/lib/tenancy/host';
import {
  consumeSupportLaunchTicket,
  SUPPORT_SESSION_COOKIE,
  supportCookieOptions,
} from '@/lib/tenancy/support-session';
import { PlatformSecurityError } from '@/lib/platform/security';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const organization = await requireOrganizationForRequest(request);
    const launchToken = new URL(request.url).searchParams.get('ticket') ?? '';
    const session = await consumeSupportLaunchTicket({
      launchToken,
      organizationId: organization.id,
    });

    const response = NextResponse.redirect(
      new URL('/dashboard', publicRequestOrigin(request)),
      303
    );
    response.cookies.set(
      SUPPORT_SESSION_COOKIE,
      session.token,
      supportCookieOptions(session.expiresAt)
    );
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  } catch (error) {
    const status =
      error instanceof TenantHostError || error instanceof PlatformSecurityError
        ? error.status
        : 500;
    const message =
      status === 500 ? 'Unable to launch support access.' : 'Support access is invalid or expired.';
    return NextResponse.json(
      { error: message },
      {
        status,
        headers: {
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      }
    );
  }
}
