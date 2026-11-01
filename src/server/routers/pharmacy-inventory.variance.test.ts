import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ solo: vi.fn(), pin: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/lib/abac', async (original) => ({
  ...(await original<typeof import('@/lib/abac')>()),
  can: vi.fn(async () => true),
}));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  isAuditExcludedPath: () => true,
}));
vi.mock('@/lib/pharmacy/solo-approval', () => ({
  authorizeSoloApproval: mocks.solo,
  verifyPharmacyUserPin: mocks.pin,
}));
import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

function fixture(mode: 'SOLO' | 'STAFFED') {
  const db = {
    $queryRaw: vi.fn(async (query) => {
      const sql = query.strings?.join('') ?? query.sql ?? '';
      if (sql.includes('pharmacy_interbranch_transfers')) return [{ id: 'transfer' }];
      if (sql.includes('pharmacy_stock_balances'))
        return [{ onHandUnits: 1, sealedPacks: 0, looseUnits: 1, unitsPerPack: 1 }];
      return [];
    }),
    organization: { findFirstOrThrow: vi.fn(async () => ({ pharmacyOperatingMode: mode })) },
    pharmacyBranch: { findMany: vi.fn(async () => [{ id: 'destination' }]) },
    user: {
      findFirst: vi.fn(async () => ({ id: 'checker', organizationRole: { key: 'manager' } })),
    },
    auditLog: { create: vi.fn() },
    pharmacyInterbranchTransfer: {
      findFirst: vi.fn(async () => ({
        id: 'transfer',
        status: 'DISPATCHED',
        fromBranchId: 'source',
        lines: [
          {
            id: 'line',
            quantityUnits: 1,
            receivedUnits: 0,
            sourceLotId: 'lot',
            sourceStockLocationId: 'rack',
          },
        ],
      })),
      update: vi.fn(async ({ data }) => data),
    },
    pharmacyStockMovement: { create: vi.fn(async ({ data }) => ({ id: 'movement', ...data })) },
    pharmacyCustodyRecord: { create: vi.fn(async ({ data }) => data) },
    $transaction: (run: (db: unknown) => unknown) => run(db),
  };
  const api = pharmacyInventoryRouter.createCaller({
    db,
    session: { user: { id: 'maker', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org' } },
    entitlements: { organizationId: 'org', enabledModules: ['pharmacy-inventory'] },
    audit: { detail: {} },
    requestMeta: { ip: null, userAgent: null },
  } as unknown as TRPCContext);
  const call = (witnessId: string, pin: string | undefined = '4729') =>
    api.receiveTransferWithVariance({
      branchId: 'destination',
      transferId: 'transfer',
      lines: [{ lineId: 'line', receivedUnits: 0 }],
      variance: { witnessId, pin, reason: 'Lost', evidenceRef: 'receipt' },
      idempotencyKeyPrefix: 'receipt-key',
    });
  return { db, call };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pin.mockImplementation(async (_scope, pin) => pin === '4729');
  mocks.solo.mockImplementation(async (db, scope, target, pin) => {
    if (pin !== '4729') return false;
    await db.auditLog.create({
      data: { actorId: scope.actorId, targetId: target.id, action: 'PHARMACY:SOLO_OWNER_PIN' },
    });
    return true;
  });
});
describe.each(['SOLO', 'STAFFED'] as const)('transfer variance %s custody', (mode) => {
  it('persists the authenticated approver and binds audit to custody', async () => {
    const { db, call } = fixture(mode);
    const witnessId = mode === 'SOLO' ? 'maker' : 'checker';
    const result = await call(witnessId);
    expect(result.variances[0].custody.witnessId).toBe(witnessId);
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: witnessId,
        targetId: result.variances[0].custody.id,
      }),
    });
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain('4729');
  });
  it('rejects inactive or foreign witnesses before posting', async () => {
    const { db, call } = fixture(mode);
    db.user.findFirst.mockResolvedValue(null as never);
    await expect(call('inactive')).rejects.toMatchObject({ message: 'COAUTH_REQUIRED' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });
  it('rejects mismatched witness credentials before posting', async () => {
    const { db, call } = fixture(mode);
    mocks.pin.mockResolvedValue(false);
    await expect(call('different-checker')).rejects.toMatchObject({ message: 'COAUTH_REQUIRED' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });
  it('requires fresh PIN evidence', async () => {
    const { db, call } = fixture(mode);
    await expect(call(mode === 'SOLO' ? 'maker' : 'checker', '0000')).rejects.toMatchObject({
      message: 'COAUTH_REQUIRED',
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});
