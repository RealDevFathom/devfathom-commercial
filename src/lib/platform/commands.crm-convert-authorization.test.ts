import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertPlatformCapability: vi.fn(),
  withPlatformDb: vi.fn(async () => undefined),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({
  assertPlatformCapability: mocks.assertPlatformCapability,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));

import { executePlatformCommand } from './commands';

const actor = { id: 'sales_1', role: 'SALES' } as never;
const request = new Request('https://admin.devfathom.test/api/platform/control', {
  method: 'POST',
});

describe('CRM opportunity conversion authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires organization provisioning permission before entering the transaction', async () => {
    await executePlatformCommand(actor, 'crm.opportunity.convert', {}, request);

    expect(mocks.assertPlatformCapability).toHaveBeenCalledWith(actor, 'organizations:write');
    expect(mocks.assertPlatformCapability).not.toHaveBeenCalledWith(actor, 'crm:write');
  });

  it('keeps ordinary CRM mutations under the CRM capability', async () => {
    await executePlatformCommand(actor, 'crm.opportunity.stage', {}, request);

    expect(mocks.assertPlatformCapability).toHaveBeenCalledWith(actor, 'crm:write');
  });
});
