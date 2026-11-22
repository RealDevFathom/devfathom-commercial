import * as client from 'openid-client';
import {
  assertPublicHttpsUrl,
  fetchPublicHttps,
  resolvePublicHttpsUrl,
} from '@/lib/webhooks/safe-url';

type DiscoverySettings = { issuer?: string | null; discoveryUrl?: string | null };
const CACHE_TTL_MS = 5 * 60_000;
const MAX_DOCUMENTS = 128;
type DiscoveryDocument = { text: string; contentType: string; issuer: string };
const documents = new Map<string, { expires: number; document: Promise<DiscoveryDocument> }>();

export async function validateOidcSettings(settings: DiscoverySettings) {
  for (const url of new Set([settings.issuer, settings.discoveryUrl])) {
    if (url) await resolvePublicHttpsUrl(url);
  }
}

function documentUrl(settings: DiscoverySettings) {
  if (settings.discoveryUrl) return assertPublicHttpsUrl(settings.discoveryUrl);
  if (!settings.issuer) throw new Error('OIDC issuer or discovery URL is required.');
  const issuer = assertPublicHttpsUrl(settings.issuer);
  if (!issuer.href.includes('/.well-known/')) {
    issuer.pathname = issuer.pathname.replace(/\/$/, '') + '/.well-known/openid-configuration';
  }
  return issuer;
}

// Let openid-client check the issuer and retain its provider-specific validation.
// The discovery transport serves only this document. Subsequent token and JWKS
// requests get their own pinned connection and can never reuse the document.
async function configuration(
  issuer: URL,
  clientId: string,
  secret: string | undefined,
  document: DiscoveryDocument
) {
  const config = await client.discovery(issuer, clientId, secret, undefined, {
    [client.customFetch]: async () =>
      new Response(document.text, { headers: { 'content-type': document.contentType } }),
  });
  config[client.customFetch] = async (url, { method, body, headers, signal }) => {
    if (
      (method !== 'GET' && method !== 'POST') ||
      (body != null && !(body instanceof URLSearchParams) && typeof body !== 'string')
    ) {
      throw new Error('Unsupported OIDC request.');
    }
    return fetchPublicHttps(url, {
      method,
      headers,
      body: body?.toString(),
      signal,
      maxBytes: 256 * 1024,
    });
  };
  return config;
}

async function loadDocument(url: URL, issuer: URL | null) {
  const response = await fetchPublicHttps(url.href, {
    method: 'GET',
    headers: { accept: 'application/json' },
    maxBytes: 64 * 1024,
  });
  if (response.status !== 200) throw new Error('Unexpected OIDC discovery response status.');
  const text = await response.text();
  const metadata = JSON.parse(text);
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof metadata?.[field] !== 'string')
      throw new Error('OIDC discovery metadata is incomplete.');
    assertPublicHttpsUrl(metadata[field]);
  }
  const document: DiscoveryDocument = {
    text,
    issuer: metadata.issuer,
    contentType: response.headers.get('content-type') ?? '',
  };
  await configuration(
    issuer ?? new URL(metadata.issuer),
    'discovery-validation',
    undefined,
    document
  );
  return document;
}

export async function discoverOidc(
  settings: DiscoverySettings,
  clientId: string,
  secret?: string,
  refresh = false
) {
  const url = documentUrl(settings);
  const issuer = settings.issuer ? assertPublicHttpsUrl(settings.issuer) : null;
  const key = JSON.stringify([issuer?.href, url.href]);
  let entry = documents.get(key);
  if (refresh || !entry || entry.expires <= Date.now()) {
    documents.delete(key);
    if (documents.size >= MAX_DOCUMENTS) documents.delete(documents.keys().next().value!);
    entry = { expires: Date.now() + CACHE_TTL_MS, document: loadDocument(url, issuer) };
    documents.set(key, entry);
  }
  let document: DiscoveryDocument;
  try {
    document = await entry.document;
  } catch (error) {
    if (documents.get(key) === entry) documents.delete(key);
    throw error;
  }
  return configuration(issuer ?? new URL(document.issuer), clientId, secret, document);
}
