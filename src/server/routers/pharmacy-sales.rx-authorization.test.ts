import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true), resolveOrganizationEntitlements: vi.fn() }));
vi.mock('@/server/audit', () => ({ annotateAudit: vi.fn(), ipFromHeaders: vi.fn(() => null), isAuditExcludedPath: vi.fn(() => false), recordTrpcAudit: vi.fn() }));
vi.mock('@/lib/pharmacy/prescription-files', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/prescription-files')>()),
  loadPrescriptionFile: vi.fn(async () => ({ id: 'file' })),
}));
vi.mock('@/lib/pharmacy/sales', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: vi.fn(async (_db, _scope, input) => ({ line: { id: 'line-1' }, input })),
}));

import { addSaleLine } from '@/lib/pharmacy/sales';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const base = {
  branchId: 'branch-1', saleId: 'sale-1', medicineId: 'medicine-1',
  presentationId: 'presentation-1', packLevelId: 'pack-1', saleUnit: 'UNIT' as const,
  quantity: 1, canonicalUnitsPerSaleUnit: 1, idempotencyKey: 'rx-line-1',
};

function caller(
  actorRules: Array<{ capability: string; effect: 'ALLOW' | 'DENY' }>,
  approverRules = actorRules,
  options: {
    actorAssigned?: boolean;
    approverAssigned?: boolean;
    counterGrant?: boolean;
    replayExisting?: boolean;
    serializeTransactions?: boolean;
  } = {}
) {
  const effectiveActorRules = [
    ...(options.counterGrant === false
      ? []
      : [{ capability: 'pharmacy:counter', effect: 'ALLOW' as const }]),
    ...actorRules,
  ];
  let transactionTail = Promise.resolve();
  const db = {
    $transaction: async (fn: (tx: unknown) => unknown) => {
      if (!options.serializeTransactions) return fn(db);
      const prior = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => (release = resolve));
      await prior;
      try {
        return await fn(db);
      } finally {
        release();
      }
    },
    $queryRaw: async () => [],
    pharmacyBranch: { findMany: async () => [{ id: 'branch-1' }] },
    pharmacySaleLine: {
      findFirst: async () =>
        options.replayExisting && vi.mocked(addSaleLine).mock.calls.length > 0
          ? { id: 'line-1', branchId: 'branch-1', saleId: 'sale-1' }
          : null,
    },
    medicine: { findFirst: async () => ({ id: 'medicine-1', rx: true, restricted: false, controlled: false }) },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        organizationRole: { permissions: where.id === 'pharmacist-1' ? approverRules : effectiveActorRules },
        permissionOverrides: [],
      }),
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === 'pharmacist-1'
          ? { id: 'pharmacist-1', organizationId: 'org-1', role: 'EMPLOYEE', status: 'ACTIVE' }
          : null,
    },
    pharmacyBranchAssignment: {
      findMany: async ({ where }: { where: { userId: string } }) => {
        const assigned =
          where.userId === 'pharmacist-1'
            ? options.approverAssigned !== false
            : options.actorAssigned !== false;
        return assigned ? [{ branchId: 'branch-1' }] : [];
      },
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: { expires: 'later', user: { id: 'cashier-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' } },
    organization: { id: 'org-1', vertical: 'PHARMACY' }, support: null,
    requestMeta: { ip: null, userAgent: null }, audit: { detail: {} },
  } as unknown as TRPCContext;
  return app.createCaller(context).pharmacySales;
}

beforeEach(() => vi.mocked(addSaleLine).mockClear());

