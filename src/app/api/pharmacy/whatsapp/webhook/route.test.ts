import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  verify: vi.fn(),
  parse: vi.fn(),
  organization: vi.fn(),
  inbound: vi.fn(),
  callback: vi.fn(),
  pause: vi.fn(),
  blockRate: vi.fn(),
}));
vi.mock('@/lib/pharmacy/whatsapp/provider', () => ({
  readWhatsAppConfig: mocks.config,
  createWhatsAppProvider: () => ({ verifyWebhook: mocks.verify, parseInbound: mocks.parse }),
}));
vi.mock('@/lib/pharmacy/whatsapp/inbound', () => ({ handleInboundWhatsAppMessage: mocks.inbound }));
vi.mock('@/lib/pharmacy/marketing-delivery', () => ({ recordMarketingCallback: mocks.callback }));
vi.mock('@/lib/pharmacy/marketing-send-policy', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pharmacy/marketing-send-policy')>(
    '@/lib/pharmacy/marketing-send-policy'
  );
  return {
    marketingPauseSignal: actual.marketingPauseSignal,
    pauseMarketingSending: mocks.pause,
    evaluateMarketingBlockRate: mocks.blockRate,
  };
});
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_org: string, fn: (db: unknown) => unknown) => fn({}),
}));
vi.mock('@/lib/rate-limit', () => ({ clientIp: () => 'local', rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'pharmacy.localhost',
  resolveExplicitOrganizationByHost: mocks.organization,
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
}));
import { POST } from './route';
const request = () =>
  new Request('http://pharmacy.localhost/api/pharmacy/whatsapp/webhook', {
    method: 'POST',
    body: '{}',
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue({ phoneNumberId: 'sender-a', organizationId: 'org-a' });
  mocks.verify.mockReturnValue(true);
  mocks.organization.mockResolvedValue({
    id: 'org-a',
    status: 'ACTIVE',
    vertical: 'PHARMACY',
    isDemo: false,
  });
  mocks.parse.mockReturnValue([{ providerMessageId: 'message-a', phoneNumberId: 'sender-a' }]);
  mocks.inbound.mockResolvedValue('OPTED_OUT');
});
it('rejects an invalid signature before tenant or message processing', async () => {
  mocks.verify.mockReturnValue(false);
  expect((await POST(request())).status).toBe(401);
  expect(mocks.organization).not.toHaveBeenCalled();
  expect(mocks.inbound).not.toHaveBeenCalled();
});
it.each([{}, { organizationId: 'org-b', phoneNumberId: 'sender-a' }])(
  'denies a sender without the correct tenant binding: %j',
  async (config) => {
    mocks.config.mockReturnValue(config);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.parse).not.toHaveBeenCalled();
  }
);
it.each([null, 'sender-b', ''])(
  'never handles missing or foreign sender metadata: %s',
  async (phoneNumberId) => {
    mocks.parse.mockReturnValue([{ providerMessageId: 'message-a', phoneNumberId }]);
    expect(await (await POST(request())).json()).toEqual({ received: 0, outcomes: [] });
    expect(mocks.inbound).not.toHaveBeenCalled();
  }
);
it('handles only the authenticated tenant-owned sender', async () => {
  expect(await (await POST(request())).json()).toEqual({ received: 1, outcomes: ['OPTED_OUT'] });
  expect(mocks.inbound).toHaveBeenCalledWith(
    'org-a',
    expect.anything(),
    expect.objectContaining({ phoneNumberId: 'sender-a' })
  );
});

it('routes authenticated status evidence only for the owned sender', async () => {
  const payload = (sender: string) =>
    new Request('http://pharmacy.localhost/api/pharmacy/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: sender },
                  statuses: [{ id: 'message-a', status: 'delivered', timestamp: '1790000000' }],
                },
              },
            ],
          },
        ],
      }),
    });
  await POST(payload('foreign'));
  expect(mocks.callback).not.toHaveBeenCalled();
  await POST(payload('sender-a'));
  expect(mocks.callback).toHaveBeenCalledWith(
    {},
    'org-a',
    'sender-a',
    expect.objectContaining({ state: 'DELIVERED', messageId: 'message-a' })
  );
  mocks.verify.mockReturnValue(false);
  mocks.callback.mockClear();
  expect((await POST(payload('sender-a'))).status).toBe(401);
  expect(mocks.callback).not.toHaveBeenCalled();
});

const accountUpdate = (field: string, value: Record<string, unknown>) =>
  new Request('http://pharmacy.localhost/api/pharmacy/whatsapp/webhook', {
    method: 'POST',
    body: JSON.stringify({ entry: [{ id: 'waba-a', changes: [{ field, value }] }] }),
  });
it.each([
  ['phone_number_quality_update', { event: 'DOWNGRADE', current_limit: 'TIER_1K' }],
  ['phone_number_quality_update', { event: 'FLAGGED' }],
  ['account_update', { event: 'ACCOUNT_RESTRICTION' }],
  ['account_update', { quality_rating: 'RED' }],
])('pauses marketing sending on a %s quality drop %j', async (field, value) => {
  mocks.parse.mockReturnValue([]);
  expect((await POST(accountUpdate(field, value))).status).toBe(200);
  expect(mocks.pause).toHaveBeenCalledWith(
    {},
    'org-a',
    expect.objectContaining({ reason: expect.stringMatching(/QUALITY_DROP|ACCOUNT_RESTRICTION/) })
  );
});
it('does not pause on benign account updates or before signature verification', async () => {
  mocks.parse.mockReturnValue([]);
  await POST(accountUpdate('phone_number_quality_update', { event: 'UPGRADE' }));
  await POST(accountUpdate('account_update', { event: 'VERIFIED_ACCOUNT' }));
  expect(mocks.pause).not.toHaveBeenCalled();
  mocks.verify.mockReturnValue(false);
  expect(
    (await POST(accountUpdate('account_update', { event: 'ACCOUNT_RESTRICTION' }))).status
  ).toBe(401);
  expect(mocks.pause).not.toHaveBeenCalled();
});
it('re-checks the block rate after a STOP opt-out only', async () => {
  await POST(request());
  expect(mocks.blockRate).toHaveBeenCalledWith({}, 'org-a');
  mocks.blockRate.mockClear();
  mocks.inbound.mockResolvedValue('ORDER_PLACED');
  await POST(request());
  expect(mocks.blockRate).not.toHaveBeenCalled();
});
