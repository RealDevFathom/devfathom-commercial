import { describe, expect, it, vi } from 'vitest';

import {
  addSaleLine,
  addRestockInterest,
  captureSafeRestockArrival,
  changeSaleStatus,
  PharmacySaleError,
  priceFromLot,
  recoverDemandWithAlternate,
  recoverRestockInterest,
  returnSaleLine,
  validateDiscount,
} from './sales';

// The persisted regulatory gate has its own suites (regulatory.test.ts, sale-regulatory-gate.test.ts).
vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));
// Finance posting is outside these physical return-disposition assertions.
vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  postSaleReturnEntry: vi.fn(async () => undefined),
}));

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };

describe('POS sale voiding', () => {
  it('restores exact allocated canonical units once with append-only reversals', async () => {
    let status = 'OPEN';
    const originals = [
      {
        id: 'sale-movement-a',
        inventoryLotId: 'lot-a',
        stockLocationId: 'shelf-a',
        disposition: 'AVAILABLE',
        quantityUnits: -7,
        sealedPackDelta: 0,
        looseUnitDelta: -7,
        idempotencyKey: 'sale:line-a:0',
      },
      {
        id: 'sale-movement-b',
        inventoryLotId: 'lot-b',
        stockLocationId: 'shelf-b',
        disposition: 'AVAILABLE',
        quantityUnits: -5,
        sealedPackDelta: -1,
        looseUnitDelta: 0,
        idempotencyKey: 'sale:line-a:1',
      },
    ];
    const reversals: Array<Record<string, unknown>> = [];
    let allocationQuery: Record<string, unknown> | undefined;
    const db = {
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-a', status, lines: [] }),
        // Keeps this regression runnable against the original implementation:
        // baseline reaches reversal assertions and fails on missing behavior,
        // rather than failing because its former update method is absent.
        update: async ({ data }: { data: { status: string } }) => {
          status = data.status;
          return { id: 'sale-a', status };
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { status: string };
          data: { status: string };
        }) => {
          if (status !== where.status) return { count: 0 };
          status = data.status;
          return { count: 1 };
        },
      },
      pharmacySaleLineAllocation: {
        findMany: async (query: Record<string, unknown>) => {
          allocationQuery = query;
          return originals.map((movement) => ({ stockMovementId: movement.id }));
        },
      },
      pharmacyStockMovement: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          originals.find((movement) => movement.id === where.id) ?? null,
        findMany: async () => originals,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          reversals.push(data);
          return { id: `reversal-${reversals.length}`, ...data };
        },
      },
      pharmacyControlledRegisterEntry: { findMany: async () => [] },
      // DEV-92: a void releases any pack serial the bill claimed.
      pharmacySoldPackSerial: { updateMany: vi.fn(async () => ({ count: 0 })) },
      pharmacySaleEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
      // DEV-623: no money was taken on this bill.
      pharmacyTender: { findMany: async () => [] },
    };

    await changeSaleStatus(db as never, scope, 'sale-a', 'void', 'Customer cancelled');
    expect(db.pharmacySoldPackSerial.updateMany).toHaveBeenCalledTimes(1);

    expect(allocationQuery).toMatchObject({
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        saleLine: { saleId: 'sale-a' },
      },
      select: { stockMovementId: true },
    });
    expect(originals.map((movement) => movement.quantityUnits)).toEqual([-7, -5]);
    expect(reversals).toEqual([
      expect.objectContaining({
        reversesMovementId: 'sale-movement-a',
        quantityUnits: 7,
        looseUnitDelta: 7,
      }),
      expect.objectContaining({
        reversesMovementId: 'sale-movement-b',
        quantityUnits: 5,
        sealedPackDelta: 1,
      }),
    ]);
    expect(Math.abs(Number(reversals[0]?.sealedPackDelta))).toBe(0);
    expect(Math.abs(Number(reversals[1]?.looseUnitDelta))).toBe(0);
    expect(reversals.reduce((units, movement) => units + Number(movement.quantityUnits), 0)).toBe(
      12
    );

    await expect(changeSaleStatus(db as never, scope, 'sale-a', 'void')).rejects.toThrow(
      'INVALID_STATE'
    );
    expect(reversals).toHaveLength(2);
  });

  it('voids a HELD bill directly and puts its stock back (DEV-623)', async () => {
    let status = 'HELD';
    const original = {
      id: 'held-movement',
      inventoryLotId: 'lot-a',
      stockLocationId: 'shelf-a',
      disposition: 'AVAILABLE',
      quantityUnits: -20,
      sealedPackDelta: -2,
      looseUnitDelta: 0,
      idempotencyKey: 'sale:held-line:0',
    };
    const reversals: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const claims: Array<Record<string, unknown>> = [];
    const db = {
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-held', status, lines: [] }),
        updateMany: async ({
          where,
          data,
        }: {
          where: { status: string };
          data: { status: string };
        }) => {
          claims.push(where);
          if (status !== where.status) return { count: 0 };
          status = data.status;
          return { count: 1 };
        },
      },
      pharmacySaleLineAllocation: {
        findMany: async () => [{ stockMovementId: original.id }],
      },
      pharmacyStockMovement: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === original.id ? original : null,
        findMany: async () => [original],
        create: async ({ data }: { data: Record<string, unknown> }) => {
          reversals.push(data);
          return { id: `reversal-${reversals.length}`, ...data };
        },
      },
      pharmacyControlledRegisterEntry: { findMany: async () => [] },
      pharmacySaleEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          events.push(data);
          return data;
        },
      },
      // A part payment that was refunded in full no longer blocks the void.
      pharmacyTender: {
        findMany: async () => [{ amountMinor: 500, refunds: [{ amountMinor: 500 }] }],
      },
      // DEV-92: a void releases any pack serial the bill claimed.
      pharmacySoldPackSerial: { updateMany: async () => ({ count: 0 }) },
    };

    await changeSaleStatus(db as never, scope, 'sale-held', 'void', 'Lost to a reload');

    expect(status).toBe('VOID');
    // The claim is conditional on the status read, so a concurrent resume loses.
    expect(claims).toEqual([expect.objectContaining({ id: 'sale-held', status: 'HELD' })]);
    expect(reversals).toEqual([
      expect.objectContaining({ reversesMovementId: 'held-movement', quantityUnits: 20 }),
    ]);
    expect(events).toEqual([expect.objectContaining({ kind: 'VOIDED' })]);
  });

  it.each(['OPEN', 'HELD'])(
    'refuses to void a %s bill that still holds unrefunded payment (DEV-623)',
    async (current) => {
      let status = current;
      const tenderQueries: unknown[] = [];
      const allocationReads = vi.fn();
      const stockWrites = vi.fn();
      const events = vi.fn();
      const db = {
        pharmacySale: {
          findFirst: async () => ({ id: 'sale-a', status, lines: [] }),
          updateMany: async ({ data }: { data: { status: string } }) => {
            status = data.status;
            return { count: 1 };
          },
        },
        pharmacyTender: {
          findMany: async (query: unknown) => {
            tenderQueries.push(query);
            // A split payment: one tender part-refunded, one untouched.
            return [
              { amountMinor: 1000, refunds: [{ amountMinor: 400 }] },
              { amountMinor: 300, refunds: [] },
            ];
          },
        },
        pharmacySaleLineAllocation: { findMany: allocationReads },
        pharmacyStockMovement: { create: stockWrites },
        pharmacySaleEvent: { create: events },
      };

      await expect(changeSaleStatus(db as never, scope, 'sale-a', 'void')).rejects.toThrow(
        'BILL_HAS_PAYMENTS'
      );
      expect(tenderQueries).toEqual([
        {
          where: { organizationId: 'org-a', branchId: 'branch-a', saleId: 'sale-a' },
          select: { amountMinor: true, refunds: { select: { amountMinor: true } } },
        },
      ]);
      // Refused before any stock is reversed or event recorded; the transaction
      // rolls the status claim back.
      expect(allocationReads).not.toHaveBeenCalled();
      expect(stockWrites).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    }
  );

  it.each(['QUOTATION', 'COMPLETED', 'VOID'])(
    'still refuses to void a %s sale',
    async (current) => {
      const updateMany = vi.fn();
      const db = {
        pharmacySale: {
          findFirst: async () => ({ id: 'sale-a', status: current, lines: [] }),
          updateMany,
        },
      };
      await expect(changeSaleStatus(db as never, scope, 'sale-a', 'void')).rejects.toThrow(
        'INVALID_STATE'
      );
      expect(updateMany).not.toHaveBeenCalled();
    }
  );

  it('stops a losing add-line race before stock allocation', async () => {
    let medicineReads = 0;
    const db = {
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-a', status: 'OPEN' }),
        updateMany: async () => ({ count: 0 }),
      },
      medicine: {
        findFirst: async () => {
          medicineReads += 1;
          return null;
        },
      },
    };

    await expect(
      addSaleLine(db as never, scope, {
        saleId: 'sale-a',
        medicineId: 'medicine-a',
        presentationId: 'presentation-a',
        packLevelId: 'pack-level-a',
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: 'line-a',
      })
    ).rejects.toThrow('INVALID_STATE');
    expect(medicineReads).toBe(0);
  });
});

