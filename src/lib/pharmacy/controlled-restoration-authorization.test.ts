import { describe, expect, it, vi } from 'vitest';
import { authorizeControlledRestoration } from './controlled-restoration-authorization';
import { changeSaleStatus, returnSaleLine } from './sales';
import { can } from '@/lib/abac';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
vi.mock('@/lib/abac', () => ({ can: vi.fn() }));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  verifyOperatorCredential: vi.fn(),
  isLockedOut: () => false,
  clearLockout: () => ({}),
  registerFailedAttempt: () => ({ failedAttempts: 1 }),
}));
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
function fixture() {
  vi.mocked(can).mockResolvedValue(true);
  vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
  const witness = { id: 'new-witness', organizationId: 'org', status: 'ACTIVE', role: 'EMPLOYEE' };
  const db = {
    $queryRaw: vi.fn(),
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'actor', role: 'EMPLOYEE' }) },
    restaurantOperatorCredential: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          id: 'cred',
          credentialHash: 'hash',
          staffProfile: { status: 'ACTIVE', user: witness },
        }),
      update: vi.fn(),
    },
    pharmacySale: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ status: 'OPEN', lines: [{ medicine: { controlled: true } }] }),
      updateMany: vi.fn(),
    },
    pharmacySaleLine: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ sale: { status: 'COMPLETED' }, medicine: { controlled: true } }),
    },
    pharmacySaleEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyStockMovement: { create: vi.fn() },
  };
  return { db, witness };
}
const pin = { staffProfileId: 'staff', pin: '1234' };
describe('fresh controlled restoration authorization', () => {
  it('denies a cashier before reading the witness credential', async () => {
    const { db } = fixture();
    vi.mocked(can).mockResolvedValue(false);
    await expect(authorizeControlledRestoration(db as never, scope, pin)).rejects.toMatchObject({
      forbidden: true,
    });
    expect(db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });
  it.each(['void', 'return'])(
    'blocks direct controlled %s without fresh PIN before writes',
    async (action) => {
      const { db } = fixture();
      const work =
        action === 'void'
          ? changeSaleStatus(db as never, scope, 'sale', 'void')
          : returnSaleLine(db as never, scope, {
              saleLineId: 'line',
              canonicalUnits: 1,
              reason: 'return',
              integrityDecision: 'sealed',
              idempotencyKey: 'key',
            });
      await expect(work).rejects.toThrow(/fresh witness PIN/);
      expect(db.pharmacySale.updateMany).not.toHaveBeenCalled();
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    }
  );
  it('rejects a wrong PIN and records a failed attempt', async () => {
    const { db } = fixture();
    vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
    await expect(authorizeControlledRestoration(db as never, scope, pin)).rejects.toThrow(
      /fresh witness PIN/
    );
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: { failedAttempts: 1 },
    });
  });
  it('reconciles a completed controlled return without retaining or rechecking its PIN', async () => {
    const { db } = fixture();
    const input = {
      saleLineId: 'line',
      canonicalUnits: 1,
      reason: 'return',
      integrityDecision: 'sealed',
      idempotencyKey: 'key',
    };
    db.pharmacySaleLine.findFirst.mockResolvedValue({
      id: 'line',
      saleId: 'sale',
      sale: { status: 'COMPLETED' },
      medicine: { controlled: true },
    });
    db.pharmacySaleEvent.findFirst.mockResolvedValue({
      payload: {
        fingerprint: JSON.stringify({ ...input, disposition: 'QUARANTINE' }),
        returnId: 'return',
      },
    });
    Object.assign(db, {
      pharmacySaleReturn: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'return',
          lines: [{ stockMovementId: 'movement' }],
          unidentifiedHolds: [],
        }),
      },
    });
    Object.assign(db.pharmacyStockMovement, {
      findFirst: vi.fn().mockResolvedValue({ id: 'movement' }),
    });

    await expect(returnSaleLine(db as never, scope, input)).resolves.toMatchObject({
      returnId: 'return',
      replayed: true,
    });
    expect(db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });
  it('rejects self-witnessing and a witness denied by ABAC', async () => {
    const { db, witness } = fixture();
    witness.id = 'actor';
    await expect(authorizeControlledRestoration(db as never, scope, pin)).rejects.toThrow(
      /fresh witness PIN/
    );
    witness.id = 'witness';
    vi.mocked(can).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(authorizeControlledRestoration(db as never, scope, pin)).rejects.toThrow(
      /fresh witness PIN/
    );
  });
  it('uses the new witness and a unique verification reference each time', async () => {
    const { db } = fixture();
    const first = await authorizeControlledRestoration(db as never, scope, pin);
    const second = await authorizeControlledRestoration(db as never, scope, pin);
    expect(first.witnessedByUserId).toBe('new-witness');
    expect(first.signatureRef).not.toBe(second.signatureRef);
    expect(verifyOperatorCredential).toHaveBeenCalledWith('PIN', '1234', 'hash');
  });
});
