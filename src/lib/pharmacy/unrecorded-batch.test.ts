/**
 * DEV-853 — legacy opening stock with no batch number and/or no expiry.
 *
 * Owner decision: such a lot is stored as "not recorded" (never an invented
 * batch or date) and IS sellable. An unknown expiry is never treated as
 * expired, FEFO picks lots with a known expiry first, and screens and receipts
 * say "Batch not recorded" / "Expiry not recorded" in plain words. The block on
 * stock whose KNOWN expiry has passed is unchanged.
 */
import { describe, expect, it } from 'vitest';

import { nearExpiryDays } from '@/components/pharmacy/counter/counter-cart';

import { formatShortExpiry, receiptLineLabel, type CounterReceiptLine } from './counter-receipt';
import { counterLinePresentation } from './counter-receipt-presentation';
import { batchLabel } from './finance-labels';
import { blockReasonFor, planAllocation, type AllocationCandidate } from './inventory';
import { mrpRoundingIncrementForLot } from './medicine';
import { evaluatePackAuthentication } from './pack-authentication';
import { formatLotExpiry } from './product-class';
import { validateReceiptIdentity } from './receipt-identity';
import { buildShelfLabelSheet, type ShelfLabelRow } from './shelf-label';
import { shelfLabelCode } from './shelf-label-code';
import { printedExpiryLabel } from './shelf-label-source';
import { evaluateStockSignals, type LotFact } from './stock-signals';
import {
  BATCH_NOT_RECORDED,
  batchNumberLabel,
  batchPhrase,
  compareKnownExpiryFirst,
  EXPIRY_NOT_RECORDED,
  hasKnownExpiryPassed,
  readPrintedExpiry,
} from './unrecorded-batch';

const AT = new Date('2026-11-18T09:00:00.000Z');
const DAY = 86_400_000;
const SCOPE = { organizationId: 'org', branchId: 'branch', at: AT };

function candidate(overrides: Partial<AllocationCandidate> = {}): AllocationCandidate {
  return {
    inventoryLotId: 'lot',
    stockLocationId: 'loc',
    organizationId: 'org',
    branchId: 'branch',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date(AT.getTime() + 200 * DAY),
    receivedAt: new Date(AT.getTime() - 30 * DAY),
    availableUnits: 10,
    ...overrides,
  };
}

describe('DEV-853 plain-words helpers', () => {
  it('names an unrecorded batch and expiry in plain words, never as a code', () => {
    expect(BATCH_NOT_RECORDED).toBe('Batch not recorded');
    expect(EXPIRY_NOT_RECORDED).toBe('Expiry not recorded');
    expect(batchNumberLabel(null)).toBe('Batch not recorded');
    expect(batchNumberLabel('   ')).toBe('Batch not recorded');
    expect(batchNumberLabel('B-17')).toBe('B-17');
    expect(batchLabel({ batchNumber: null, medicineName: 'Panadol' })).toBe(
      'Panadol · Batch not recorded'
    );
    expect(batchPhrase(null, 'batch')).toBe('Batch not recorded');
    expect(batchPhrase('B-17', 'batch')).toBe('batch B-17');
    expect(batchPhrase('B-17')).toBe('Batch B-17');
    expect(batchLabel({ batchNumber: null })).toBe('Batch not recorded');
  });

  it('treats only a KNOWN expiry that has passed as expired', () => {
    expect(hasKnownExpiryPassed(null, AT)).toBe(false);
    expect(hasKnownExpiryPassed(undefined, AT)).toBe(false);
    expect(hasKnownExpiryPassed(AT, AT)).toBe(true);
    expect(hasKnownExpiryPassed(new Date(AT.getTime() - 1), AT)).toBe(true);
    expect(hasKnownExpiryPassed(new Date(AT.getTime() + 1), AT)).toBe(false);
  });

  it('orders known expiries first, earliest first, then unrecorded ones', () => {
    const early = new Date('2027-01-01T00:00:00Z');
    const late = new Date('2028-01-01T00:00:00Z');
    const sorted = [null, late, null, early].sort(compareKnownExpiryFirst);
    expect(sorted).toEqual([early, late, null, null]);
  });

  it('reads the expiry exactly as printed, keeping a printed day', () => {
    expect(readPrintedExpiry('2027-06')).toEqual({
      printedExpiry: new Date('2027-06-01T00:00:00.000Z'),
      precision: 'MONTH',
    });
    expect(readPrintedExpiry(' 2027-06-10 ')).toEqual({
      printedExpiry: new Date('2027-06-10T00:00:00.000Z'),
      precision: 'DAY',
    });
    expect(readPrintedExpiry('2027-13')).toBeNull();
    expect(readPrintedExpiry('2027-02-30')).toBeNull();
    expect(readPrintedExpiry('June 2027')).toBeNull();
  });
});

