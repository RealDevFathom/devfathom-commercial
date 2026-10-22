import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: vi.fn(), connection: vi.fn(), verify: vi.fn(), parse: vi.fn(),
  organization: vi.fn(), inbound: vi.fn(), callback: vi.fn(),
}));
vi.mock('@/lib/pharmacy/whatsapp/provider', () => ({
  readWhatsAppConfig: mocks.config,
  createWhatsAppProvider: () => ({ verifyWebhook: mocks.verify, parseInbound: mocks.parse }),
}));
vi.mock('@/lib/pharmacy/whatsapp/connection', () => ({
  findWhatsAppConnectionByPhoneNumberId: mocks.connection,
}));
vi.mock('@/lib/pharmacy/whatsapp/inbound', () => ({ handleInboundWhatsAppMessage: mocks.inbound }));
vi.mock('@/lib/pharmacy/marketing-delivery', () => ({ recordMarketingCallback: mocks.callback }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (org: string, fn: (db: unknown) => unknown) => {
    mocks.organization(org);
    return fn({ organization: { findUnique: () => mocks.organization() } });
  },
}));
vi.mock('@/lib/rate-limit', () => ({ clientIp: () => 'local', rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/tenancy/host', () => ({
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
}));

import { POST } from './route';

function payload(sender = '11111', statuses?: unknown[]) {
  return new Request('https://webhooks.devfathom.com/api/pharmacy/whatsapp/webhook', {
    method: 'POST',
    body: JSON.stringify({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: sender }, statuses } }] }],
    }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue({ appSecret: 'shared-secret' });
  mocks.connection.mockImplementation(async (sender: string) =>
    sender === '11111'
      ? { organizationId: 'org-a', config: { phoneNumberId: sender, organizationId: 'org-a', accessToken: 'top-secret' } }
      : sender === '22222'
        ? { organizationId: 'org-b', config: { phoneNumberId: sender, organizationId: 'org-b', accessToken: 'other-secret' } }
        : null
  );
  mocks.verify.mockReturnValue(true);
  mocks.organization.mockReturnValue({ id: 'org-a', status: 'ACTIVE', vertical: 'PHARMACY', isDemo: false });
  mocks.parse.mockReturnValue([{ providerMessageId: 'message-a', phoneNumberId: '11111' }]);
  mocks.inbound.mockResolvedValue('OPTED_OUT');
});

it('rejects an invalid signature before resolving a sender', async () => {
  mocks.verify.mockReturnValue(false);
  expect((await POST(payload())).status).toBe(401);
  expect(mocks.connection).not.toHaveBeenCalled();
});

it('rejects an unknown phone_number_id without entering a tenant scope', async () => {
  expect((await POST(payload('99999'))).status).toBe(404);
  expect(mocks.organization).not.toHaveBeenCalled();
  expect(mocks.inbound).not.toHaveBeenCalled();
});

it('routes each sender to its owning organization, independent of webhook host', async () => {
  mocks.parse.mockReturnValue([{ providerMessageId: 'message-b', phoneNumberId: '22222' }]);
  mocks.organization.mockReturnValue({ id: 'org-b', status: 'ACTIVE', vertical: 'PHARMACY', isDemo: false });
  expect(await (await POST(payload('22222'))).json()).toEqual({ received: 1, outcomes: ['OPTED_OUT'] });
  expect(mocks.organization).toHaveBeenCalledWith('org-b');
  expect(mocks.inbound).toHaveBeenCalledWith('org-b', expect.anything(), expect.objectContaining({ phoneNumberId: '22222' }));
});

it('rejects mixed-tenant deliveries', async () => {
  const request = new Request('https://webhooks.devfathom.com/api/pharmacy/whatsapp/webhook', {
    method: 'POST',
    body: JSON.stringify({ entry: [
      { changes: [{ value: { metadata: { phone_number_id: '11111' } } }] },
      { changes: [{ value: { metadata: { phone_number_id: '22222' } } }] },
    ] }),
  });
  expect((await POST(request)).status).toBe(404);
  expect(mocks.connection).not.toHaveBeenCalled();
});

it('never logs a decrypted organization token', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await POST(payload());
  expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain('top-secret');
  log.mockRestore();
  error.mockRestore();
});

it('routes delivery evidence only inside the sender owner scope', async () => {
  await POST(payload('11111', [{ id: 'message-a', status: 'delivered', timestamp: '1790000000' }]));
  expect(mocks.callback).toHaveBeenCalledWith(expect.anything(), 'org-a', '11111', expect.objectContaining({ state: 'DELIVERED', messageId: 'message-a' }));
});
