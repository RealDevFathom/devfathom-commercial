import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  verify: vi.fn(),
  parse: vi.fn(),
  organization: vi.fn(),
  inbound: vi.fn(),
  callback: vi.fn(),
  quality: vi.fn(),
}));
vi.mock('@/lib/pharmacy/whatsapp/provider', () => ({
  readWhatsAppConfig: mocks.config,
  createWhatsAppProvider: () => ({ verifyWebhook: mocks.verify, parseInbound: mocks.parse }),
}));
vi.mock('@/lib/pharmacy/whatsapp/inbound', () => ({ handleInboundWhatsAppMessage: mocks.inbound }));
vi.mock('@/lib/pharmacy/marketing-delivery', () => ({ recordMarketingCallback: mocks.callback }));
vi.mock('@/lib/pharmacy/whatsapp/account-quality', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/whatsapp/account-quality')>()),
  applyAccountQualityUpdates: mocks.quality,
}));
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

it('applies account-quality updates only for the explicitly bound WABA after signature validation', async () => {
  const accountRequest = () =>
    new Request('http://pharmacy.localhost/api/pharmacy/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          { id: 'foreign-waba', changes: [{ field: 'account_update', value: { event: 'BAN' } }] },
          { id: 'waba-a', changes: [{ field: 'account_update', value: { event: 'REINSTATED' } }] },
        ],
      }),
    });
  expect((await POST(accountRequest())).status).toBe(200);
  expect(mocks.quality).not.toHaveBeenCalled();

  mocks.config.mockReturnValue({
    phoneNumberId: 'sender-a',
    organizationId: 'org-a',
    businessAccountId: 'waba-a',
    accountAppealUrl: 'https://business.facebook.com/accountquality',
  });
  expect((await POST(accountRequest())).status).toBe(200);
  expect(mocks.quality).toHaveBeenCalledExactlyOnceWith(
    {},
    'org-a',
    [{ key: 'waba-a:REINSTATED', action: 'recover', level: 'recovery', event: 'REINSTATED' }],
    'https://business.facebook.com/accountquality'
  );

  mocks.quality.mockClear();
  mocks.verify.mockReturnValue(false);
  expect((await POST(accountRequest())).status).toBe(401);
  expect(mocks.quality).not.toHaveBeenCalled();
});
