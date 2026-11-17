import { beforeEach, describe, expect, it, vi } from 'vitest';
import { can } from '@/lib/abac';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { reverseGoodsReceipt } from './goods-receipt';
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
const finance = vi.hoisted(() => ({
  postGoodsReceiptEntry: vi.fn(),
  reversePostingForSource: vi.fn(),
}));
vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  ...finance,
}));

vi.mock('@/lib/restaurant/operator-credentials', () => ({
  verifyOperatorCredential: vi.fn(),
  isLockedOut: () => false,
  clearLockout: () => ({}),
  registerFailedAttempt: () => ({ failedAttempts: 1 }),
}));

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'original-witness' };
/** Another member as `isSolePharmacist` reads them: their grants, no `can()` call. */
function member(id: string, capability: string, effect: 'ALLOW' | 'DENY' = 'ALLOW') {
  return {
    id,
    organizationRole: { permissions: [{ capability, effect }] },
    permissionOverrides: [],
  };
}
const input = {
  goodsReceiptId: 'receipt',
  reason: 'Wrong consignment',
  at: new Date(),
  controlledWitness: { staffProfileId: 'staff', pin: '1234' },
};

function shelfBalance(onHandUnits: number, sealedPacks: number, looseUnits: number) {
  return {
    inventoryLotId: 'lot',
    stockLocationId: 'shelf',
    disposition: 'AVAILABLE',
    onHandUnits,
    sealedPacks,
    looseUnits,
  };
}

function fixture() {
  const purchase = {
    id: 'purchase',
    medicineId: 'medicine',
    inventoryLotId: 'lot',
    stockMovementId: 'receipt-movement',
    quantityCanonicalUnits: 2,
    batchNumber: 'batch',
    witnessedByUserId: scope.actorId,
    signatureRef: 'pin:historical',
  };
  const db = {
    $queryRaw: vi.fn(),
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: scope.actorId, status: 'ACTIVE' }),
      // Another pharmacist exists unless a test makes the branch solo.
      findMany: vi.fn().mockResolvedValue([member('second-pharmacist', 'pharmacy:dispense')]),
    },
    auditLog: { create: vi.fn() },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch' }) },
    pharmacyBranchAssignment: { findMany: vi.fn().mockResolvedValue([{ branchId: 'branch' }]) },
    restaurantOperatorCredential: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'credential',
        credentialHash: 'hash',
        staffProfile: {
          status: 'ACTIVE',
          user: { id: 'fresh-witness', organizationId: 'org', status: 'ACTIVE' },
        },
      }),
      update: vi.fn(),
    },
    pharmacyGoodsReceipt: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'receipt',
        branchId: 'branch',
        status: 'POSTED',
        lines: [{ id: 'line' }],
      }),
      update: vi.fn(),
    },
    pharmacyControlledRegisterEntry: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.inventoryLotId ? { runningBalance: 2 } : purchase
        ),
      findMany: vi.fn().mockResolvedValue([purchase]),
      aggregate: vi.fn().mockResolvedValue({ _max: { serial: 1 } }),
      create: vi.fn(),
    },
    pharmacyStockMovement: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'receipt-movement',
          inventoryLotId: 'lot',
          stockLocationId: 'shelf',
          disposition: 'AVAILABLE',
          quantityUnits: 2,
          sealedPackDelta: 2,
          looseUnitDelta: 0,
        },
      ]),
      findFirst: vi.fn().mockImplementation(async ({ where }) =>
        where.reversesMovementId
          ? { id: 'reversal', quantityUnits: -2 }
          : {
              id: 'receipt-movement',
              inventoryLotId: 'lot',
              quantityUnits: 2,
              sealedPackDelta: 2,
              looseUnitDelta: 0,
            }
      ),
      create: vi.fn().mockResolvedValue({ id: 'reversal' }),
    },
    pharmacyStockBalance: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { onHandUnits: 0 } }),
      findMany: vi.fn().mockResolvedValue([shelfBalance(2, 2, 0)]),
    },
  };
  vi.mocked(withTenantDb).mockImplementation(async (_organizationId, run) => run(db as never));
  return {
    db,
    run: (request: Parameters<typeof reverseGoodsReceipt>[2] = input) =>
      reverseGoodsReceipt(db as unknown as ScopedDb, scope, request),
  };
}

