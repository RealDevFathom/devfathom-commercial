import * as client from 'openid-client';
import { NextResponse } from 'next/server';
import { publicRequestOrigin, publicRequestUrl } from '@/lib/http-origin';
import {
  consumeAuthorizationState,
  issueSsoTicket,
  oidcClientSecret,
  provisionIdentityUser,
  readSsoBrowserBinding,
  requireIdentityConnection,
  SSO_BROWSER_BINDING_COOKIE,
  ssoBrowserBindingCookieOptions,
  SSO_TICKET_COOKIE,
  ssoTicketCookieOptions,
} from '@/lib/sso';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

export async function GET(request: Request, route: { params: Promise<{ connectionId: string }> }) {
  try {
    const { connectionId } = await route.params;
    const connection = await requireIdentityConnection(request, connectionId, 'OIDC');
    const callback = publicRequestUrl(request);
    const stateKey = callback.searchParams.get('state');
    if (!stateKey || !connection.issuer || !connection.clientId) {
      throw new Error('OIDC callback is missing required state.');
    }
    const state = await withTenantDb(connection.organizationId, (db) =>
      consumeAuthorizationState(db, connection.id, stateKey, 'OIDC', readSsoBrowserBinding(request))
    );
    const verifier = String(state.verifier ?? '');
    const nonce = String(state.nonce ?? '');
    const redirectUri = String(state.redirectUri ?? '');
    if (!verifier || !nonce || !redirectUri) throw new Error('OIDC state is incomplete.');
    const config = await client.discovery(
      new URL(connection.issuer),
      connection.clientId,
      oidcClientSecret(connection)
    );
    const tokens = await client.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: verifier,
      expectedNonce: nonce,
      expectedState: stateKey,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('OIDC identity claims were not returned.');
    const user = await provisionIdentityUser(connection, claims as Record<string, unknown>);
    const ticket = await issueSsoTicket(connection.organizationId, user.id);
    await withTenantDb(connection.organizationId, (db) =>
      db.organizationIdentityConnection.update({
        where: { id: connection.id },
        data: { lastTestedAt: new Date(), lastError: null },
      })
    );
    const response = NextResponse.redirect(new URL('/sso/complete', publicRequestOrigin(request)));
    response.cookies.set(SSO_TICKET_COOKIE, ticket.token, ssoTicketCookieOptions(ticket.expiresAt));
    response.cookies.set(SSO_BROWSER_BINDING_COOKIE, '', {
      ...ssoBrowserBindingCookieOptions(request),
      maxAge: 0,
    });
    return response;
  } catch (error) {
    console.error('[sso:oidc:callback]', error);
    return NextResponse.redirect(new URL('/login?ssoError=oidc', publicRequestOrigin(request)));
  }
}
