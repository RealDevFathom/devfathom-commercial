import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { z } from 'zod';
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
import { annotateAudit, flushAuditWritesForTest, recordTrpcAudit } from './audit';
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
  it('isolates denial annotations from a successful sibling in an HTTP batch', async () => {
    let release!: () => void;
    const denied = new Promise<void>((resolve) => {
      release = resolve;
    });
    const batchRouter = router({
      refuse: protectedProcedure.mutation(({ ctx }) => {
        annotateAudit(ctx, {
          outcome: 'FAILURE',
          skipInput: true,
          targetId: 'denied-target',
          description: 'Denied operation',
          metadata: { denied: true },
        });
        release();
        return { blocked: true };
      }),
      save: protectedProcedure.input(z.object({ label: z.string() })).mutation(async () => {
        await denied;
        return { saved: true };
      }),
    });
    const create = vi.fn().mockResolvedValue({ id: 'audit_batch' });
    const ctx = await context({ auditLog: { create } } as unknown as ScopedDb);
    const response = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request('https://tenant.test/api/trpc/refuse,save?batch=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 0: { json: null }, 1: { json: { label: 'saved-input' } } }),
      }),
      router: batchRouter,
      createContext: () => ctx,
    });
    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        path: 'refuse',
        outcome: 'FAILURE',
        targetId: 'denied-target',
      }),
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        path: 'save',
        outcome: 'SUCCESS',
        input: { label: 'saved-input' },
      }),
    });
    const saved = create.mock.calls.find(([args]) => args.data.path === 'save')![0].data;
    expect(saved.targetId).not.toBe('denied-target');
    expect(saved.description).not.toBe('Denied operation');
    expect(saved.metadata).not.toEqual(expect.objectContaining({ denied: true }));
    expect(ctx.audit.detail).toEqual({});
  });

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
