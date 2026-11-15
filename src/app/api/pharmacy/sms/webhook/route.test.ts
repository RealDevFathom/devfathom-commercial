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
vi.mock('@/lib/pharmacy/sms/inbound', () => ({ handleInboundSmsMessage: mocks.inbound }));
vi.mock('@/lib/rate-limit', () => ({ clientIp: () => 'local', rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'pharmacy.localhost',
  resolveExplicitOrganizationByHost: mocks.organization,
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
}));

import { POST } from './route';

const request = () =>
  new Request('http://pharmacy.localhost/api/pharmacy/sms/webhook', {
    method: 'POST',
    body: '{}',
    headers: { 'x-sms-signature': 'sha256=abc' },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue({ provider: 'mock', organizationId: 'org-a' });
  mocks.verify.mockReturnValue(true);
  mocks.organization.mockResolvedValue({
    id: 'org-a',
    status: 'ACTIVE',
    vertical: 'PHARMACY',
    isDemo: false,
  });
  mocks.parse.mockReturnValue([{ providerMessageId: 'sms-a', from: '923001234567' }]);
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
  'denies a sender without the correct tenant binding: %j',
  async (config) => {
    mocks.config.mockReturnValue(config);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.parse).not.toHaveBeenCalled();
  }
);

it('rejects demo and non-pharmacy tenants', async () => {
  mocks.organization.mockResolvedValue({
    id: 'org-a',
    status: 'ACTIVE',
    vertical: 'AGENCY',
    isDemo: false,
  });
  expect((await POST(request())).status).toBe(404);
  expect(mocks.inbound).not.toHaveBeenCalled();
});

it('handles STOP for the authenticated tenant-owned sender', async () => {
  expect(await (await POST(request())).json()).toEqual({ received: 1, outcomes: ['OPTED_OUT'] });
  expect(mocks.inbound).toHaveBeenCalledWith(
    'org-a',
    expect.anything(),
    expect.objectContaining({ providerMessageId: 'sms-a' })
  );
});