describe('DEV-819 voucher uses on a voided bill', () => {
  it('gives back the voucher uses taken by an unpaid bill when it is voided', async () => {
    let status = 'OPEN';
    const released: unknown[] = [];
    const db = {
      pharmacySale: {
        findFirst: async () => ({
          id: 'sale-a',
          status,
          lines: [
            { voucherId: 'voucher-a', medicine: { controlled: false } },
            { voucherId: 'voucher-a', medicine: { controlled: false } },
            { voucherId: null, medicine: { controlled: false } },
          ],
        }),
        updateMany: async ({
          where,
          data,
        }: {
          where: { status: string };
          data: { status: string };
        }) => {
          if (status !== where.status) return { count: 0 };
          status = data.status;
          return { count: 1 };
        },
      },
      pharmacyVoucher: {
        updateMany: async (args: unknown) => {
          released.push(args);
          return { count: 1 };
        },
      },
      pharmacySaleLineAllocation: { findMany: async () => [] },
      pharmacyStockMovement: {
        findFirst: async () => null,
        findMany: async () => [],
        create: async () => ({}),
      },
      pharmacyControlledRegisterEntry: { findMany: async () => [] },
      pharmacySaleEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
      pharmacyTender: { findMany: async () => [] },
    };

    await changeSaleStatus(db as never, scope, 'sale-a', 'void', 'Wrong bill');

    expect(released).toEqual([
      {
        where: {
          id: 'voucher-a',
          organizationId: 'org-a',
          branchId: 'branch-a',
          usedCount: { gte: 2 },
        },
        data: { usedCount: { decrement: 2 } },
      },
    ]);
  });
});

