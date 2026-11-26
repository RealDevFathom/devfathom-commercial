import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { portalSyntheticSender, portalWhatsAppReady } from './portal-delivery';
import { readWhatsAppConfig } from './whatsapp/provider';

const config = readWhatsAppConfig({});
const tenant = { isDemo: true };
const local = 'pharmacy.localhost';

beforeEach(() => {
  vi.stubEnv('PHARMACY_PORTAL_LOG_SYNTHETIC_CODES', '1');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5433/portal_test');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('logs only the synthetic code for a reserved fictional destination', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const send = portalSyntheticSender(tenant, local, config)!;
  await send({ to: '12025550145', otp: '012345' });
  expect(log.mock.calls).toEqual([['Synthetic portal code: 012345']]);
  await expect(send({ to: '12025551000', otp: '012345' })).rejects.toThrow();
  expect(log).toHaveBeenCalledTimes(1);
});

it.each([
  ['NODE_ENV', 'production'],
  ['NODE_ENV', 'unknown'],
  ['DEPLOY_ENV', 'production'],
  ['PHARMACY_PORTAL_LOG_SYNTHETIC_CODES', ''],
  ['DATABASE_URL', 'postgresql://db.example/portal_test'],
  ['DATABASE_URL', 'postgresql://localhost/portal_test?host=db.example'],
  ['DATABASE_URL', 'postgresql://localhost/live'],
])('disables synthetic delivery with %s=%s', (key, value) => {
  vi.stubEnv(key, value);
  expect(portalSyntheticSender(tenant, local, config)).toBeNull();
});

it('excludes ordinary tenants, public deployments and live providers', () => {
  expect(portalSyntheticSender({ isDemo: false }, local, config)).toBeNull();
  expect(portalSyntheticSender(tenant, 'pharmacy.example', config)).toBeNull();
  expect(portalSyntheticSender(tenant, local, { ...config, provider: 'meta' })).toBeNull();
});

it('requires tenant-owned approved WhatsApp credentials and a sign-in template', () => {
  const live = {
    ...config,
    provider: 'meta' as const,
    organizationId: 'tenant',
    liveSendApproved: true,
    phoneNumberId: 'fixture',
    accessToken: 'fixture',
    templates: { ...config.templates, portalSignInCode: 'fixture' },
  };
  expect(portalWhatsAppReady('tenant', live)).toBe(true);
  for (const invalid of [
    config,
    { ...live, organizationId: 'other' },
    { ...live, liveSendApproved: false },
    { ...live, accessToken: null },
    { ...live, phoneNumberId: null },
    { ...live, templates: config.templates },
  ]) {
    expect(portalWhatsAppReady('tenant', invalid)).toBe(false);
  }
});
