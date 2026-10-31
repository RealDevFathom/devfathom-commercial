import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  verify: vi.fn(),
  parse: vi.fn(),
  organization: vi.fn(),
  inbound: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sms/provider', () => ({
  readSmsConfig: mocks.config,
  createSmsProvider: () => ({ verifyWebhook: mocks.verify, parseInbound: mocks.parse }),
}));
vi.mock('@/lib/pharmacy/sms/inbound', () => ({ handleInboundSms: mocks.inbound }));
vi.mock('@/lib/rate-limit', () => ({ clientIp: () => 'local', rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'pharmacy.localhost',
  resolveExplicitOrganizationByHost: mocks.organization,
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
}));

import { POST } from './route';

const request = (body = '{}') =>
  new Request('http://pharmacy.localhost/api/pharmacy/sms/webhook', {
    method: 'POST',
    headers: { 'x-sms-signature': 'sha256=abc' },
    body,
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue({ organizationId: 'org-a', language: 'en' });
  mocks.verify.mockReturnValue(true);
  mocks.organization.mockResolvedValue({
    id: 'org-a',
    status: 'ACTIVE',
    vertical: 'PHARMACY',
    isDemo: false,
  });
  mocks.parse.mockReturnValue([{ providerMessageId: 'sms-1', from: '923001234567' }]);
  mocks.inbound.mockResolvedValue('OPTED_OUT');
});

it('rejects an invalid signature before tenant or message processing', async () => {
  mocks.verify.mockReturnValue(false);
  expect((await POST(request())).status).toBe(401);
  expect(mocks.verify).toHaveBeenCalledWith('{}', 'sha256=abc');
  expect(mocks.organization).not.toHaveBeenCalled();
  expect(mocks.inbound).not.toHaveBeenCalled();
});

it.each([{}, { organizationId: 'org-b' }])(
  'denies an SMS sender without the correct tenant binding: %j',
  async (config) => {
    mocks.config.mockReturnValue(config);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.parse).not.toHaveBeenCalled();
  }
);

it.each([
  { id: 'org-a', status: 'ACTIVE', vertical: 'RESTAURANT', isDemo: false },
  { id: 'org-a', status: 'ACTIVE', vertical: 'PHARMACY', isDemo: true },
  { id: 'org-a', status: 'SUSPENDED', vertical: 'PHARMACY', isDemo: false },
  null,
])('refuses a host that is not a live pharmacy tenant: %j', async (organization) => {
  mocks.organization.mockResolvedValue(organization);
  expect((await POST(request())).status).toBe(404);
  expect(mocks.inbound).not.toHaveBeenCalled();
});

it('rejects a malformed body after authentication', async () => {
  expect((await POST(request('not json'))).status).toBe(400);
});

it('handles STOP for the authenticated, tenant-owned sender', async () => {
  expect(await (await POST(request())).json()).toEqual({ received: 1, outcomes: ['OPTED_OUT'] });
  expect(mocks.inbound).toHaveBeenCalledWith(
    'org-a',
    expect.objectContaining({ organizationId: 'org-a' }),
    expect.anything(),
    expect.objectContaining({ providerMessageId: 'sms-1' })
  );
});