describe('controlled goods receipt reversal authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(can).mockReset().mockResolvedValue(true);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
  });

  it('lets the original witness reverse with a different fresh witness', async () => {
    const { db, run } = fixture();
    await expect(run()).resolves.toMatchObject({ reversalMovementIds: ['reversal'] });
    expect(can).toHaveBeenCalledWith(
      expect.objectContaining({ id: scope.actorId }),
      'pharmacy:safety',
      undefined,
      expect.anything()
    );
    expect(db.pharmacyControlledRegisterEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correctsEntryId: 'purchase',
        restorationMovementId: 'reversal',
        quantityCanonicalUnits: 0,
        balanceDelta: -2,
        runningBalance: 0,
        recordedByUserId: scope.actorId,
        witnessedByUserId: 'fresh-witness',
        signatureRef: expect.stringMatching(/^pin:credential:/),
      }),
    });
  });

  it.each(['permission', 'branch', 'missing PIN', 'wrong PIN', 'self witness'])(
    'rejects %s before stock, register or receipt writes',
    async (failure) => {
      const { db, run } = fixture();
      if (failure === 'permission') vi.mocked(can).mockResolvedValue(false);
      if (failure === 'branch') db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
      if (failure === 'wrong PIN') vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
      if (failure === 'self witness') {
        const credential = await db.restaurantOperatorCredential.findFirst();
        credential.staffProfile.user.id = scope.actorId;
      }
      await expect(
        run(failure === 'missing PIN' ? { ...input, controlledWitness: undefined } : input)
      ).rejects.toThrow();
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyControlledRegisterEntry.create).not.toHaveBeenCalled();
      expect(db.pharmacyGoodsReceipt.update).not.toHaveBeenCalled();
      if (failure === 'wrong PIN')
        expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
          where: { id: 'credential' },
          data: { failedAttempts: 1 },
        });
    }
  );

  it('reverses the receipt journal entry with the stock (DEV-131)', async () => {
    finance.reversePostingForSource.mockReset().mockResolvedValue({ id: 'reversal-entry' });
    const { db, run } = fixture();
    await run();
    expect(finance.reversePostingForSource).toHaveBeenCalledWith(db, scope, {
      sourceKind: 'PHARMACY_GOODS_RECEIPT',
      sourceId: 'receipt',
      reason: input.reason,
      at: input.at,
    });
  });

  it('reverses a receipt that never journalled anything', async () => {
    const { PharmacyFinanceError } =
      await vi.importActual<typeof import('./finance-postings')>('./finance-postings');
    finance.reversePostingForSource
      .mockReset()
      .mockRejectedValue(new PharmacyFinanceError('NOT_FOUND'));
    const { run } = fixture();
    await expect(run()).resolves.toMatchObject({ reversalMovementIds: ['reversal'] });
  });

  it('keeps ordinary receipt reversal available without a witness', async () => {
    const { db, run } = fixture();
    db.pharmacyControlledRegisterEntry.findFirst.mockResolvedValue(null as never);
    db.pharmacyControlledRegisterEntry.findMany.mockResolvedValue([]);
    await expect(run({ ...input, controlledWitness: undefined })).resolves.toMatchObject({
      reversalMovementIds: ['reversal'],
    });
    expect(db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });

  it('locks the branch register before the first compensating stock movement', async () => {
    const { db, run } = fixture();
    await run();
    const lockIndex = db.$queryRaw.mock.calls.findIndex(([sql]) =>
      String(sql).includes('pg_advisory_xact_lock')
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(db.$queryRaw.mock.calls[lockIndex]!.slice(1)).toEqual(['org:branch']);
    expect(db.$queryRaw.mock.invocationCallOrder[lockIndex]).toBeLessThan(
      db.pharmacyStockMovement.create.mock.invocationCallOrder[0]!
    );
  });

  it('reverses two posted lines that landed on the same controlled lot', async () => {
    const { db, run } = fixture();
    const base = {
      medicineId: 'medicine',
      inventoryLotId: 'lot',
      batchNumber: 'batch',
      witnessedByUserId: scope.actorId,
      signatureRef: 'pin:historical',
    };
    const purchases = [
      { ...base, id: 'p1', stockMovementId: 'm1', quantityCanonicalUnits: 2 },
      { ...base, id: 'p2', stockMovementId: 'm2', quantityCanonicalUnits: 3 },
    ];
    const originals: Record<string, number> = { m1: 2, m2: 3 };
    let onHand = 5;
    let running = 5;
    const reversed: Record<string, number> = {};
    const posted = (id: string, units: number) => ({
      id,
      inventoryLotId: 'lot',
      stockLocationId: 'shelf',
      disposition: 'AVAILABLE',
      quantityUnits: units,
      sealedPackDelta: units,
      looseUnitDelta: 0,
    });
    db.pharmacyStockMovement.findMany.mockResolvedValue([posted('m1', 2), posted('m2', 3)]);
    db.pharmacyStockBalance.findMany.mockResolvedValue([shelfBalance(5, 5, 0)]);
    db.pharmacyStockMovement.findFirst.mockImplementation(async ({ where }) =>
      where.reversesMovementId
        ? reversed[where.reversesMovementId] === undefined
          ? null
          : {
              id: `${where.reversesMovementId}:rev`,
              quantityUnits: reversed[where.reversesMovementId],
            }
        : {
            id: where.id,
            inventoryLotId: 'lot',
            quantityUnits: originals[where.id],
            sealedPackDelta: originals[where.id],
            looseUnitDelta: 0,
          }
    );
    db.pharmacyStockMovement.create.mockImplementation(async ({ data }) => {
      reversed[data.reversesMovementId] = data.quantityUnits;
      onHand += data.quantityUnits;
      return { id: `${data.reversesMovementId}:rev` };
    });
    db.pharmacyStockBalance.aggregate.mockImplementation(async () => ({
      _sum: { onHandUnits: onHand },
    }));
    db.pharmacyControlledRegisterEntry.findMany.mockImplementation(async ({ where }) =>
      purchases.filter((entry) => where.stockMovementId.in.includes(entry.stockMovementId))
    );
    db.pharmacyControlledRegisterEntry.findFirst.mockImplementation(async ({ where }) =>
      where.inventoryLotId ? { runningBalance: running } : purchases[0]
    );
    db.pharmacyControlledRegisterEntry.create.mockImplementation(async ({ data }) => {
      running = data.runningBalance;
      return { id: 'row' };
    });

    await expect(run()).resolves.toMatchObject({ reversalMovementIds: ['m1:rev', 'm2:rev'] });
    expect(db.pharmacyControlledRegisterEntry.create).toHaveBeenCalledTimes(2);
    expect(db.pharmacyControlledRegisterEntry.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ correctsEntryId: 'p1', balanceDelta: -2, runningBalance: 3 }),
    });
    expect(db.pharmacyControlledRegisterEntry.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ correctsEntryId: 'p2', balanceDelta: -3, runningBalance: 0 }),
    });
  });

  describe('solo pharmacy', () => {
    function soloFixture() {
      const f = fixture();
      f.db.user.findMany.mockResolvedValue([]);
      f.db.restaurantOperatorCredential.findFirst.mockResolvedValue({
        id: 'own-credential',
        credentialHash: 'hash',
        staffProfile: {
          status: 'ACTIVE',
          user: { id: scope.actorId, organizationId: 'org', status: 'ACTIVE' },
        },
      });
      return f;
    }

    it('lets the sole pharmacist self-witness with a fresh PIN and audits it', async () => {
      const { db, run } = soloFixture();
      await expect(run()).resolves.toMatchObject({ reversalMovementIds: ['reversal'] });
      expect(verifyOperatorCredential).toHaveBeenCalledWith('PIN', '1234', 'hash');
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org',
            id: { not: scope.actorId },
            status: { in: ['ACTIVE', 'ON_LEAVE'] },
          },
        })
      );
      expect(db.pharmacyControlledRegisterEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          correctsEntryId: 'purchase',
          restorationMovementId: 'reversal',
          recordedByUserId: scope.actorId,
          witnessedByUserId: scope.actorId,
          signatureRef: expect.stringMatching(/^solo-pin:own-credential:/),
        }),
      });
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: 'org',
          actorId: scope.actorId,
          action: 'pharmacy.controlledReceiptReversalSelfWitness',
          targetType: 'PharmacyGoodsReceipt',
          targetId: 'receipt',
          metadata: expect.objectContaining({
            policy: 'PHARMACY_SOLO_PHARMACIST_PIN',
            pinVerified: true,
          }),
        }),
      });
      expect(db.auditLog.create.mock.invocationCallOrder[0]).toBeLessThan(
        db.pharmacyStockMovement.create.mock.invocationCallOrder[0]!
      );
    });

    it('refuses a self-witness while another pharmacist could witness', async () => {
      const { db, run } = soloFixture();
      db.user.findMany.mockResolvedValue([member('second-pharmacist', 'pharmacy:dispense')]);
      await expect(run()).rejects.toThrow(/different pharmacist/);
      expect(verifyOperatorCredential).not.toHaveBeenCalled();
      expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyControlledRegisterEntry.create).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });

    it('counts an exact dispensing grant held as a personal override', async () => {
      const { db, run } = soloFixture();
      db.user.findMany.mockResolvedValue([
        {
          id: 'second-pharmacist',
          organizationRole: null,
          permissionOverrides: [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
        },
      ]);
      await expect(run()).rejects.toThrow(/different pharmacist/);
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            permissionOverrides: expect.objectContaining({
              where: { OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] },
            }),
          }),
        })
      );
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    });

    it('matches ABAC: wildcard holders cannot dispense, so they are not a second pharmacist', async () => {
      const { db, run } = soloFixture();
      // `pharmacy:dispense` is exact-grant-only; `*` and `pharmacy:*` never grant it.
      db.user.findMany.mockResolvedValue([member('admin', '*'), member('manager', 'pharmacy:*')]);
      await expect(run()).resolves.toMatchObject({ reversalMovementIds: ['reversal'] });
    });

    it('counts a pharmacist who has no PIN yet without asking can()', async () => {
      const { db, run } = soloFixture();
      // Grants decide, not credentials, and no per-member `can()` lookup runs.
      db.user.findMany.mockResolvedValue([member('pharmacist-without-pin', 'pharmacy:dispense')]);
      await expect(run()).rejects.toThrow(/different pharmacist/);
      expect(can).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pharmacist-without-pin' }),
        expect.anything(),
        undefined,
        expect.anything()
      );
    });

    it('fails closed when the member lookup errors', async () => {
      const { db, run } = soloFixture();
      db.user.findMany.mockRejectedValue(new Error('lookup failed'));
      await expect(run()).rejects.toThrow('lookup failed');
      expect(verifyOperatorCredential).not.toHaveBeenCalled();
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyControlledRegisterEntry.create).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });

    it('treats non-dispensing staff and DENY-only members as no witness', async () => {
      const { db, run } = soloFixture();
      db.user.findMany.mockResolvedValue([
        member('cashier', 'pharmacy.counter'),
        member('blocked', 'pharmacy:dispense', 'DENY'),
      ]);
      await expect(run()).resolves.toMatchObject({ reversalMovementIds: ['reversal'] });
      expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('refuses a sole user who cannot dispense', async () => {
      const { db, run } = soloFixture();
      vi.mocked(can).mockImplementation(async (_subject, action) => action !== 'pharmacy:dispense');
      await expect(run()).rejects.toThrow(/different pharmacist/);
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });

    it('records a wrong solo PIN as a failed attempt and writes nothing', async () => {
      const { db, run } = soloFixture();
      vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
      // The sole pharmacist is told their PIN was refused, not to find someone else.
      await expect(run()).rejects.toThrow(/Your PIN was not accepted/);
      expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
        where: { id: 'own-credential' },
        data: { failedAttempts: 1 },
      });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyControlledRegisterEntry.create).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });
  });

  it('reports stock that moved on since posting as a domain error', async () => {
    const { db, run } = fixture();
    db.pharmacyStockBalance.aggregate.mockResolvedValue({ _sum: { onHandUnits: 1 } });
    await expect(run()).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
    expect(db.pharmacyControlledRegisterEntry.create).not.toHaveBeenCalled();
  });
});

