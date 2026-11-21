import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { NextResponse } from 'next/server';
import { publicRequestUrl } from '@/lib/http-origin';
import {
  callbackUrl,
  createAuthorizationState,
  createSsoBrowserBinding,
  PrismaSamlCache,
  SSO_BROWSER_BINDING_COOKIE,
  ssoBrowserBindingCookieOptions,
} from '@/lib/sso';
import { admitSsoStart } from '@/lib/sso-start-limit';
import { reserveSsoStateCapacity, SsoStateCapacityError } from '@/lib/sso-state';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

export async function GET(request: Request, route: { params: Promise<{ connectionId: string }> }) {
  try {
    const { connectionId } = await route.params;
    const connection = await admitSsoStart(request, connectionId, 'SAML');
    if (connection instanceof Response) return connection;
    const publicUrl = publicRequestUrl(request);
    if (!connection.ssoUrl || !connection.certificate) {
      return Response.json(
        { error: 'SAML SSO URL and identity-provider certificate are required.' },
        { status: 409 }
      );
    }
    // F10: bind the RelayState and the AuthnRequest ID to this browser.
    const binding = createSsoBrowserBinding();
    const redirect = await withTenantDb(connection.organizationId, async (db) => {
      await reserveSsoStateCapacity(db, connection.id, 2);
      const relayState = await createAuthorizationState(db, {
        organizationId: connection.organizationId,
        identityConnectionId: connection.id,
        kind: 'SAML_RELAY',
        payload: { returnTo: '/dashboard', browserBindingHash: binding.hash },
      });
      const saml = new SAML({
        callbackUrl: callbackUrl(request, 'saml', connection.id),
        entryPoint: connection.ssoUrl!,
        issuer: connection.entityId ?? publicUrl.origin,
        idpIssuer: connection.issuer ?? undefined,
        idpCert: connection.certificate!,
        audience: connection.entityId ?? publicUrl.origin,
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: false,
        validateInResponseTo: ValidateInResponseTo.always,
        requestIdExpirationPeriodMs: 10 * 60_000,
        acceptedClockSkewMs: 120_000,
        cacheProvider: new PrismaSamlCache(db, connection.organizationId, connection.id, {
          hash: binding.hash,
        }),
      });
      return saml.getAuthorizeUrlAsync(relayState, publicUrl.host, {});
    });
    const response = NextResponse.redirect(redirect, 302);
    response.cookies.set(
      SSO_BROWSER_BINDING_COOKIE,
      binding.value,
      ssoBrowserBindingCookieOptions(request)
    );
    return response;
  } catch (error) {
    if (error instanceof SsoStateCapacityError)
      return Response.json({ error: 'Too many pending sign-ins.' }, { status: 429 });
    console.error('[sso:saml:start]', error);
    return Response.json({ error: 'SAML sign-in could not be started.' }, { status: 400 });
  }
}
