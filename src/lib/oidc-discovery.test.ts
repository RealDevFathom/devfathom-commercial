// @vitest-environment node
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { RequestOptions } from 'node:https';
import * as client from 'openid-client';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { resolvePublicHttpsUrl } from '@/lib/webhooks/safe-url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverOidc, validateOidcSettings } from './oidc-discovery';

const net = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: net.lookup }));
vi.mock('node:https', () => ({ default: { request: net.request } }));

const issuer = 'https://idp.example/tenant';
const document = {
  issuer,
  authorization_endpoint: issuer + '/authorize',
  token_endpoint: issuer + '/token',
  jwks_uri: issuer + '/keys',
};
const settings = { issuer, discoveryUrl: 'https://metadata.example/tenant.json' };

function reply(chunks: Buffer[], status = 200, headers: Record<string, string> = {}) {
  const stream = Object.assign(Readable.from(chunks), {
    statusCode: status,
    headers: { 'content-type': 'application/json', ...headers },
  });
  net.request.mockImplementationOnce(
    (_options: RequestOptions, callback: (res: typeof stream) => void) =>
      Object.assign(new EventEmitter(), { end: () => callback(stream) })
  );
  return stream;
}
function json(value: unknown) {
  reply([Buffer.from(JSON.stringify(value))]);
}
beforeEach(() => {
  net.lookup.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  net.request.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('OIDC discovery transport', () => {
  it('uses one validated document for concurrent starts and completes a legitimate authorization-code grant', async () => {
    json(document);
    const [config, other] = await Promise.all([
      discoverOidc(settings, 'test-client', 'fixture-secret'),
      discoverOidc(settings, 'other-client'),
    ]);
    expect(net.request).toHaveBeenCalledTimes(1);
    const [options] = net.request.mock.calls[0]!;
    expect(options).toMatchObject({
      hostname: 'metadata.example',
      path: '/tenant.json',
      port: 443,
      agent: false,
      method: 'GET',
      headers: { host: 'metadata.example' },
    });
    const resolved = vi.fn();
    options.lookup('metadata.example', {}, resolved);
    expect(resolved).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    const verifier = client.randomPKCECodeVerifier();
    const auth = client.buildAuthorizationUrl(config, {
      redirect_uri: 'https://tenant.example/callback',
      scope: 'openid',
      state: 's',
      nonce: 'n',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    expect(auth.origin + auth.pathname).toBe(document.authorization_endpoint);
    expect(auth.searchParams.get('client_id')).toBe('test-client');
    expect(other.clientMetadata().client_id).toBe('other-client');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const idToken = jwt.sign({ nonce: 'n', email: 'member@example.test' }, privateKey, {
      algorithm: 'RS256',
      issuer,
      audience: 'test-client',
      subject: 'member',
      expiresIn: '1h',
    });
    json({ access_token: 'fixture-access', token_type: 'Bearer', id_token: idToken });
    const tokens = await client.authorizationCodeGrant(
      config,
      new URL('https://tenant.example/callback?code=fixture&state=s'),
      { expectedState: 's', expectedNonce: 'n', pkceCodeVerifier: verifier, idTokenExpected: true }
    );
    expect(tokens.claims()?.sub).toBe('member');
    expect(net.request.mock.calls[1]![0]).toMatchObject({
      hostname: 'idp.example',
      path: '/tenant/token',
      method: 'POST',
    });
  });

  it('validates DNS on save and again on a fresh worker fetch', async () => {
    await validateOidcSettings(settings);
    expect(net.lookup.mock.calls.map(([host]) => host)).toEqual([
      'idp.example',
      'metadata.example',
    ]);
    net.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '192.0.2.1', family: 4 },
    ]);
    await expect(discoverOidc(settings, 'fixture', undefined, true)).rejects.toThrow();
    expect(net.request).not.toHaveBeenCalled();
  });

  it.each([
    'http://idp.example',
    'https://user@idp.example',
    'https://idp.example:444',
    'https://127.0.0.1',
    'https://169.254.1.2',
    'https://10.0.0.1',
    'https://[3fff::1]',
  ])('rejects an ineligible URL on save and fetch (%s)', async (raw) => {
    await expect(validateOidcSettings({ discoveryUrl: raw })).rejects.toThrow();
    await expect(discoverOidc({ discoveryUrl: raw }, 'fixture')).rejects.toThrow();
    expect(net.request).not.toHaveBeenCalled();
  });

  it.each(['authorization_endpoint', 'token_endpoint', 'jwks_uri'])(
    'refuses a discovered %s on a nonstandard port',
    async (field) => {
      json({ ...document, [field]: 'https://idp.example:8443/endpoint' });
      await expect(discoverOidc(settings, 'fixture', undefined, true)).rejects.toThrow();
      expect(net.request).toHaveBeenCalledTimes(1);
    }
  );

  it('applies the port policy when requesting user information', async () => {
    json({ ...document, userinfo_endpoint: 'https://idp.example:8443/userinfo' });
    const config = await discoverOidc(settings, 'fixture', undefined, true);
    await expect(
      client.fetchUserInfo(config, 'fixture-token', 'fixture-subject')
    ).rejects.toThrow();
    expect(net.request).toHaveBeenCalledTimes(1);
  });

  it('honors the deadline while DNS resolution is pending', async () => {
    net.lookup.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = resolvePublicHttpsUrl(settings.discoveryUrl, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(net.request).not.toHaveBeenCalled();
  });

  it('refuses partial metadata even when the body is valid JSON', async () => {
    reply([Buffer.from(JSON.stringify(document))], 206);
    await expect(discoverOidc(settings, 'fixture', undefined, true)).rejects.toThrow('status');
  });

  it('refuses a redirect without resolving or following its destination', async () => {
    reply([], 302, { location: 'https://redirect.example' });
    await expect(discoverOidc(settings, 'fixture', undefined, true)).rejects.toThrow();
    expect(net.lookup.mock.calls.map(([host]) => host)).toEqual(['metadata.example']);
    expect(net.request).toHaveBeenCalledTimes(1);
  });

  it('cuts off a chunked document above the size limit and retries with fresh metadata', async () => {
    const stream = reply([Buffer.alloc(32 * 1024), Buffer.alloc(32 * 1024), Buffer.alloc(1)]);
    await expect(discoverOidc(settings, 'fixture', undefined, true)).rejects.toThrow('too large');
    expect(stream.destroyed).toBe(true);
    json(document);
    expect((await discoverOidc(settings, 'fixture')).serverMetadata().issuer).toBe(issuer);
    expect(net.request).toHaveBeenCalledTimes(2);
  });

  it('expires the cache and rejects incomplete documents and issuer mismatches', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    json(document);
    await discoverOidc({ issuer }, 'fixture', undefined, true);
    expect(net.request.mock.calls[0]![0].path).toBe('/tenant/.well-known/openid-configuration');
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    json({ ...document, jwks_uri: null });
    await expect(discoverOidc({ issuer }, 'fixture')).rejects.toThrow('incomplete');
    json({ ...document, issuer: 'https://different.example' });
    await expect(discoverOidc({ issuer }, 'fixture')).rejects.toThrow();
    expect(net.request).toHaveBeenCalledTimes(3);
  });
});