describe('DEV-27 voucher scoping at the POS', () => {
  const storedVoucher = {
    id: 'voucher-a',
    discountMinor: 100,
    eligibleCategories: ['NON_DRUG'],
    issuedByUserId: 'owner-a',
    approvedByUserId: 'owner-a' as string | null,
    approvalPolicy: 'VOUCHER_WITHIN_CAP' as string | null,
    validUntil: new Date(Date.now() + 86_400_000) as Date | null,
    maxUses: 5,
    usedCount: 0,
    revokedAt: null as Date | null,
  };
  const issuer = {
    id: 'owner-a',
    organizationId: 'org-a',
    status: 'ACTIVE',
    role: 'ADMIN',
    department: null,
  };
  function voucherDb(
    medicine: Record<string, unknown>,
    voucher: typeof storedVoucher | null = storedVoucher,
    options: { issuer?: Record<string, unknown> | null; taken?: number } = {}
  ) {
    const state = {
      allocations: 0,
      voucherReads: 0,
      voucherWhere: undefined as unknown,
      useWhere: undefined as unknown,
    };
    const issuerRow = options.issuer === undefined ? issuer : options.issuer;
    return {
      state,
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-a', status: 'OPEN' }),
        updateMany: async () => ({ count: 1 }),
      },
      medicine: { findFirst: async () => ({ id: 'medicine-a', saleable: true, ...medicine }) },
      user: {
        findFirst: async () => issuerRow,
        findUnique: async () =>
          issuerRow ? { organizationRole: null, permissionOverrides: [] } : null,
      },
      pharmacyVoucher: {
        findFirst: async (args: { where: unknown }) => {
          state.voucherReads += 1;
          state.voucherWhere = args.where;
          return voucher;
        },
        updateMany: async (args: { where: unknown }) => {
          state.useWhere = args.where;
          return { count: options.taken ?? 1 };
        },
      },
      pharmacyInventoryLot: {
        findMany: async () => {
          state.allocations += 1;
          return [];
        },
      },
    };
  }
  const line = {
    saleId: 'sale-a',
    medicineId: 'medicine-a',
    presentationId: 'presentation-a',
    packLevelId: 'pack-level-a',
    saleUnit: 'UNIT' as const,
    quantity: 1,
    canonicalUnitsPerSaleUnit: 1,
    voucherId: 'voucher-a',
    voucherCashierPinVerified: true as const,
    idempotencyKey: 'line-a',
  };
  const flags = { rx: false, otc: false, restricted: false, controlled: false };

  it.each([
    ['Rx', { ...flags, rx: true, productFamily: 'PHARMACEUTICAL' }],
    ['OTC drug', { ...flags, otc: true, productFamily: 'PHARMACEUTICAL' }],
    ['supplement', { ...flags, productFamily: 'ALTERNATIVE' }],
    ['medical device', { ...flags, productFamily: 'DEVICE' }],
  ])('refuses a stored voucher on a %s line before allocating stock', async (_label, medicine) => {
    const db = voucherDb(medicine);
    await expect(addSaleLine(db as never, scope, line)).rejects.toThrow(
      new PharmacySaleError('VOUCHER_CATEGORY_REFUSED')
    );
    expect(db.state.allocations).toBe(0);
    expect(db.state.voucherWhere).toEqual({
      id: 'voucher-a',
      organizationId: 'org-a',
      branchId: 'branch-a',
      active: true,
      revokedAt: null,
      validUntil: { gt: expect.any(Date) },
    });
  });

  it('enforces the allowlist stored on the voucher, not one sent by the caller', async () => {
    const db = voucherDb(
      { ...flags, otc: true, productFamily: 'PHARMACEUTICAL' },
      { ...storedVoucher, eligibleCategories: ['OTC_DRUG'] }
    );
    await expect(addSaleLine(db as never, scope, line)).rejects.toThrow(
      new PharmacySaleError('VOUCHER_CATEGORY_REFUSED')
    );
  });

  it('refuses a missing, expired or caller-priced voucher', async () => {
    const frontShop = { ...flags, productFamily: 'FRONT_SHOP' };
    for (const [db, input] of [
      [voucherDb(frontShop, null), line],
      [voucherDb(frontShop, { ...storedVoucher, validUntil: new Date(Date.now() - 1000) }), line],
      [voucherDb(frontShop), { ...line, discountMinor: 5000 }],
      [voucherDb(frontShop), { ...line, discountKind: 'DISCOUNT' as const }],
      [voucherDb(frontShop), { ...line, approvedByUserId: 'cashier-a' }],
    ] as const) {
      await expect(addSaleLine(db as never, scope, input)).rejects.toThrow(
        new PharmacySaleError('VOUCHER_INVALID')
      );
      expect(db.state.allocations).toBe(0);
    }
  });

  const frontShop = { ...flags, productFamily: 'FRONT_SHOP' };

  it('DEV-819: refuses a voucher line without the cashier PIN before reading the voucher', async () => {
    const db = voucherDb(frontShop);
    const withoutPin: Omit<typeof line, 'voucherCashierPinVerified'> &
      Partial<Pick<typeof line, 'voucherCashierPinVerified'>> = { ...line };
    delete withoutPin.voucherCashierPinVerified;
    await expect(addSaleLine(db as never, scope, withoutPin)).rejects.toThrow(
      new PharmacySaleError('VOUCHER_PIN_REQUIRED')
    );
    expect(db.state.voucherReads).toBe(0);
    expect(db.state.allocations).toBe(0);
  });

  it('DEV-819: refuses a used-up, revoked or never-expiring voucher', async () => {
    for (const voucher of [
      { ...storedVoucher, usedCount: 5 },
      { ...storedVoucher, revokedAt: new Date() },
      { ...storedVoucher, validUntil: null },
    ]) {
      const db = voucherDb(frontShop, voucher);
      await expect(addSaleLine(db as never, scope, line)).rejects.toThrow(
        new PharmacySaleError('VOUCHER_INVALID')
      );
      expect(db.state.useWhere).toBeUndefined();
      expect(db.state.allocations).toBe(0);
    }
  });

  it("DEV-819: re-checks the issuer's owner rights when the voucher is redeemed", async () => {
    for (const issuerRow of [
      null,
      { ...issuer, role: 'EMPLOYEE' },
      { ...issuer, status: 'SUSPENDED' },
      { ...issuer, organizationId: 'org-b' },
    ]) {
      const db = voucherDb(frontShop, storedVoucher, { issuer: issuerRow });
      await expect(addSaleLine(db as never, scope, line)).rejects.toThrow(
        new PharmacySaleError('VOUCHER_INVALID')
      );
      expect(db.state.useWhere).toBeUndefined();
      expect(db.state.allocations).toBe(0);
    }
  });

  it('DEV-819: refuses a voucher above the value cap that the issuer approved alone', async () => {
    const db = voucherDb(frontShop, { ...storedVoucher, discountMinor: 150_000 });
    await expect(addSaleLine(db as never, scope, line)).rejects.toThrow(
      new PharmacySaleError('VOUCHER_INVALID')
    );
    expect(db.state.allocations).toBe(0);
  });

  it('DEV-819: takes one use with a compare-and-set and refuses a lost race', async () => {
    const db = voucherDb(frontShop, { ...storedVoucher, usedCount: 4 }, { taken: 0 });
    await expect(addSaleLine(db as never, scope, line)).rejects.toThrow(
      new PharmacySaleError('VOUCHER_INVALID')
    );
    expect(db.state.useWhere).toEqual({
      id: 'voucher-a',
      organizationId: 'org-a',
      branchId: 'branch-a',
      active: true,
      revokedAt: null,
      usedCount: 4,
    });
    expect(db.state.allocations).toBe(0);
  });
});