describe('pharmacySales.addLine non-controlled Rx authorization', () => {
  it('rejects an actor without the counter sale capability', async () => {
    await expect(
      caller([], [], { counterGrant: false }).addLine({
        ...base,
        rxAuthorization: { prescriptionReference: 'RX-42' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('rejects an actor not assigned to the sale branch', async () => {
    await expect(
      caller([], [], { actorAssigned: false }).addLine({
        ...base,
        rxAuthorization: { prescriptionReference: 'RX-42' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('accepts path (a) only for the actor exact dispense grant', async () => {
    await caller([{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]).addLine(base);
    expect(addSaleLine).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ rxAuthorization: { path: 'ACTOR_GRANT' } }));
  });

  it('lets an explicit DENY beat an exact actor ALLOW', async () => {
    await expect(
      caller([
        { capability: 'pharmacy:dispense', effect: 'ALLOW' },
        { capability: 'pharmacy:dispense', effect: 'DENY' },
      ]).addLine(base)
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'RX_AUTHORIZATION_REQUIRED' });
  });

  it.each([
    ['reference', { prescriptionReference: 'RX-42' }, { path: 'PRESCRIPTION_REFERENCE', prescriptionReference: 'RX-42' }],
    ['photo', { prescriptionFileRef: '/api/pharmacy/prescription-files?id=123e4567-e89b-42d3-a456-426614174000' }, { path: 'PRESCRIPTION_PHOTO', prescriptionFileRef: '/api/pharmacy/prescription-files?id=123e4567-e89b-42d3-a456-426614174000' }],
  ])('accepts path (b) by %s', async (_label, rxAuthorization, resolved) => {
    await caller([]).addLine({ ...base, rxAuthorization });
    expect(addSaleLine).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ rxAuthorization: resolved }));
  });

  it('accepts path (c) with a same-branch pharmacist and non-empty reason', async () => {
    await caller([], [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]).addLine({
      ...base,
      rxAuthorization: { override: { approverUserId: 'pharmacist-1', reason: 'Prescription confirmed by phone' } },
    });
    expect(addSaleLine).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      rxAuthorization: { path: 'PHARMACIST_OVERRIDE', approverUserId: 'pharmacist-1', reason: 'Prescription confirmed by phone' },
    }));
  });

  it('rejects an override approver who is not assigned to the sale branch', async () => {
    await expect(
      caller([], [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }], {
        approverAssigned: false,
      }).addLine({
        ...base,
        rxAuthorization: {
          override: { approverUserId: 'pharmacist-1', reason: 'Asked pharmacist' },
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('rejects an override approver with only a wildcard grant', async () => {
    await expect(
      caller([], [{ capability: 'pharmacy:*', effect: 'ALLOW' }]).addLine({
        ...base,
        rxAuthorization: {
          override: { approverUserId: 'pharmacist-1', reason: 'Asked pharmacist' },
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'RX_AUTHORIZATION_REQUIRED' });
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('returns one line for a retry with the same idempotency key', async () => {
    const api = caller([], [], { replayExisting: true });
    const input = { ...base, rxAuthorization: { prescriptionReference: 'RX-42' } };
    const first = await api.addLine(input);
    const retry = await api.addLine(input);
    expect('line' in first && first.line.id).toBe('line-1');
    expect('line' in retry && retry.line.id).toBe('line-1');
    // addSaleLine owns both the line insert and RX_AUTHORIZED audit insert, so
    // bypassing it on replay means neither row can be duplicated.
    expect(addSaleLine).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent duplicate submits to one line insertion', async () => {
    const api = caller([], [], { replayExisting: true, serializeTransactions: true });
    const input = { ...base, rxAuthorization: { prescriptionReference: 'RX-42' } };
    const [first, duplicate] = await Promise.all([api.addLine(input), api.addLine(input)]);
    expect('line' in first && first.line.id).toBe('line-1');
    expect('line' in duplicate && duplicate.line.id).toBe('line-1');
    expect(addSaleLine).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['approver lacks the grant', [], [{ capability: 'pharmacy:orders', effect: 'ALLOW' }], { override: { approverUserId: 'pharmacist-1', reason: 'Asked pharmacist' } }],
    ['actor has only a wildcard grant', [{ capability: 'pharmacy:*', effect: 'ALLOW' }], [], undefined],
    ['no evidence is supplied', [], [], undefined],
  ])('rejects when %s', async (_label, actorRules, approverRules, rxAuthorization) => {
    await expect(caller(actorRules, approverRules).addLine({ ...base, rxAuthorization })).rejects.toMatchObject({
      code: 'FORBIDDEN', message: 'RX_AUTHORIZATION_REQUIRED',
    });
    expect(addSaleLine).not.toHaveBeenCalled();
  });
});
