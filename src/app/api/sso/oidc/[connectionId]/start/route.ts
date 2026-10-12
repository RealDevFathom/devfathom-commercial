import * as client from 'openid-client';
import {
  callbackUrl,
  createAuthorizationState,
  oidcClientSecret,
  requireIdentityConnection,
} from '@/lib/sso';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

export async function GET(request: Request, route: { params: Promise<{ connectionId: string }> }) {
  try {
    const { connectionId } = await route.params;
    const connection = await requireIdentityConnection(request, connectionId, 'OIDC');
    if (!connection.issuer || !connection.clientId) {
      return Response.json({ error: 'OIDC issuer and client ID are required.' }, { status: 409 });
    }
    const config = await client.discovery(
      new URL(connection.issuer),
      connection.clientId,
      oidcClientSecret(connection)
    );
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const nonce = client.randomNonce();
    const redirectUri = callbackUrl(request, 'oidc', connection.id);
    const state = await withTenantDb(connection.organizationId, (db) =>
      createAuthorizationState(db, {
        organizationId: connection.organizationId,
        identityConnectionId: connection.id,
        kind: 'OIDC',
        payload: { verifier, nonce, redirectUri },
      })
    );
    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      nonce,
      state,
    });
    return Response.redirect(authorizationUrl);
  } catch (error) {
    console.error('[sso:oidc:start]', error);
    return Response.json({ error: 'OIDC sign-in could not be started.' }, { status: 400 });
  }
}