describe('POS-03 lot-derived pack/strip/unit pricing', () => {
  it('charges a full pack at its exact printed MRP without compounding loose-unit floors', () => {
    expect(
      priceFromLot({
        printedMrpMinor: 1_000,
        canonicalUnitsInPack: 3,
        canonicalUnitsPerSaleUnit: 3,
      })
    ).toEqual({ unitPriceMinor: 1_000, proRataCeilingMinor: 1_000 });
  });

  it('derives a strip price from the allocated lot printed MRP', () => {
    expect(
      priceFromLot({
        printedMrpMinor: 1_003,
        canonicalUnitsInPack: 20,
        canonicalUnitsPerSaleUnit: 10,
        roundingIncrementMinor: 1,
      })
    ).toEqual({ unitPriceMinor: 501, proRataCeilingMinor: 501 });
  });

  it('rounds down and never exceeds the pro-rata ceiling', () => {
    const price = priceFromLot({
      printedMrpMinor: 1_000,
      canonicalUnitsInPack: 3,
      canonicalUnitsPerSaleUnit: 1,
      roundingIncrementMinor: 5,
    });
    expect(price).toEqual({ unitPriceMinor: 330, proRataCeilingMinor: 333 });
    expect(price.unitPriceMinor).toBeLessThanOrEqual(price.proRataCeilingMinor);
  });

  it('rounds once at the partial sale-unit level', () => {
    expect(
      priceFromLot({
        printedMrpMinor: 1_000,
        canonicalUnitsInPack: 3,
        canonicalUnitsPerSaleUnit: 2,
        roundingIncrementMinor: 5,
      })
    ).toEqual({ unitPriceMinor: 665, proRataCeilingMinor: 666 });
  });
});

