// @vitest-environment node
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({ write: vi.fn(), organization: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_org: string, run: (db: unknown) => unknown) =>
    run({ $executeRaw: mocks.write, auditLog: { create: mocks.audit } }),
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
const secret = randomBytes(32).toString('hex');
function request(
  value: Record<string, unknown>,
  account = 'account-a',
  time = 1790000000,
  validSignature = true,
  field = 'account_update'
) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: account, time, changes: [{ field, value }] }],
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
  vi.stubEnv('PHARMACY_WHATSAPP_DISPLAY_PHONE_NUMBER', '+923001234567');
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
  expect(mocks.audit).not.toHaveBeenCalled();
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

it('routes signed phone quality events only for the configured display number', async () => {
  for (const display_phone_number of ['+923001234567', '+923009999999'])
    expect(
      (
        await POST(
          request(
            { event: 'FLAGGED', display_phone_number },
            'account-a',
            1790000000,
            true,
            'phone_number_quality_update'
          )
        )
      ).status
    ).toBe(200);
  expect(mocks.write).toHaveBeenCalledTimes(1);
  expect(mocks.audit).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: 'pharmacyMarketing.qualityPaused',
      targetId: 'sender-a',
      metadata: expect.objectContaining({ reason: 'ACCOUNT_FLAGGED' }),
    }),
  });
});

it('audits numeric block-rate rises even when the signed quality score is GREEN', async () => {
  await POST(request({ previous_block_rate: 0.01, block_rate: 0.03, quality_score: 'GREEN' }));
  expect(mocks.audit).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: 'pharmacyMarketing.qualityPaused',
      metadata: expect.objectContaining({
        reason: 'ACCOUNT_BLOCK_RATE_RISE',
        blockRate: { previous: 0.01, current: 0.03 },
      }),
    }),
  });
});