describe('DEV-853 sale rules: an unknown expiry never blocks a sale', () => {
  it('lets a lot with no recorded expiry be sold', () => {
    expect(blockReasonFor(candidate({ expiresAt: null }), SCOPE)).toBeNull();
  });

  it('still blocks a lot whose known expiry has passed', () => {
    expect(blockReasonFor(candidate({ expiresAt: new Date(AT.getTime() - DAY) }), SCOPE)).toBe(
      'EXPIRED'
    );
    expect(blockReasonFor(candidate({ expiresAt: AT }), SCOPE)).toBe('EXPIRED');
  });

  it('keeps every other hard block for a lot with no recorded expiry', () => {
    expect(blockReasonFor(candidate({ expiresAt: null, batchState: 'RECALLED' }), SCOPE)).toBe(
      'RECALLED'
    );
    expect(blockReasonFor(candidate({ expiresAt: null, disposition: 'QUARANTINE' }), SCOPE)).toBe(
      'QUARANTINED'
    );
    expect(blockReasonFor(candidate({ expiresAt: null, receivedAt: null }), SCOPE)).toBe(
      'UNRECEIVED'
    );
  });

  it('FEFO draws lots with a known expiry first, then the unrecorded ones', () => {
    const plan = planAllocation({
      candidates: [
        candidate({ inventoryLotId: 'a-unknown', expiresAt: null, availableUnits: 5 }),
        candidate({
          inventoryLotId: 'b-late',
          expiresAt: new Date(AT.getTime() + 300 * DAY),
          availableUnits: 5,
        }),
        candidate({
          inventoryLotId: 'c-early',
          expiresAt: new Date(AT.getTime() + 20 * DAY),
          availableUnits: 5,
        }),
      ],
      requiredUnits: 12,
      scope: SCOPE,
    });
    expect(plan.recommendedLotId).toBe('c-early');
    expect(plan.allocations.map((row) => [row.inventoryLotId, row.units])).toEqual([
      ['c-early', 5],
      ['b-late', 5],
      ['a-unknown', 2],
    ]);
  });

  it('sells unrecorded-expiry stock when it is the only stock, and never expired stock', () => {
    const plan = planAllocation({
      candidates: [
        candidate({ inventoryLotId: 'expired', expiresAt: new Date(AT.getTime() - DAY) }),
        candidate({ inventoryLotId: 'unknown', expiresAt: null }),
      ],
      requiredUnits: 4,
      scope: SCOPE,
    });
    expect(plan.allocations).toEqual([
      { inventoryLotId: 'unknown', stockLocationId: 'loc', units: 4 },
    ]);
  });

  it('prices a lot with no recorded batch without a batch-specific MRP rule', () => {
    const rules = [{ packLevelId: 'pack', batchReference: 'B-1', roundingIncrementMinor: 500 }];
    expect(mrpRoundingIncrementForLot(rules, { packLevelId: 'pack', batchNumber: null })).toBe(1);
    expect(mrpRoundingIncrementForLot(rules, { packLevelId: 'pack', batchNumber: 'B-1' })).toBe(
      500
    );
  });
});

describe('DEV-853 stock signals and near-expiry', () => {
  function lot(overrides: Partial<LotFact> = {}): LotFact {
    return {
      inventoryLotId: 'lot_1',
      medicineId: 'med',
      stockLocationId: 'loc',
      expiresAt: null,
      receivedAt: new Date(AT.getTime() - 30 * DAY),
      disposition: 'AVAILABLE',
      batchState: 'ACTIVE',
      onHandUnits: 100,
      reservedUnits: 0,
      returnWindowEndsAt: null,
      medicineColdChain: false,
      locationColdChain: false,
      recallReference: null,
      unsettled: false,
      ...overrides,
    };
  }
  const facts = (lots: LotFact[]) => ({
    organizationId: 'org',
    branchId: 'branch',
    at: AT,
    sourceObservedAt: new Date(AT.getTime() - 3_600_000),
    lots,
    safetyStocks: [{ medicineId: 'med', safetyStockUnits: 50, coverageDays: 30, approvedAt: AT }],
    inbound: [],
    countVariances: [],
  });

  it('counts unrecorded-expiry stock as saleable and raises no near-expiry signal for it', () => {
    const kinds = evaluateStockSignals(facts([lot()])).map((signal) => signal.kind);
    expect(kinds).not.toContain('STOCKOUT');
    expect(kinds).not.toContain('LOW_STOCK');
    expect(kinds).not.toContain('NEAR_EXPIRY');
  });

  it('still raises a stockout when the only stock has a known expiry that passed', () => {
    const kinds = evaluateStockSignals(
      facts([lot({ expiresAt: new Date(AT.getTime() - DAY) })])
    ).map((signal) => signal.kind);
    expect(kinds).toContain('STOCKOUT');
  });

  it('never flags an unrecorded expiry as near expiry at the counter', () => {
    expect(nearExpiryDays(null, AT)).toBeNull();
    expect(nearExpiryDays(new Date(AT.getTime() + 10 * DAY).toISOString(), AT)).toBe(10);
  });
});