describe('DEM-03 restock interest', () => {
  it('refuses a contact when current reminders consent is not granted', async () => {
    const db = {
      unfulfilledDemandEvent: { findFirst: async () => ({ id: 'demand-a' }) },
      patientConsent: { findFirst: async () => ({ granted: false, revokedAt: null }) },
    };
    await expect(
      addRestockInterest(db as never, scope, {
        demandEventId: 'demand-a',
        patientId: 'patient-a',
        channel: 'WHATSAPP',
        quantityUnits: 2,
      })
    ).rejects.toThrow('CONSENT_REQUIRED');
  });

  it.each([
    {
      receivedAt: new Date(),
      state: 'ACTIVE',
      expiresAt: new Date('2026-01-01'),
      disposition: 'AVAILABLE',
    },
    {
      receivedAt: new Date(),
      state: 'ACTIVE',
      expiresAt: new Date('2027-01-01'),
      disposition: 'QUARANTINE',
    },
  ])(
    'does not queue for expired or quarantined arrivals',
    async ({ receivedAt, state, expiresAt, disposition }) => {
      let notifications = 0;
      const db = {
        pharmacyInventoryLot: {
          findFirst: async () => ({
            id: 'lot-a',
            receivedAt,
            batch: { medicineId: 'med-a', state, expiresAt },
            balances: disposition === 'AVAILABLE' ? [{ stockLocationId: 'shelf-a' }] : [],
          }),
        },
        pharmacyRestockNotification: {
          create: async () => {
            notifications += 1;
          },
        },
      };
      await expect(
        captureSafeRestockArrival(db as never, scope, {
          inventoryLotId: 'lot-a',
          at: new Date('2026-06-01'),
        })
      ).rejects.toThrow('UNSAFE_STOCK');
      expect(notifications).toBe(0);
    }
  );

  it('attributes the completed receipt to the originating event and interest', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      pharmacyRestockInterest: {
        findFirst: async () => ({
          id: 'interest-a',
          demandEventId: 'demand-a',
          demandEvent: { requestedMedicineId: 'med-a' },
        }),
        update: async (args: { data: Record<string, unknown> }) => {
          writes.push(args.data);
          return { ...args.data, recoveredSale: { receiptNumber: 42 } };
        },
      },
      pharmacySaleLine: {
        findFirst: async () => ({
          id: 'line-a',
          saleId: 'sale-a',
          medicineId: 'med-a',
          sale: { status: 'COMPLETED', receiptNumber: 42 },
        }),
      },
      unfulfilledDemandEvent: {
        update: async (args: { data: Record<string, unknown> }) => {
          writes.push(args.data);
          return args;
        },
      },
      pharmacyRestockReservation: { updateMany: async () => ({ count: 1 }) },
    };
    const result = await recoverRestockInterest(db as never, scope, {
      interestId: 'interest-a',
      saleLineId: 'line-a',
    });
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'RECOVERED', recoveredSaleLineId: 'line-a' }),
        expect.objectContaining({
          status: 'RECOVERED',
          recoveredSaleId: 'sale-a',
          recoveredSaleLineId: 'line-a',
        }),
      ])
    );
    expect(result).toMatchObject({ recoveredSale: { receiptNumber: 42 } });
  });
});

