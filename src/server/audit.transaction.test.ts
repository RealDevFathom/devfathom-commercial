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

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { bindSideEffects } from '@/lib/side-effects/scope';
import { flushAuditWritesForTest, isPinKey, recordTrpcAudit, toAuditJson } from './audit';
import { createTRPCContext, protectedProcedure, router, type TRPCContext } from './trpc';

const organizationId = 'org_demo_restaurant_seat_1';
const actorId = 'user_demo_restaurant_seat_1_manager';
const probe = router({ create: protectedProcedure.mutation(() => 'created') });
// Mirrors pharmacySales.returnLine: a transient witness credential beside the operation input.
const witnessProbe = router({
  returnLine: protectedProcedure
    .input(
      z
        .object({
          saleLineId: z.string(),
          controlledWitness: z
            .object({ staffProfileId: z.string(), pin: z.string().regex(/^\d{4,8}$/) })
            .strict()
            .optional(),
        })
        .strict()
    )
    .mutation(({ input }) => {
      if (input.saleLineId === 'denied') throw new TRPCError({ code: 'FORBIDDEN' });
      return { blocked: input.saleLineId === 'blocked' ? 'Fresh witness PIN needed.' : undefined };
    }),
});

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

describe('central PIN redaction in audit capture', () => {
  const pinValues = ['4826', '91827364', '0000'];
  function expectNoPin(value: unknown) {
    const text = JSON.stringify(value);
    for (const pin of pinValues) expect(text).not.toContain(pin);
  }

  it.each([
    ['committed', 'line_a', 'SUCCESS'],
    ['blocked', 'blocked', 'SUCCESS'],
    ['forbidden', 'denied', 'FAILURE'],
  ] as const)(
    'never stores the witness PIN for a %s controlled return',
    async (_label, saleLineId, outcome) => {
      const ctx = await context({} as ScopedDb, false);
      const call = witnessProbe
        .createCaller(ctx)
        .returnLine({ saleLineId, controlledWitness: { staffProfileId: 'staff_w', pin: '4826' } });
      if (outcome === 'FAILURE') await expect(call).rejects.toThrow();
      else await call;
      await flushAuditWritesForTest();

      expect(mocks.outsideCreate).toHaveBeenCalledOnce();
      const data = mocks.outsideCreate.mock.calls[0][0].data;
      expect(data).toMatchObject({
        outcome,
        input: {
          saleLineId,
          controlledWitness: { staffProfileId: 'staff_w', pin: '[REDACTED]' },
        },
      });
      expectNoPin(data);
    }
  );

  it('redacts a PIN from input rejected by validation before the resolver runs', async () => {
    const ctx = await context({} as ScopedDb, false);
    await expect(
      witnessProbe.createCaller(ctx).returnLine({
        saleLineId: 'line_a',
        controlledWitness: { staffProfileId: 'staff_w', pin: '91827364', extra: true },
      } as never)
    ).rejects.toThrow();
    await flushAuditWritesForTest();

    expect(mocks.outsideCreate).toHaveBeenCalledOnce();
    const data = mocks.outsideCreate.mock.calls[0][0].data;
    expect(data.outcome).toBe('FAILURE');
    expect(data.input.controlledWitness.pin).toBe('[REDACTED]');
    expectNoPin(data);
  });

  it('redacts PIN-bearing keys in input, changes, result and metadata', async () => {
    const ctx = await context({} as ScopedDb, false);
    Object.assign(ctx.audit!.detail, {
      changes: { ownerPin: { before: '0000', after: '4826' } },
      result: { witness: { staffPin: '4826' } },
      metadata: { newPIN: '91827364' },
    });
    recordTrpcAudit({
      ctx,
      path: 'pharmacyOwners.setPin',
      type: 'mutation',
      input: { ownerPin: '0000', currentPin: '4826', pin_code: '91827364' },
      outcome: 'SUCCESS',
    });
    await flushAuditWritesForTest();

    const data = mocks.outsideCreate.mock.calls[0][0].data;
    expect(data.input).toEqual({
      ownerPin: '[REDACTED]',
      currentPin: '[REDACTED]',
      pin_code: '[REDACTED]',
    });
    expectNoPin(data);
  });

  it('matches PIN as a whole key word without hiding unrelated fields', () => {
    for (const key of [
      'pin',
      'PIN',
      'pins',
      'witnessPin',
      'ownerPIN',
      'staff_pin',
      'pinCode',
      'pin-code',
      'newPinHash',
      'passcode',
    ])
      expect(isPinKey(key)).toBe(true);
    for (const key of ['shippingAddress', 'spinner', 'pinnedAt', 'opinion', 'pinyin', 'mapping'])
      expect(isPinKey(key)).toBe(false);

    expect(
      toAuditJson({
        controlledWitness: { staffProfileId: 'staff_w', pin: '4826' },
        approvals: [{ ownerPin: '0000', ownerId: 'owner_a' }],
        shippingAddress: 'Main road',
        pinnedAt: '2026-11-01',
      })
    ).toEqual({
      controlledWitness: { staffProfileId: 'staff_w', pin: '[REDACTED]' },
      approvals: [{ ownerPin: '[REDACTED]', ownerId: 'owner_a' }],
      shippingAddress: 'Main road',
      pinnedAt: '2026-11-01',
    });
  });
});
