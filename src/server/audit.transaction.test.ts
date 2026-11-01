import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({
  outsideCreate: vi.fn(),
  withTenantDb: vi.fn(),
  withPlatformDb: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: mocks.withTenantDb,
  withPlatformDb: mocks.withPlatformDb,
  createTenantDb: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({ enabledModules: [] }),
}));

import { bindSideEffects } from '@/lib/side-effects/scope';
import { flushAuditWritesForTest, recordTrpcAudit, toAuditJson } from './audit';
import { createTRPCContext, protectedProcedure, router, type TRPCContext } from './trpc';

const organizationId = 'org_demo_restaurant_seat_1';
const actorId = 'user_demo_restaurant_seat_1_manager';
const probe = router({ create: protectedProcedure.mutation(() => 'created') });

async function context(db: ScopedDb, transactional = true) {
  return createTRPCContext({
    db,
    ...(transactional ? { auditDb: db } : {}),
    organization: { id: organizationId, isDemo: true } as TRPCContext['organization'] & {},
    session: {
      expires: '2099-01-01T00:00:00Z',
      user: { id: actorId, organizationId, status: 'ACTIVE', role: 'ADMIN' },
    } as TRPCContext['session'],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.outsideCreate.mockResolvedValue({ id: 'audit_committed' });
  mocks.withTenantDb.mockImplementation(async (_id, run) =>
    run({ auditLog: { create: mocks.outsideCreate } })
  );
});

describe('transaction-bound seed audits', () => {
  it('writes the uncommitted manager audit in the seed transaction and awaits durability', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = vi.fn(async () => {
      await pending;
      return { id: 'audit_seed' };
    });
    const db = { auditLog: { create } } as unknown as ScopedDb;
    const ctx = await context(db);
    let finished = false;
    const call = probe
      .createCaller(ctx)
      .create()
      .then((value) => {
        finished = true;
        return value;
      });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId,
        actorId,
        actorType: 'USER',
        action: 'create',
        outcome: 'SUCCESS',
      }),
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
    release();
    await expect(call).resolves.toBe('created');
  });

  it('fails the seed operation when its audit cannot persist', async () => {
    const create = vi.fn().mockRejectedValue(new Error('audit_logs_actorId_fkey'));
    const ctx = await context({ auditLog: { create } } as unknown as ScopedDb);
    await expect(probe.createCaller(ctx).create()).rejects.toThrow('audit_logs_actorId_fkey');
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('retains independent audit writes for normal contexts', async () => {
    const create = vi.fn();
    const ctx = await context({ auditLog: { create } } as unknown as ScopedDb, false);
    expect(
      recordTrpcAudit({
        ctx,
        path: 'create',
        type: 'mutation',
        input: { password: 'private' },
        outcome: 'SUCCESS',
      })
    ).toBeUndefined();
    await flushAuditWritesForTest();
    expect(create).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).toHaveBeenCalledWith(organizationId, expect.any(Function), {
      maxWait: 1000,
      timeout: 5000,
      skipDrain: true,
    });
    expect(mocks.outsideCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId,
        actorId,
        input: { password: '[REDACTED]' },
      }),
    });
  });

  it('defers normal audits until the owning transaction has settled', async () => {
    const ctx = await context({} as ScopedDb, false);
    await bindSideEffects(async (scope) => {
      recordTrpcAudit({ ctx, path: 'payments', type: 'query', input: {}, outcome: 'SUCCESS' });
      expect(mocks.outsideCreate).not.toHaveBeenCalled();
      expect(scope.afterTransaction).toHaveLength(1);
      scope.afterTransaction[0]();
    });
    await flushAuditWritesForTest();
    expect(mocks.outsideCreate).toHaveBeenCalledOnce();
  });

  it.each(['SUCCESS', 'FAILURE'] as const)(
    'redacts witness PINs in %s audit writes without hiding unrelated fields',
    async (outcome) => {
      const ctx = await context({} as ScopedDb, false);
      recordTrpcAudit({
        ctx,
        path: 'pharmacyPurchasing.postGoodsReceipt',
        type: 'mutation',
        input: {
          goodsReceiptId: 'receipt_a',
          pin: '1234',
          witnesses: [{ PIN: '5678', staffProfileId: 'staff_a' }],
          shippingAddress: 'Test address',
        },
        outcome,
      });
      await flushAuditWritesForTest();

      expect(mocks.outsideCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          input: {
            goodsReceiptId: 'receipt_a',
            pin: '[REDACTED]',
            witnesses: [{ PIN: '[REDACTED]', staffProfileId: 'staff_a' }],
            shippingAddress: 'Test address',
          },
          outcome,
        }),
      });
    }
  );

  it('rejects an audit transaction belonging to another context', async () => {
    const ctx = await context({} as ScopedDb);
    await expect(
      createTRPCContext({
        db: ctx.db,
        auditDb: {} as ScopedDb,
        organization: ctx.organization!,
        session: ctx.session,
      })
    ).rejects.toThrow('Audit transaction must match');
  });
});

it('redacts nested purchasing PINs even when input validation refuses the request', () => {
  expect(
    toAuditJson({
      pin: '1234',
      approvalPin: '2345',
      directPurchase: { pin: '3456', approvedByUserId: 'person' },
      metadata: { pinVerified: true },
    })
  ).toEqual({
    pin: '[REDACTED]',
    approvalPin: '[REDACTED]',
    directPurchase: { pin: '[REDACTED]', approvedByUserId: 'person' },
    metadata: { pinVerified: true },
  });
});