describe('POS-04 discount guardrails', () => {
  it('fails closed for Rx/restricted/controlled medicine', () => {
    expect(() =>
      validateDiscount({
        regulated: true,
        discountMinor: 1,
        grossMinor: 100,
        costMinor: 20,
        approvedByUserId: 'manager',
        approvalPolicy: 'D06',
      })
    ).toThrow(new PharmacySaleError('REGULATED_DISCOUNT_REFUSED'));
  });

  it('requires attributable approval and refuses below-cost discounting', () => {
    expect(() =>
      validateDiscount({ regulated: false, discountMinor: 10, grossMinor: 100, costMinor: 20 })
    ).toThrow('APPROVAL_REQUIRED');
    expect(() =>
      validateDiscount({
        regulated: false,
        discountMinor: 90,
        grossMinor: 100,
        costMinor: 20,
        approvedByUserId: 'manager',
        approvalPolicy: 'standard',
      })
    ).toThrow('MARGIN_GUARDRAIL');
  });
});

describe('POS-06 linked returns', () => {
  it('refuses cumulative returns above the quantity sold', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacySaleEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacySaleLine: {
        findFirst: async () => ({
          id: 'line-a',
          saleId: 'sale-a',
          canonicalUnits: 10,
          sale: { status: 'COMPLETED' },
          medicine: { controlled: false },
          allocations: [{ canonicalUnits: 10 }],
          unidentifiedReturnHolds: [],
          returnLines: [{ canonicalUnits: 7 }],
        }),
      },
    };
    await expect(
      returnSaleLine(db as never, scope, {
        saleLineId: 'line-a',
        canonicalUnits: 4,
        quarantineLocationId: 'quarantine',
        reason: 'customer return',
        integrityDecision: 'seal unknown',
        idempotencyKey: 'return-a',
      })
    ).rejects.toThrow('RETURN_EXCEEDS_SOLD');
  });

  it('posts accepted returns only to QUARANTINE', async () => {
    const created: Array<Record<string, unknown>> = [];
    const model = {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return {
          id: `new-${created.length}`,
          createdAt: new Date('2026-09-04T10:00:00Z'),
          ...data,
        };
      },
    };
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyStockLocation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'quarantine',
          organizationId: 'org-a',
          branchId: 'branch-a',
          active: true,
          kind: 'QUARANTINE',
        }),
      },
      pharmacySaleLine: {
        findFirst: async () => ({
          id: 'line-a',
          saleId: 'sale-a',
          canonicalUnits: 10,
          sale: { status: 'COMPLETED' },
          medicine: { controlled: false },
          allocations: [{ id: 'allocation-a', inventoryLotId: 'lot-a', canonicalUnits: 10 }],
          unidentifiedReturnHolds: [],
          returnLines: [],
        }),
      },
      pharmacySaleReturn: model,
      pharmacyStockMovement: model,
      pharmacySaleReturnLine: model,
      pharmacySaleEvent: { ...model, findFirst: vi.fn().mockResolvedValue(null) },
    };
    await returnSaleLine(db as never, scope, {
      saleLineId: 'line-a',
      lotId: 'lot-a',
      canonicalUnits: 2,
      quarantineLocationId: 'quarantine',
      reason: 'customer return',
      integrityDecision: 'seal unknown',
      idempotencyKey: 'return-a',
    });
    expect(created[1]).toMatchObject({
      kind: 'RETURN',
      disposition: 'QUARANTINE',
      quantityUnits: 2,
      stockLocationId: 'quarantine',
    });
  });
});

describe('POS-10 recovered alternate', () => {
  it('closes an explicit event only when the alternate belongs to the same sale', async () => {
    let update: unknown;
    const db = {
      unfulfilledDemandEvent: {
        findFirst: async () => ({ id: 'demand-a', saleId: 'sale-a' }),
        update: async (args: unknown) => {
          update = args;
          return args;
        },
      },
      pharmacySaleLine: { findFirst: async () => ({ id: 'line-a', saleId: 'sale-a' }) },
    };
    await recoverDemandWithAlternate(db as never, scope, 'demand-a', 'line-a');
    expect(update).toMatchObject({ data: { status: 'RECOVERED', recoveredSaleLineId: 'line-a' } });
  });
});
