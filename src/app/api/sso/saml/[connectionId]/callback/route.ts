import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { NextResponse } from 'next/server';
import { publicRequestOrigin } from '@/lib/http-origin';
import {
  callbackUrl,
  consumeAuthorizationState,
  issueSsoTicket,
  PrismaSamlCache,
  provisionIdentityUser,
  requireIdentityConnection,
  SSO_TICKET_COOKIE,
  ssoTicketCookieOptions,
} from '@/lib/sso';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

export async function POST(request: Request, route: { params: Promise<{ connectionId: string }> }) {
  try {
    const { connectionId } = await route.params;
    const connection = await requireIdentityConnection(request, connectionId, 'SAML');
    const publicOrigin = publicRequestOrigin(request);
    if (!connection.ssoUrl || !connection.certificate) {
      throw new Error('SAML connection is incomplete.');
    }
    const form = await request.formData();
    const samlResponse = form.get('SAMLResponse');
    const relayState = form.get('RelayState');
    if (typeof samlResponse !== 'string' || typeof relayState !== 'string') {
      throw new Error('SAML callback is missing its response or relay state.');
    }
    const profile = await withTenantDb(connection.organizationId, async (db) => {
      const saml = new SAML({
        callbackUrl: callbackUrl(request, 'saml', connection.id),
        entryPoint: connection.ssoUrl!,
        issuer: connection.entityId ?? publicOrigin,
        idpIssuer: connection.issuer ?? undefined,
        idpCert: connection.certificate!,
        audience: connection.entityId ?? publicOrigin,
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: false,
        validateInResponseTo: ValidateInResponseTo.always,
        requestIdExpirationPeriodMs: 10 * 60_000,
        acceptedClockSkewMs: 120_000,
        cacheProvider: new PrismaSamlCache(db, connection.organizationId, connection.id),
      });
      const result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
      if (!result.profile || result.loggedOut) throw new Error('SAML profile was not returned.');
      await consumeAuthorizationState(db, connection.id, relayState, 'SAML_RELAY');
      return result.profile;
    });
    const claims: Record<string, unknown> = {
      ...profile,
      email:
        profile.email ??
        profile.mail ??
        profile['urn:oid:0.9.2342.19200300.100.1.3'] ??
        profile.nameID,
      name: typeof profile.displayName === 'string' ? profile.displayName : profile.nameID,
    };
    const user = await provisionIdentityUser(connection, claims);
    const ticket = await issueSsoTicket(connection.organizationId, user.id);
    await withTenantDb(connection.organizationId, (db) =>
      db.organizationIdentityConnection.update({
        where: { id: connection.id },
        data: { lastTestedAt: new Date(), lastError: null },
      })
    );
    const response = NextResponse.redirect(new URL('/sso/complete', publicOrigin), 303);
    response.cookies.set(SSO_TICKET_COOKIE, ticket.token, ssoTicketCookieOptions(ticket.expiresAt));
    return response;
  } catch (error) {
    console.error('[sso:saml:callback]', error);
    return NextResponse.redirect(
      new URL('/login?ssoError=saml', publicRequestOrigin(request)),
      303
    );
  }
}
