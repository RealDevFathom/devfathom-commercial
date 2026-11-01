// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClientSecretCredential,
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import { createHttpHeaders, type HttpClient } from '@azure/core-rest-pipeline';
import { deepmerge } from 'deepmerge-ts';

const tenant = '11111111-1111-4111-8111-111111111111';
const client = '22222222-2222-4222-8222-222222222222';
const authority = `https://login.microsoftonline.com/${tenant}`;

/** Injected transport only: this test cannot send requests or read real credentials. */
function transport() {
  const requests: { url: string; body: string; method: string }[] = [];
  const httpClient: HttpClient = {
    async sendRequest(request) {
      expect(new URL(request.url).origin).toBe('https://login.microsoftonline.com');
      requests.push({ url: request.url, body: String(request.body ?? ''), method: request.method });
      let body: unknown;
      if (request.url.includes('.well-known/openid-configuration')) {
        body = {
          issuer: `${authority}/v2.0`,
          authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
          token_endpoint: `${authority}/oauth2/v2.0/token`,
          end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
          jwks_uri: `${authority}/discovery/v2.0/keys`,
        };
      } else if (request.url.includes('/discovery/instance')) {
        body = {
          tenant_discovery_endpoint: `${authority}/v2.0/.well-known/openid-configuration`,
          metadata: [
            {
              preferred_network: 'login.microsoftonline.com',
              preferred_cache: 'login.microsoftonline.com',
              aliases: ['login.microsoftonline.com'],
            },
          ],
        };
      } else {
        expect(request.method).toBe('POST');
        expect(new URL(request.url).origin + new URL(request.url).pathname).toBe(
          `${authority}/oauth2/v2.0/token`
        );
        const form = new URLSearchParams(String(request.body));
        expect(form.get('grant_type')).toBe('client_credentials');
        expect(form.get('client_id')).toBe(client);
        expect(form.get('client_secret')).toBe('synthetic-test-value');
        body = {
          token_type: 'Bearer',
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          ext_expires_in: 3600,
        };
      }
      return {
        request,
        status: 200,
        headers: createHttpHeaders({ 'content-type': 'application/json' }),
        bodyAsText: JSON.stringify(body),
      };
    },
  };
  return { httpClient, requests };
}
afterEach(() => vi.unstubAllEnvs());

describe('patched authentication and configuration dependencies', () => {
  it('keeps client-secret token acquisition and cache behavior through the real SDK/MSAL boundary', async () => {
    const { httpClient, requests } = transport();
    const credential = new ClientSecretCredential(tenant, client, 'synthetic-test-value', {
      httpClient,
      disableInstanceDiscovery: true,
    });
    const first = await credential.getToken('https://storage.azure.com/.default');
    expect(first?.token).toBe('synthetic-access-token');
    expect((await credential.getToken('https://storage.azure.com/.default'))?.token).toBe(
      first?.token
    );
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });
  it('keeps the default credential and bearer provider used by storage and AI working', async () => {
    vi.stubEnv('AZURE_TENANT_ID', tenant);
    vi.stubEnv('AZURE_CLIENT_ID', client);
    vi.stubEnv('AZURE_CLIENT_SECRET', 'synthetic-test-value');
    // Force the environment-only chain so host developer credentials are never consulted.
    vi.stubEnv('AZURE_TOKEN_CREDENTIALS', 'EnvironmentCredential');
    const { httpClient, requests } = transport();
    const credential = new DefaultAzureCredential({ httpClient });
    const token = getBearerTokenProvider(
      credential,
      'https://cognitiveservices.azure.com/.default'
    );
    expect(await token()).toBe('synthetic-access-token');
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });
  it('merges Prisma-style nested config without mutating either input and terminates recursive graph merges', () => {
    const defaults = {
      migrations: { path: 'prisma/migrations' },
      datasource: { url: 'postgresql://synthetic.invalid/test' },
      flags: ['base'],
    };
    const configured = { migrations: { seed: 'bun prisma/seed.ts' }, flags: ['configured'] };
    expect(deepmerge(defaults, configured)).toEqual({
      migrations: { path: 'prisma/migrations', seed: 'bun prisma/seed.ts' },
      datasource: defaults.datasource,
      flags: ['base', 'configured'],
    });
    expect(defaults.flags).toEqual(['base']);
    expect(configured.flags).toEqual(['configured']);
    const first: { label: string; self?: unknown } = { label: 'first' };
    first.self = first;
    const second: { label: string; self?: unknown } = { label: 'second' };
    second.self = second;
    const merged = deepmerge(first, second);
    expect(merged.label).toBe('second');
    expect(merged.self).toBe(merged);
  });
});
