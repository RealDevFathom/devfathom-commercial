import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
  recordTrpcAudit: vi.fn(),
  generateApiToken: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/lib/api-auth', () => ({ generateApiToken: mocks.generateApiToken }));
vi.mock('@/lib/webhooks', () => ({
  WEBHOOK_EVENTS: ['invoice.paid', 'task.created'] as const,
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.recordTrpcAudit,
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { router, type TRPCContext } from '../trpc';
import { apiTokensRouter } from './api-tokens';
import { webhooksRouter } from './webhooks';

const testRouter = router({ apiTokens: apiTokensRouter, webhooks: webhooksRouter });

const token = {
  id: 'token_1',
  name: 'CI token',
  prefix: 'df_existing',
  scopes: ['*'],
  user: { id: 'user_1', name: 'Admin', email: 'admin@example.com', avatar: null, role: 'ADMIN' },
};
const webhook = {
  id: 'webhook_1',
  url: 'https://example.com/hook',
  events: ['task.created'],
  active: true,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
};

function context(supportSession = false) {
  const db = {
    apiToken: {
      findMany: vi.fn(async () => [token]),
      delete: vi.fn(async () => token),
      create: vi.fn(),
    },
    auditLog: { groupBy: vi.fn(async () => []) },
    webhook: {
      findMany: vi.fn(async () => [webhook]),
      delete: vi.fn(async () => webhook),
      create: vi.fn(),
      update: vi.fn(),
    },
    webhookDelivery: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn() },
  };
  const ctx = {
    db,
    entitlements: {
      organizationId: 'org_1',
      seatLimit: 10,
      activeSeats: 1,
      enabledModules: [],
      modules: [
        {
          key: 'api',
          name: 'API access',
          enabled: false,
          source: 'OVERRIDE',
          seatLimit: null,
          expiresAt: null,
        },
        {
          key: 'webhooks',
          name: 'Webhooks',
          enabled: false,
          source: 'OVERRIDE',
          seatLimit: null,
          expiresAt: null,
        },
      ],
      limits: {},
    },
    session: {
      expires: new Date(Date.now() + 60000).toISOString(),
      user: {
        id: 'user_1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        isSupportSession: supportSession,
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { caller: testRouter.createCaller(ctx), db };
}

describe('entitlement-independent inspection and cleanup routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
  });

  it('allows token inspection and revocation while API access is disabled', async () => {
    const { caller, db } = context();

    await expect(caller.apiTokens.list()).resolves.toEqual([token]);
    await expect(caller.apiTokens.usage()).resolves.toEqual({});
    await expect(caller.apiTokens.revoke({ id: token.id })).resolves.toEqual(token);
    expect(db.apiToken.delete).toHaveBeenCalledWith({ where: { id: token.id } });
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'apiTokens.list', type: 'query' })
    );
  });

  it('allows webhook history inspection and deletion while delivery is disabled', async () => {
    const { caller, db } = context();

    await expect(caller.webhooks.list()).resolves.toEqual([webhook]);
    await expect(caller.webhooks.recentDeliveries({ webhookId: webhook.id })).resolves.toEqual([]);
    await expect(caller.webhooks.delete({ id: webhook.id })).resolves.toEqual(webhook);
    expect(db.webhook.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: webhook.id } })
    );
  });

  it('keeps token creation and webhook creation/update licensed', async () => {
    const { caller, db } = context();

    await expect(caller.apiTokens.create({ name: 'Blocked', scopes: ['*'] })).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
        message: 'The API access module is not enabled for this organization.',
      }
    );
    await expect(
      caller.webhooks.create({ url: 'https://example.com/new', events: ['task.created'] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.webhooks.update({ id: webhook.id, active: false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.apiToken.create).not.toHaveBeenCalled();
    expect(db.webhook.create).not.toHaveBeenCalled();
    expect(db.webhook.update).not.toHaveBeenCalled();
  });
});

describe('support impersonation token boundary', () => {
  it('allows inspection but rejects token creation and revocation with only the session marker', async () => {
    const { caller, db } = context(true);
    await expect(caller.apiTokens.list()).resolves.toEqual([token]);
    await expect(caller.apiTokens.create({ name: 'escape', scopes: ['*'] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Support access is read-only.',
    });
    await expect(caller.apiTokens.revoke({ id: token.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.apiToken.create).not.toHaveBeenCalled();
    expect(db.apiToken.delete).not.toHaveBeenCalled();
    expect(mocks.generateApiToken).not.toHaveBeenCalled();
  });
});
