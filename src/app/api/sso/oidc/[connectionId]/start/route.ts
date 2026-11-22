import { discoverOidc } from '@/lib/oidc-discovery';
import * as client from 'openid-client';
import { NextResponse } from 'next/server';
import {
  callbackUrl,
  createAuthorizationState,
  createSsoBrowserBinding,
  oidcClientSecret,
  SSO_BROWSER_BINDING_COOKIE,
  ssoBrowserBindingCookieOptions,
} from '@/lib/sso';
import { admitSsoStart } from '@/lib/sso-start-limit';
import { reserveSsoStateCapacity, SsoStateCapacityError } from '@/lib/sso-state';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

export async function GET(request: Request, route: { params: Promise<{ connectionId: string }> }) {
  try {
    const { connectionId } = await route.params;
    const connection = await admitSsoStart(request, connectionId, 'OIDC');
    if (connection instanceof Response) return connection;
    if (!connection.issuer || !connection.clientId) {
      return Response.json({ error: 'OIDC issuer and client ID are required.' }, { status: 409 });
    }
    const config = await discoverOidc(
      connection,
      connection.clientId,
      oidcClientSecret(connection)
    );
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const nonce = client.randomNonce();
    const redirectUri = callbackUrl(request, 'oidc', connection.id);
    // F10: bind the transaction to this browser; the callback requires it.
    const binding = createSsoBrowserBinding();
    const state = await withTenantDb(connection.organizationId, async (db) => {
      const sourceKey = await reserveSsoStateCapacity(db, connection.id, request, 1);
      return createAuthorizationState(db, {
        organizationId: connection.organizationId,
        identityConnectionId: connection.id,
        sourceKey,
        kind: 'OIDC',
        payload: { verifier, nonce, redirectUri, browserBindingHash: binding.hash },
      });
    });
    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      nonce,
      state,
    });
    const response = NextResponse.redirect(authorizationUrl, 302);
    response.cookies.set(
      SSO_BROWSER_BINDING_COOKIE,
      binding.value,
      ssoBrowserBindingCookieOptions(request)
    );
    return response;
  } catch (error) {
    if (error instanceof SsoStateCapacityError)
      return Response.json({ error: 'Too many pending sign-ins.' }, { status: 429 });
    console.error('[sso:oidc:start]', error);
    return Response.json({ error: 'OIDC sign-in could not be started.' }, { status: 400 });
  }
}