describe('DEV-610: reversing a receipt whose stock has moved on', () => {
  beforeEach(() => {
    vi.mocked(can).mockResolvedValue(true);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
  });

  function expectNothingWritten(db: ReturnType<typeof fixture>['db']) {
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyControlledRegisterEntry.create).not.toHaveBeenCalled();
    expect(db.pharmacyGoodsReceipt.update).not.toHaveBeenCalled();
  }

  function ordinary() {
    const harness = fixture();
    harness.db.pharmacyControlledRegisterEntry.findFirst.mockResolvedValue(null as never);
    return harness;
  }

  it('refuses with REVERSAL_STOCK_MOVED once received units were sold or transferred', async () => {
    const { db, run } = ordinary();
    db.pharmacyStockBalance.findMany.mockResolvedValue([shelfBalance(1, 0, 1)]);
    await expect(run({ ...input, controlledWitness: undefined })).rejects.toMatchObject({
      reason: 'REVERSAL_STOCK_MOVED',
    });
    expectNothingWritten(db);
  });

  it('refuses with REVERSAL_STOCK_MOVED when the receiving location holds nothing', async () => {
    const { db, run } = ordinary();
    db.pharmacyStockBalance.findMany.mockResolvedValue([]);
    await expect(run({ ...input, controlledWitness: undefined })).rejects.toMatchObject({
      reason: 'REVERSAL_STOCK_MOVED',
    });
    expectNothingWritten(db);
  });

  it('refuses with REVERSAL_PACKS_OPENED when the units remain only as loose units', async () => {
    const { db, run } = ordinary();
    db.pharmacyStockBalance.findMany.mockResolvedValue([shelfBalance(2, 0, 2)]);
    await expect(run({ ...input, controlledWitness: undefined })).rejects.toMatchObject({
      reason: 'REVERSAL_PACKS_OPENED',
    });
    expectNothingWritten(db);
  });

  it('adds up every posted line that landed in the same lot and location', async () => {
    const { db, run } = ordinary();
    const line = {
      inventoryLotId: 'lot',
      stockLocationId: 'shelf',
      disposition: 'AVAILABLE',
      quantityUnits: 2,
      sealedPackDelta: 2,
      looseUnitDelta: 0,
    };
    // Each line alone (2) fits the shelf (3); together (4) they do not.
    db.pharmacyStockMovement.findMany.mockResolvedValue([
      { ...line, id: 'm1' },
      { ...line, id: 'm2' },
    ]);
    db.pharmacyStockBalance.findMany.mockResolvedValue([shelfBalance(3, 3, 0)]);
    await expect(run({ ...input, controlledWitness: undefined })).rejects.toMatchObject({
      reason: 'REVERSAL_STOCK_MOVED',
    });
    expectNothingWritten(db);
  });

  it('refuses a controlled receipt the same way, after the register lock', async () => {
    const { db, run } = fixture();
    db.pharmacyStockBalance.findMany.mockResolvedValue([shelfBalance(0, 0, 0)]);
    await expect(run()).rejects.toMatchObject({ reason: 'REVERSAL_STOCK_MOVED' });
    expectNothingWritten(db);
    const sql = db.$queryRaw.mock.calls.map(([strings]) =>
      Array.isArray(strings) ? String(strings) : (strings as { strings: string[] }).strings.join('')
    );
    const registerLock = sql.findIndex((text) => text.includes('pg_advisory_xact_lock'));
    const balanceLock = sql.findIndex((text) => text.includes('pharmacy_stock_balances'));
    expect(registerLock).toBeGreaterThanOrEqual(0);
    expect(balanceLock).toBeGreaterThan(registerLock);
  });

  it('locks the balance row before reading it', async () => {
    const { db, run } = fixture();
    await run();
    const balanceLock = db.$queryRaw.mock.calls.findIndex(([sql]) =>
      (sql as { strings: string[] }).strings?.join('').includes('pharmacy_stock_balances')
    );
    expect(balanceLock).toBeGreaterThanOrEqual(0);
    // DEV-825: one statement through the shared lock helper, keys in global order.
    const lock = db.$queryRaw.mock.calls[balanceLock]![0] as {
      strings: string[];
      values: unknown[];
    };
    expect(lock.strings.join('')).toContain('FOR UPDATE');
    expect(lock.values).toEqual(['org', 'branch', 'lot', 'shelf', 'AVAILABLE']);
    expect(db.$queryRaw.mock.invocationCallOrder[balanceLock]).toBeLessThan(
      db.pharmacyStockBalance.findMany.mock.invocationCallOrder[0]!
    );
  });
});
