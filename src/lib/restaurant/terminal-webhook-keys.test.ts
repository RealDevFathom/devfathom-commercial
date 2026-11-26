import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encryptSecret } from '@/lib/secret-crypto';
import { verifyProviderSignature } from './terminal-webhook-keys';

const now = 1_800_000_000_000;
const timestamp = String(now / 1000);
const source = 'fixture';
const body = '{"externalEventId":"fixture","payload":{}}';
const sign = (key: string, id?: string) =>
  createHmac('sha256', key)
    .update(id ? JSON.stringify([timestamp, source, id]) + '.' : timestamp + '.' + source + '.')
    .update(body)
    .digest('hex');
const config = () => ({
  id: 'config-a',
  encryptedSigningSecret: encryptSecret('current'),
  previousEncryptedSigningSecret: encryptSecret('previous'),
  previousSigningSecretExpiresAt: new Date(now + 1),
  legacySigningCutoff: new Date(now + 1),
});

beforeEach(() => {
  vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'isolated-test-only');
  vi.stubEnv('RESTAURANT_TERMINAL_WEBHOOK_SECRET', 'legacy');
});
afterEach(() => vi.unstubAllEnvs());

it('binds a valid signature to the resolved configuration even with identical key material', () => {
  const a = config();
  const signature = sign('current', a.id);
  expect(verifyProviderSignature(a, source, body, signature, timestamp, now)).toBe('SCOPED');
  expect(
    verifyProviderSignature({ ...a, id: 'config-b' }, source, body, signature, timestamp, now)
  ).toBe('FAILED');
});

it('accepts the previous key only before its exclusive expiry', () => {
  const a = config();
  const signature = sign('previous', a.id);
  expect(verifyProviderSignature(a, source, body, signature, timestamp, now)).toBe('SCOPED');
  expect(verifyProviderSignature(a, source, body, signature, timestamp, now + 1)).toBe('FAILED');
});

it('allows the shared key only on an unprovisioned configuration before its exclusive cutoff', () => {
  const a = config();
  const signature = sign('legacy');
  expect(verifyProviderSignature(a, source, body, signature, timestamp, now)).toBe('FAILED');
  const legacy = {
    ...a,
    encryptedSigningSecret: null,
    previousEncryptedSigningSecret: null,
    previousSigningSecretExpiresAt: null,
  };
  expect(verifyProviderSignature(legacy, source, body, signature, timestamp, now)).toBe('LEGACY');
  expect(verifyProviderSignature(legacy, source, body, signature, timestamp, now + 1)).toBe(
    'FAILED'
  );
});
