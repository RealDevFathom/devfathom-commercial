import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeOff } from './inventory-operations';

const mocks = vi.hoisted(() => ({ solo: vi.fn(), verify: vi.fn() }));
vi.mock('./solo-approval', () => ({
  authorizeSoloApproval: mocks.solo,
  verifyPharmacyUserPin: mocks.verify,
}));
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'maker' };
const input = {
  inventoryLotId: 'lot',
  stockLocationId: 'rack',
  units: 1,
  witnessId: 'checker',
  pin: '4729',
  reason: 'Damaged',
  evidenceRef: 'certificate',
  idempotencyKey: 'writeoff',
};
function fixture(mode = 'STAFFED', role = 'manager') {
  return {
    $queryRaw: vi.fn(async () => []),
    organization: { findFirstOrThrow: vi.fn(async () => ({ pharmacyOperatingMode: mode })) },
    user: { findFirst: vi.fn(async () => ({ organizationRole: { key: role } })) },
    auditLog: { create: vi.fn() },
    pharmacyInventoryLot: { findFirst: vi.fn(async () => ({ unitsPerPack: 1 })) },
    pharmacyStockBalance: { findFirst: vi.fn(async () => ({ onHandUnits: 1, looseUnits: 1 })) },
    pharmacyStockMovement: { create: vi.fn(async ({ data }) => ({ id: 'movement', ...data })) },
    pharmacyCustodyRecord: { create: vi.fn(async ({ data }) => data) },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockImplementation(async (_scope, pin) => pin === '4729');
  mocks.solo.mockImplementation(async (db, scope, target, pin) => {
    if (pin !== '4729') return false;
    await db.auditLog.create({
      data: { actorId: scope.actorId, action: 'PHARMACY:SOLO_OWNER_PIN', targetId: target.id },
    });
    return true;
  });
});
describe('write-off operating-mode integration', () => {
  it('reauthenticates the independent STAFFED witness and binds the audit to custody', async () => {
    const db = fixture();
    const result = await writeOff(db as never, scope, input);
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'checker',
          organizationId: 'org',
          status: 'ACTIVE',
        },
      })
    );
    expect(mocks.verify).toHaveBeenCalledWith({ ...scope, actorId: 'checker' }, '4729');
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'checker',
        action: 'PHARMACY:STAFFED:ADJUSTMENT',
        targetId: result.custody.id,
      }),
    });
    expect(result.custody).toMatchObject({
      actorId: 'maker',
      witnessId: 'checker',
      movementId: 'movement',
    });
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain(input.pin);
  });
  it.each(['missing', 'wrong', 'self', 'cashier', 'inactive'] as const)(
    'refuses %s witness evidence before moving stock',
    async (scenario) => {
      const db = fixture('STAFFED', scenario === 'cashier' ? 'cashier' : 'manager');
      if (scenario === 'inactive') db.user.findFirst.mockResolvedValue(null as never);
      await expect(
        writeOff(db as never, scope, {
          ...input,
          witnessId: scenario === 'self' ? scope.actorId : input.witnessId,
          pin: scenario === 'missing' ? undefined : scenario === 'wrong' ? '0000' : input.pin,
        })
      ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    }
  );
  it('preserves the SOLO owner fresh PIN path and audit target', async () => {
    const db = fixture('SOLO');
    for (const pin of [undefined, '0000'])
      await expect(writeOff(db as never, scope, { ...input, pin })).rejects.toMatchObject({
        reason: 'COAUTH_REQUIRED',
      });
    const result = await writeOff(db as never, scope, { ...input, witnessId: scope.actorId });
    expect(mocks.solo).toHaveBeenLastCalledWith(
      db,
      scope,
      { type: 'PharmacyCustodyRecord', id: result.custody.id },
      input.pin
    );
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PHARMACY:SOLO_OWNER_PIN',
        targetId: result.custody.id,
      }),
    });
  });
});
