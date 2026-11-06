import { google } from 'googleapis';

/**
 * Server-side OAuth for the "one click → consent → connected" flow.
 *
 * The client never sees a config screen: `buildConsentUrl` produces the provider
 * consent URL (opened in a popup); `exchangeCode` swaps the returned code for a
 * long-lived refresh token + the account's email address. Refresh tokens are
 * handed back to the router, which encrypts them before storage.
 *
 * SERVER-ONLY (reads client secrets from env).
 */

export type OAuthProvider = 'GMAIL' | 'OUTLOOK';

// Minimal scopes. Gmail: read + send. Outlook: read + send + offline refresh,
// plus openid/email so we can read the account address from the id_token.
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];
const MS_SCOPES = 'offline_access Mail.Read Mail.Send openid email';

class OAuthConfigError extends Error {}

export function googleConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new OAuthConfigError('Gmail connection is not configured on the server.');
  }
  return { clientId, clientSecret, redirectUri };
}

export function microsoftConfig() {
  const clientId = process.env.MS_OAUTH_CLIENT_ID;
  const clientSecret = process.env.MS_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.MS_OAUTH_REDIRECT_URI;
  const tenant = process.env.MS_OAUTH_TENANT || 'common';
  if (!clientId || !clientSecret || !redirectUri) {
    throw new OAuthConfigError('Outlook connection is not configured on the server.');
  }
  return { clientId, clientSecret, redirectUri, tenant };
}

/** True when a provider's OAuth env is present — used to gate the connect buttons. */
export function isProviderConfigured(provider: OAuthProvider): boolean {
  try {
    if (provider === 'GMAIL') googleConfig();
    else microsoftConfig();
    return true;
  } catch {
    return false;
  }
}

export function googleOAuthClient() {
  const { clientId, clientSecret, redirectUri } = googleConfig();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** Build the consent URL a popup will open. `state` carries provider + CSRF nonce. */
export function buildConsentUrl(provider: OAuthProvider, state: string): string {
  if (provider === 'GMAIL') {
    return googleOAuthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // force a refresh_token even on re-consent
      scope: GOOGLE_SCOPES,
      state,
      include_granted_scopes: true,
    });
  }
  const { clientId, redirectUri, tenant } = microsoftConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: MS_SCOPES,
    state,
    prompt: 'select_account',
  });
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
}

/** Decode a JWT payload without verifying — used only for trusted MS id_tokens. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) return {};
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface ExchangeResult {
  refreshToken: string;
  emailAddress: string;
}

/** Swap an authorization code for a refresh token + the mailbox's email address. */
export async function exchangeCode(provider: OAuthProvider, code: string): Promise<ExchangeResult> {
  if (provider === 'GMAIL') {
    const client = googleOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token. Please try connecting again.');
    }
    client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const emailAddress = profile.data.emailAddress;
    if (!emailAddress) throw new Error('Could not read the Gmail account address.');
    return { refreshToken: tokens.refresh_token, emailAddress };
  }

  // Outlook / Microsoft
  const { clientId, clientSecret, redirectUri, tenant } = microsoftConfig();
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      scope: MS_SCOPES,
    }),
  });
  const json = (await res.json()) as {
    refresh_token?: string;
    id_token?: string;
    error_description?: string;
  };
  if (!res.ok || !json.refresh_token) {
    throw new Error(json.error_description || 'Microsoft did not return a refresh token.');
  }
  const claims = json.id_token ? decodeJwtPayload(json.id_token) : {};
  const emailAddress =
    (typeof claims.email === 'string' && claims.email) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
    '';
  if (!emailAddress) throw new Error('Could not read the Outlook account address.');
  return { refreshToken: json.refresh_token, emailAddress };
}

/** Exchange a stored Microsoft refresh token for a fresh access token (adapter use). */
export async function getMicrosoftAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret, tenant } = microsoftConfig();
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: MS_SCOPES,
    }),
  });
  const json = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || 'Could not refresh Microsoft access token.');
  }
  return json.access_token;
}
