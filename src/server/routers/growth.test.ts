import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));

import { decryptSecret } from '@/lib/secret-crypto';
import { webhookSecretHash } from '@/lib/growth/whatsapp/webhook-secret';
import { annotateAudit } from '@/server/audit';
import { PHARMACY_ROLE_TEMPLATES, RESTAURANT_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

import { growthRouter } from './growth';

type Permission = { capability: string; effect: 'ALLOW' };

function permissionsFor(
  templates: readonly { key: string; capabilities: readonly string[] }[],
  key: string
): Permission[] {
  return templates
    .find((role) => role.key === key)!
    .capabilities.map((capability) => ({ capability, effect: 'ALLOW' }));
}

function customerRow() {
  return {
    id: 'c1',
    organizationId: 'org_1',
    displayName: 'Ayesha',
    whatsappE164: '+923001234567',
    whatsappOptIn: false,
    whatsappOptInAt: null as Date | null,
    whatsappOptOutAt: null as Date | null,
  };
}

function dbFor(rolePermissions: Permission[]) {
  const customer = customerRow();
  const updateMany = vi.fn(async ({ data }: { data: Partial<typeof customer> }) => {
    Object.assign(customer, data);
    return { count: 1 };
  });
  return {
    customer,
    updateMany,
    db: {
      user: {
        findUnique: async () => ({
          organizationRole: { permissions: rolePermissions },
          permissionOverrides: [],
        }),
      },
      growthWaCustomer: {
        findFirst: async () => customer,
        updateMany,
      },
    },
  };
}

function caller(db: ReturnType<typeof dbFor>['db'], role: 'EMPLOYEE' | 'ADMIN' = 'EMPLOYEE') {
  return growthRouter.createCaller({
    db,
    entitlements: {
      enabledModules: ['growth_ai'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        role,
        department: 'OPERATIONS',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: { id: 'org_1', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('growth.customers.setOptIn', () => {
  let fixture: ReturnType<typeof dbFor>;

  beforeEach(() => {
    fixture = dbFor([]);
  });

  it.each([
    ['pharmacy cashier', permissionsFor(PHARMACY_ROLE_TEMPLATES, 'cashier')],
    ['pharmacy owner', permissionsFor(PHARMACY_ROLE_TEMPLATES, 'owner')],
    ['restaurant cashier', permissionsFor(RESTAURANT_ROLE_TEMPLATES, 'cashier')],
  ])('allows the %s', async (_label, rolePermissions) => {
    fixture = dbFor(rolePermissions);
    const saved = await caller(fixture.db).customers.setOptIn({
      customerId: 'c1',
      whatsappOptIn: true,
    });
    expect(saved.whatsappOptIn).toBe(true);
    expect(fixture.updateMany).toHaveBeenCalledOnce();
  });

  it.each([
    ['pharmacy finance', permissionsFor(PHARMACY_ROLE_TEMPLATES, 'finance')],
    ['growth.manage only', [{ capability: 'growth.manage', effect: 'ALLOW' as const }]],
    ['no counter role', []],
  ])('refuses the %s', async (_label, rolePermissions) => {
    fixture = dbFor(rolePermissions);
    await expect(
      caller(fixture.db).customers.setOptIn({ customerId: 'c1', whatsappOptIn: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.customer.whatsappOptIn).toBe(false);
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a till opt-in after the customer sent STOP', async () => {
    fixture = dbFor(permissionsFor(PHARMACY_ROLE_TEMPLATES, 'cashier'));
    fixture.customer.whatsappOptIn = false;
    fixture.customer.whatsappOptOutAt = new Date('2026-10-21T05:00:00.000Z');
    await expect(
      caller(fixture.db).customers.setOptIn({ customerId: 'c1', whatsappOptIn: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });
});

describe('growth.whatsapp.rotateWebhookSecret', () => {
  it('shows 32 random bytes once to an admin and stores only the sealed secret', async () => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'growth-test-key');
    const writes: Array<{ waWebhookSecretHash: string; waWebhookSecretEnc: string }> = [];
    const db = {
      ...dbFor([]).db,
      growthWaSettings: {
        upsert: async (args: {
          create: { waWebhookSecretHash: string; waWebhookSecretEnc: string };
        }) => {
          writes.push(args.create);
          return args.create;
        },
      },
    };
    await expect(caller(db).whatsapp.rotateWebhookSecret()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(writes).toHaveLength(0);

    const first = await caller(db, 'ADMIN').whatsapp.rotateWebhookSecret();
    const second = await caller(db, 'ADMIN').whatsapp.rotateWebhookSecret();
    expect(Buffer.from(first.secret, 'base64url')).toHaveLength(32);
    expect(first.secret).not.toBe(second.secret);
    expect(writes[0]?.waWebhookSecretHash).toBe(webhookSecretHash(first.secret));
    expect(decryptSecret(writes[0]!.waWebhookSecretEnc)).toBe(first.secret);
    expect(writes[0]?.waWebhookSecretEnc).not.toContain(first.secret);
    expect(writes[1]?.waWebhookSecretHash).not.toBe(writes[0]?.waWebhookSecretHash);
    expect(vi.mocked(annotateAudit).mock.calls.map((call) => JSON.stringify(call))).not.toEqual(
      expect.arrayContaining([expect.stringContaining(first.secret)])
    );
    expect(annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'GrowthWaSettings',
        targetId: 'org_1',
        metadata: { rotated: true },
      })
    );
    vi.unstubAllEnvs();
  });
});
