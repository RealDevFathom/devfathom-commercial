import { describe, expect, it, vi } from 'vitest';
import { authorizeControlledRestoration } from './controlled-restoration-authorization';
import { changeSaleStatus, returnSaleLine } from './sales';
import { can } from '@/lib/abac';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
// DEV-879: these fixtures model an approver with no approval authenticator, so the PIN is
// checked exactly as before. approval-authenticator.test.ts covers the authenticator path.
vi.mock('@/lib/approval-authenticator', async () => {
  const { verifyOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  return {
    verifyApprovalSecret: async (
      _db: unknown,
      input: { secret: string; credentialHash: string }
    ) =>
      (await verifyOperatorCredential('PIN', input.secret, input.credentialHash)) ? 'PIN' : null,
  };
});
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));
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
    pharmacyBranchAssignment: {
      findFirst: vi.fn().mockResolvedValue({ branchId: scope.branchId }),
    },
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'actor', role: 'EMPLOYEE' }) },
    restaurantOperatorCredential: {
      findFirst: vi.fn().mockResolvedValue({
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
    pharmacyStockMovement: { create: vi.fn() },
  };
  vi.mocked(withTenantDb).mockImplementation(async (_organizationId, run) => run(db as never));
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
          ? changeSaleStatus(db as never, scope, 'sale', 'void', {
              kind: 'COUNTER',
              actorIsManager: true,
            })
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
    expect(withTenantDb).toHaveBeenCalledWith('org', expect.any(Function), {
      userId: 'actor',
      skipDrain: true,
    });
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

describe('controlled returns at a branch allowing solo confirmation', () => {
  it('accepts the acting pharmacist’s verified credential for a counter correction only', async () => {
    const { controlledSaleRestorationWitness } = await import('./sales');
    const { db, witness } = fixture();
    witness.id = scope.actorId;
    db.$queryRaw.mockResolvedValue([{ requireSecondPharmacist: false }]);
    const approval = await controlledSaleRestorationWitness(db as never, scope, {
      ...pin,
      selfApproval: true,
    });
    expect(approval).toMatchObject({
      witnessedByUserId: scope.actorId,
      counterSelfApproval: 'PIN',
    });
    expect(verifyOperatorCredential).toHaveBeenCalledWith('PIN', pin.pin, 'hash');
  });
});
