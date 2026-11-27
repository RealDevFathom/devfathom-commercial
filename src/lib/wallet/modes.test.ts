import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { walletRuntime } from './modes';
import { buildWalletFiles } from './issue';

const alias = 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ';
const card = {
  alias,
  balance: 7,
  passes: [
    { platform: 'APPLE' as const, serialNumber: 'wps_' + '0'.repeat(26) },
    { platform: 'GOOGLE' as const, serialNumber: 'wps_' + '1'.repeat(26) },
  ],
};
const design = {
  programDisplayName: 'Example rewards',
  googleClassSuffix: 'wgc_' + '0'.repeat(26),
  backgroundColor: '#121212',
  foregroundColor: '#ffffff',
  logoPng: null,
};
it('returns offline unsigned TEST for absent, incomplete and unknown issuer modes', async () => {
  for (const mode of [undefined, 'LIVE', 'DEMO', 'unknown']) {
    const runtime = walletRuntime({ WALLET_MODE: mode });
    expect(runtime.mode).toBe('TEST');
    const transport = vi.fn(() => {
      throw Error('Unexpected provider call');
    });
    const out = await buildWalletFiles({
      card,
      design,
      runtime,
      origin: 'https://example.test',
      transport,
    });
    expect(out.files.mode).toBe('TEST');
    expect(out.files.apple).not.toHaveProperty('authenticationToken');
    expect(out.files.google).toHaveProperty('barcode.value', alias);
    expect(transport).not.toHaveBeenCalled();
  }
});
it.each(['DEMO', 'LIVE'] as const)(
  'issues %s with environment material through an injected Google transport',
  async (mode) => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const env = {
      WALLET_MODE: mode,
      ['WALLET_GOOGLE_' + mode + '_ISSUER_ID']: '1234567890123456789',
      ['WALLET_GOOGLE_' + mode + '_SERVICE_ACCOUNT']: JSON.stringify({
        client_email: 'wallet@example.test',
        private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      }),
      WALLET_DEMO_TEST_PHONES: '+923000000001',
    };
    const runtime = walletRuntime(env);
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('oauth2.googleapis.com'))
        return Response.json({ access_token: randomUUID(), expires_in: 3600 });
      if (init.method === 'GET') return new Response(null, { status: 404 });
      return Response.json({});
    });
    if (mode === 'DEMO') {
      await expect(
        buildWalletFiles({
          card,
          design,
          runtime,
          origin: 'https://example.test',
          phone: '+923000000002',
          transport,
        })
      ).rejects.toThrow(/test account/i);
      expect(transport).not.toHaveBeenCalled();
    }
    const { files } = await buildWalletFiles({
      card,
      design,
      runtime,
      origin: 'https://example.test',
      phone: '+923000000001',
      transport,
    });
    expect(files.mode).toBe(mode);
    expect(files.googleUrl).toMatch(/^https:\/\/pay.google.com\/gp\/v\/save\//);
    expect(transport.mock.calls.some(([url]) => url.endsWith('/loyaltyClass'))).toBe(true);
    expect(transport.mock.calls.some(([url]) => url.endsWith('/loyaltyObject'))).toBe(true);
    expect(JSON.stringify(files)).not.toContain('PRIVATE KEY');
  }
);

it('adds a signed Apple archive in LIVE using temporary synthetic issuer material', async () => {
  const { execFileSync } = await import('node:child_process');
  const bundle = execFileSync(
    'openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-x509',
      '-keyout',
      '-',
      '-out',
      '-',
      '-days',
      '1',
      '-subj',
      '/CN=Synthetic Wallet Test',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const key = bundle.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/)![0];
  const cert = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)![0];
  const runtime = walletRuntime({
    WALLET_MODE: 'LIVE',
    WALLET_APPLE_PASS_CERT: cert,
    WALLET_APPLE_PASS_KEY: key,
    WALLET_APPLE_WWDR_CERT: cert,
    WALLET_APPLE_PASS_TYPE: 'pass.test.synthetic',
    WALLET_APPLE_TEAM_ID: 'TEST000000',
    WALLET_APPLE_APNS_KEY_ID: 'SYNTHETIC1',
    WALLET_APPLE_APNS_KEY: generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    AUTH_SECRET: randomUUID(),
  });
  const { files, appleHash } = await buildWalletFiles({
    card,
    design,
    runtime,
    origin: 'https://wallet.example.test',
  });
  expect(files.mode).toBe('LIVE');
  expect(appleHash).toMatch(/^[0-9a-f]{64}$/);
  const archive = Buffer.from(files.appleArchive!, 'base64');
  expect(archive.subarray(0, 2).toString()).toBe('PK');
  expect(archive.includes(Buffer.from('signature'))).toBe(true);
  expect(archive.includes(Buffer.from(key))).toBe(false);
});
