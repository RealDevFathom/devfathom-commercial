import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  verify: vi.fn(),
  parse: vi.fn(),
  organization: vi.fn(),
  inbound: vi.fn(),
  callback: vi.fn(),
  blockRate: vi.fn(),
  tenantDb: {} as unknown,
}));
vi.mock('@/lib/pharmacy/whatsapp/provider', () => ({
  readWhatsAppConfig: mocks.config,
  createWhatsAppProvider: () => ({ verifyWebhook: mocks.verify, parseInbound: mocks.parse }),
}));
vi.mock('@/lib/pharmacy/whatsapp/inbound', () => ({ handleInboundWhatsAppMessage: mocks.inbound }));
vi.mock('@/lib/pharmacy/marketing-delivery', () => ({ recordMarketingCallback: mocks.callback }));
vi.mock('@/lib/pharmacy/marketing-send-policy', () => ({
  evaluateMarketingBlockRate: mocks.blockRate,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_org: string, fn: (db: unknown) => unknown) => fn(mocks.tenantDb),
}));
vi.mock('@/lib/rate-limit', () => ({ clientIp: () => 'local', rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'pharmacy.localhost',
  resolveExplicitOrganizationByHost: mocks.organization,
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
}));
import { createHmac } from 'node:crypto';
import { POST } from './route';
const request = () =>
  new Request('http://pharmacy.localhost/api/pharmacy/whatsapp/webhook', {
    method: 'POST',
    body: '{}',
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.tenantDb = {};
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

it('re-checks the block rate after a STOP and after a replayed STOP', async () => {
  await POST(request());
  expect(mocks.blockRate).toHaveBeenCalledWith({}, 'org-a');
  mocks.blockRate.mockClear();
  // A Meta retry of a STOP whose first check failed is handled as DUPLICATE.
  mocks.inbound.mockResolvedValue('DUPLICATE');
  await POST(request());
  expect(mocks.blockRate).toHaveBeenCalledWith({}, 'org-a');
});
it('skips the block-rate check when no sender message was handled', async () => {
  mocks.parse.mockReturnValue([]);
  await POST(request());
  expect(mocks.blockRate).not.toHaveBeenCalled();
});
it('records a signed account_update fixture as an owner alert, and nothing when unsigned', async () => {
  const secret = 'app-secret-a';
  const { verifyMetaSignature } = await vi.importActual<
    typeof import('@/lib/pharmacy/whatsapp/provider')
  >('@/lib/pharmacy/whatsapp/provider');
  mocks.verify.mockImplementation((body: string, header: string | null) =>
    verifyMetaSignature(secret, body, header)
  );
  mocks.parse.mockReturnValue([]);
  mocks.config.mockReturnValue({
    phoneNumberId: 'sender-a',
    organizationId: 'org-a',
    businessAccountId: 'waba-a',
  });
  const events: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  mocks.tenantDb = {
    pharmacyWhatsAppAccountEvent: {
      createMany: async ({ data }: { data: Record<string, unknown> }) => {
        events.push({ ...data, id: `evt-${events.length + 1}` });
        return { count: 1 };
      },
      findFirst: async () => events.at(-1),
    },
    user: {
      findMany: async () => [
        {
          id: 'owner-a',
          role: 'ADMIN',
          status: 'ACTIVE',
          organizationRole: { key: 'owner', isSystem: true, permissions: [] },
          permissionOverrides: [],
        },
      ],
    },
    notification: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        notifications.push(...data);
        return { count: data.length };
      },
    },
  };
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-a',
        time: 1790000000,
        changes: [
          {
            field: 'account_update',
            value: { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'DISABLE' } },
          },
        ],
      },
    ],
  });
  const signed = (signature: string) =>
    new Request('http://pharmacy.localhost/api/pharmacy/whatsapp/webhook', {
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': signature },
    });
  expect((await POST(signed('sha256=' + '0'.repeat(64)))).status).toBe(401);
  expect(events).toHaveLength(0);
  expect(notifications).toHaveLength(0);

  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  expect((await POST(signed(signature))).status).toBe(200);
  expect(events).toEqual([
    expect.objectContaining({
      organizationId: 'org-a',
      businessAccountId: 'waba-a',
      event: 'DISABLED_UPDATE',
      severity: 'BLOCK',
    }),
  ]);
  expect(notifications).toEqual([
    expect.objectContaining({
      userId: 'owner-a',
      title: 'WhatsApp account blocked',
      message: expect.stringContaining('appeal'),
    }),
  ]);
});