describe('DEV-853 screens and receipts say "not recorded"', () => {
  it('shows the expiry in plain words on counter and inventory screens', () => {
    expect(formatShortExpiry(null)).toBe('Expiry not recorded');
    expect(formatLotExpiry<Date>(null, (value) => value.toISOString())).toBe('Expiry not recorded');
    expect(printedExpiryLabel(null, 'MONTH')).toBeNull();
  });

  it('prints "Batch not recorded" / "Expiry not recorded" on an issued receipt line', () => {
    const line = {
      saleLineId: 'line',
      identityStatus: 'ISSUED',
      medicineName: 'Panadol',
      strength: '500 mg',
      presentation: 'Tablet',
      allocations: [
        {
          allocationId: 'a1',
          inventoryLotId: 'lot',
          batchNumber: null,
          expiresAt: null,
          canonicalUnits: 10,
        },
      ],
      batchNumber: 'Batch not recorded (10 units)',
      expiresAt: null,
      saleUnit: 'TABLET',
      quantity: 10,
      canonicalUnits: 10,
      unitPriceMinor: 100,
      discountMinor: 0,
      lineTotalMinor: 1000,
    } as unknown as CounterReceiptLine;

    const shown = counterLinePresentation(line, 'en').allocations[0]!;
    expect(shown).toContain('Batch not recorded');
    expect(shown).toContain('Expiry not recorded');
    expect(shown).not.toMatch(/MISSING_|null|Unavailable/);
    const label = receiptLineLabel(line, 'en');
    expect(label).toContain('Batch not recorded');
    expect(label).not.toContain('Batch Batch');
    expect(label).toContain('Expiry not recorded');
    expect(label).not.toMatch(/MISSING_|null/);
  });

  it('accepts a receipt identity whose dispensed lot has no recorded batch or expiry', () => {
    const date = new Date('2026-11-18T00:00:00.000Z');
    const snapshot = validateReceiptIdentity(
      {
        receiptIdentitySnapshotVersion: 1,
        saleId: 'sale',
        receiptNumber: 1,
        deviceId: 'device',
        businessDate: '2026-11-18',
        issuedAt: date.toISOString(),
        lines: [
          {
            saleLineId: 'line',
            medicineId: 'medicine',
            presentationId: 'presentation',
            medicineName: 'Panadol',
            strength: null,
            presentation: 'Tablet',
            allocations: [
              {
                allocationId: 'a1',
                inventoryLotId: 'lot',
                batchNumber: null,
                expiresAt: null,
                canonicalUnits: 10,
              },
            ],
          },
        ],
      },
      {
        id: 'sale',
        receiptNumber: 1,
        receiptDeviceId: 'device',
        businessDate: date,
        completedAt: date,
        lines: [
          {
            id: 'line',
            medicineId: 'medicine',
            presentationId: 'presentation',
            canonicalUnits: 10,
            allocations: [{ id: 'a1', inventoryLotId: 'lot', canonicalUnits: 10 }],
          },
        ],
      }
    );
    expect(snapshot.lines[0]!.allocations[0]).toMatchObject({ batchNumber: null, expiresAt: null });
  });

  it('prints a shelf label for a lot with no recorded batch or expiry', () => {
    const row: ShelfLabelRow = {
      inventoryLotId: 'lot',
      code: shelfLabelCode(9),
      name: 'Legacy stock',
      strength: null,
      packMrpMinor: 10_000,
      stripMrpMinor: null,
      expiry: null,
      batchNumber: null,
      defaultCount: 1,
      unavailableReason: null,
    };
    const html = buildShelfLabelSheet([{ row, count: 1 }], '38x25');
    expect(html).toContain('Expiry not recorded · Batch not recorded');
    expect(html).not.toMatch(/EXP <strong>|MISSING_|null/);
  });

  it('does not report a pack expiry mismatch against an unrecorded batch expiry', () => {
    const facts = {
      parsed: {
        kind: 'parsed',
        fields: { gtin: '01234567890128', batch: 'LOT-7', expiry: '271231', serial: 'S1' },
      },
      knownMedicineId: 'medicine',
      recordedBatch: { id: 'batch', batchNumber: 'LOT-7', expiry: null, recalled: false },
      serialSeenOnDifferentPack: false,
    } as unknown as Parameters<typeof evaluatePackAuthentication>[0];
    expect(evaluatePackAuthentication(facts).issues).not.toContain('EXPIRY_MISMATCH');
  });
});
