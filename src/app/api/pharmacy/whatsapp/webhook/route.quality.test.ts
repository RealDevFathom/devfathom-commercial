// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({ write: vi.fn(), organization: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_org: string, run: (db: unknown) => unknown) =>
    run({ $executeRaw: mocks.write }),
}));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'tenant-a.localhost',
  resolveExplicitOrganizationByHost: mocks.organization,
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
}));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => 'local',
  rateLimit: async () => ({ ok: true }),
}));
vi.mock('@/lib/pharmacy/whatsapp/inbound', () => ({ handleInboundWhatsAppMessage: vi.fn() }));
vi.mock('@/lib/pharmacy/marketing-delivery', () => ({ recordMarketingCallback: vi.fn() }));

import { POST } from './route';
const secret = 'quality-webhook-test-secret';
function request(
  value: Record<string, unknown>,
  account = 'account-a',
  time = 1790000000,
  validSignature = true
) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: account, time, changes: [{ field: 'account_update', value }] }],
  });
  return new Request('http://tenant-a.localhost/api/pharmacy/whatsapp/webhook', {
    method: 'POST',
    body,
    headers: {
      'x-hub-signature-256': `sha256=${validSignature ? createHmac('sha256', secret).update(body).digest('hex') : 'invalid'}`,
    },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('PHARMACY_WHATSAPP_PROVIDER', 'mock');
  vi.stubEnv('PHARMACY_WHATSAPP_APP_SECRET', secret);
  vi.stubEnv('PHARMACY_WHATSAPP_ORGANIZATION_ID', 'org-a');
  vi.stubEnv('PHARMACY_WHATSAPP_PHONE_NUMBER_ID', 'sender-a');
  vi.stubEnv('PHARMACY_WHATSAPP_BUSINESS_ACCOUNT_ID', 'account-a');
  mocks.organization.mockResolvedValue({
    id: 'org-a',
    status: 'ACTIVE',
    vertical: 'PHARMACY',
    isDemo: false,
  });
  mocks.write.mockResolvedValue(1);
});
afterEach(() => vi.unstubAllEnvs());

it('rejects an invalid real HMAC before resolving the tenant or writing quality evidence', async () => {
  expect(
    (await POST(request({ new_quality_score: 'RED' }, 'account-a', 1790000000, false))).status
  ).toBe(401);
  expect(mocks.organization).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
});

it.each([
  ['foreign-account', { event: 'ACCOUNT_VIOLATION', waba_info: { waba_id: 'foreign-account' } }],
  ['foreign-account', { new_quality_score: 'GREEN', phone_number_id: 'sender-a' }],
  ['account-a', { new_quality_score: 'GREEN', waba_info: { waba_id: 'foreign-account' } }],
  ['account-a', { new_quality_score: 'RED', phone_number_id: 'foreign-sender' }],
] as const)(
  'ignores correctly signed foreign account/sender evidence: %s %j',
  async (account, value) => {
    expect((await POST(request(value, account))).status).toBe(200);
    expect(mocks.write).not.toHaveBeenCalled();
  }
);

it('rejects ambiguous account evidence when no account binding is configured', async () => {
  vi.stubEnv('PHARMACY_WHATSAPP_BUSINESS_ACCOUNT_ID', '');
  expect((await POST(request({ event: 'ACCOUNT_VIOLATION' }))).status).toBe(200);
  expect(mocks.write).not.toHaveBeenCalled();
});

it('passes provider time and stable replay identity from signed quality events to the atomic writer', async () => {
  await POST(request({ new_quality_score: 'RED' }, 'account-a', 1790000002));
  await POST(request({ new_quality_score: 'GREEN' }, 'account-a', 1790000001));
  await POST(request({ new_quality_score: 'GREEN' }, 'account-a', 1790000001));
  const statements = mocks.write.mock.calls.map(([query]) => (query as Prisma.Sql).values);
  expect(statements[0]).toContainEqual(new Date(1790000002000));
  expect(statements[1]).toContainEqual(new Date(1790000001000));
  expect(statements[1]).toEqual(statements[2]);
  expect(statements[0]).toEqual(expect.arrayContaining(['org-a', 'sender-a', 'RED', true]));
});
