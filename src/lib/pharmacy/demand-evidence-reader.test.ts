import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  readPharmacyDemandEvidence,
  type PharmacyDemandEvidenceReaderInput,
} from './demand-evidence-reader';

const at = (value: string) => new Date(value);
const readAt = at('2026-09-14T12:00:00Z');
const input: PharmacyDemandEvidenceReaderInput = {
  organizationId: 'org',
  branchId: 'branch',
  medicineId: 'medicine',
  authorizedBranchIds: ['branch'],
  historyStartDate: '2026-09-10',
  originDate: '2026-09-13',
  horizonDays: 2,
  method: 'RECENT_MEAN',
};
const line = () => ({
  id: 'line-1',
  organizationId: 'org',
  branchId: 'branch',
  medicineId: 'medicine',
  canonicalUnits: 12,
  createdAt: at('2026-09-10T10:00:00Z'),
  sale: {
    organizationId: 'org',
    branchId: 'branch',
    status: 'COMPLETED',
    businessDate: at('2026-09-10T00:00:00Z') as Date | null,
    completedAt: at('2026-09-10T10:05:00Z') as Date | null,
    createdAt: at('2026-09-10T09:00:00Z'),
    updatedAt: at('2026-09-10T10:05:00Z'),
  },
});
const stockout = () => ({
  id: 'stockout-1',
  organizationId: 'org',
  branchId: 'branch',
  requestedMedicineId: 'medicine' as string | null,
  reason: 'STOCKOUT',
  createdAt: at('2026-09-11T23:30:00Z'),
});
function database(lines = [line()], stockouts: ReturnType<typeof stockout>[] = []) {
  const reads = {
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch', organizationId: 'org', active: true }),
    },
    medicine: { findFirst: vi.fn().mockResolvedValue({ id: 'medicine', organizationId: 'org' }) },
    pharmacySaleLine: { findMany: vi.fn().mockResolvedValue(lines) },
    unfulfilledDemandEvent: { findMany: vi.fn().mockResolvedValue(stockouts) },
  };
  const forbidden = vi.fn((name: string): never => {
    throw new Error(`Forbidden database access: ${name}`);
  });
  const delegates = Object.fromEntries(
    Object.entries(reads).map(([name, delegate]) => [
      name,
      new Proxy(delegate, {
        get(target, key) {
          if (!(key in target)) return forbidden(`${name}.${String(key)}`);
          return Reflect.get(target, key);
        },
      }),
    ])
  );
  const db = new Proxy(delegates, {
    get(target, key) {
      if (!(key in target)) return forbidden(String(key));
      return Reflect.get(target, key);
    },
  }) as unknown as ScopedDb;
  return { db, reads, forbidden };
}

describe('readPharmacyDemandEvidence', () => {
  it('keeps frozen consumption separate from unknown demand and unknown no-sale days', async () => {
    const { db } = database();
    const result = await readPharmacyDemandEvidence(db, input, readAt);
    expect(result.consumption).toEqual({
      timeBasis: 'SALE_BUSINESS_DATE',
      observedCanonicalUnits: 12,
      days: [
        { date: '2026-09-10', observedCanonicalUnits: 12, lineCount: 1 },
        { date: '2026-09-11', observedCanonicalUnits: null, lineCount: 0 },
        { date: '2026-09-12', observedCanonicalUnits: null, lineCount: 0 },
      ],
    });
    expect(result.days.map((day) => [day.state, day.estimatedDemandUnits, day.knownAt])).toEqual([
      ['UNKNOWN', null, null],
      ['UNKNOWN', null, null],
      ['UNKNOWN', null, null],
    ]);
    expect(result.coverage).toMatchObject({
      requestedDays: 3,
      unknownDays: 3,
      censoredDays: 0,
      observedDemandDays: 0,
      qualifyingLineCount: 1,
    });
    expect(result.forecastInput).toBeNull();
    expect(result.backtestEligibility.eligible).toBe(false);
    expect(result.provenance.readAt).toBe(readAt.toISOString());
    expect(result.missingInputs.join(' ')).toMatch(/accounting daily closes do not establish/);
  });

  it('does not invent recorded zero consumption for an empty source', async () => {
    const result = await readPharmacyDemandEvidence(database([]).db, input, readAt);
    expect(result.consumption.observedCanonicalUnits).toBeNull();
    expect(
      result.days.every((day) => day.observedCanonicalUnits === null && day.state === 'UNKNOWN')
    ).toBe(true);
    expect(result.coverage.qualifyingLineCount).toBe(0);
  });

  it('preserves explicitly recorded zero units without claiming observed zero demand', async () => {
    const result = await readPharmacyDemandEvidence(
      database([{ ...line(), canonicalUnits: 0 }]).db,
      input,
      readAt
    );
    expect(result.consumption.observedCanonicalUnits).toBe(0);
    expect(result.days[0]).toMatchObject({
      state: 'UNKNOWN',
      observedCanonicalUnits: 0,
      estimatedDemandUnits: null,
    });
  });

  it('requires authorized scope before any database read', async () => {
    const { db, reads } = database();
    await expect(
      readPharmacyDemandEvidence(db, { ...input, authorizedBranchIds: [] }, readAt)
    ).rejects.toThrow('authorized scope');
    expect(reads.pharmacyBranch.findFirst).not.toHaveBeenCalled();
    expect(reads.pharmacySaleLine.findMany).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { id: 'branch', organizationId: 'org', active: false },
    { id: 'branch', organizationId: 'foreign', active: true },
    { id: 'other', organizationId: 'org', active: true },
  ])('rejects absent, inactive or foreign branch: %j', async (branch) => {
    const { db, reads } = database();
    reads.pharmacyBranch.findFirst.mockResolvedValue(branch);
    await expect(readPharmacyDemandEvidence(db, input, readAt)).rejects.toThrow(
      'active authorized scope'
    );
    expect(reads.medicine.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { id: 'medicine', organizationId: 'foreign' },
    { id: 'other', organizationId: 'org' },
  ])('rejects foreign or missing medicine: %j', async (medicine) => {
    const { db, reads } = database();
    reads.medicine.findFirst.mockResolvedValue(medicine);
    await expect(readPharmacyDemandEvidence(db, input, readAt)).rejects.toThrow(
      'Medicine is outside'
    );
    expect(reads.pharmacySaleLine.findMany).not.toHaveBeenCalled();
  });

  it('scopes both line and sale joins, selects completed-only rows and bounds both date views', async () => {
    const { db, reads } = database();
    await readPharmacyDemandEvidence(db, input, readAt);
    expect(reads.pharmacyBranch.findFirst.mock.calls[0][0].where).toEqual({
      id: 'branch',
      organizationId: 'org',
      active: true,
    });
    expect(reads.medicine.findFirst.mock.calls[0][0].where).toEqual({
      id: 'medicine',
      organizationId: 'org',
    });
    const range = { gte: at('2026-09-10T00:00:00Z'), lt: at('2026-09-13T00:00:00Z') };
    expect(reads.pharmacySaleLine.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org',
      branchId: 'branch',
      medicineId: 'medicine',
      sale: {
        organizationId: 'org',
        branchId: 'branch',
        status: 'COMPLETED',
        OR: [{ businessDate: range }, { completedAt: range }],
      },
    });
    expect(reads.unfulfilledDemandEvent.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org',
      branchId: 'branch',
      requestedMedicineId: 'medicine',
      reason: 'STOCKOUT',
      createdAt: { ...range, lte: readAt },
    });
  });

  it('defensively excludes wrong tenant, branch, medicine, sale join and non-completed statuses', async () => {
    const rows = [
      line(),
      ...['organizationId', 'branchId', 'medicineId'].map((key) => ({
        ...line(),
        id: key,
        [key]: 'foreign',
      })),
      ...['organizationId', 'branchId'].map((key) => ({
        ...line(),
        id: `sale-${key}`,
        sale: { ...line().sale, [key]: 'foreign' },
      })),
      ...['OPEN', 'HELD', 'VOIDED', 'RETURNED', 'QUOTATION'].map((status) => ({
        ...line(),
        id: status,
        sale: { ...line().sale, status },
      })),
    ];
    const result = await readPharmacyDemandEvidence(database(rows).db, input, readAt);
    expect(result.consumption.observedCanonicalUnits).toBe(12);
    expect(result.coverage).toMatchObject({ qualifyingLineCount: 1, excludedLineCount: 10 });
  });

  it('keeps local business labels separate from UTC completion dates at period boundaries', async () => {
    const first = {
      ...line(),
      sale: { ...line().sale, completedAt: at('2026-09-10T00:30:00+05:00') },
    };
    const last = {
      ...line(),
      id: 'last',
      canonicalUnits: 7,
      sale: {
        ...line().sale,
        businessDate: at('2026-09-13T00:00:00Z'),
        completedAt: at('2026-09-13T00:30:00+05:00'),
      },
    };
    const result = await readPharmacyDemandEvidence(database([first, last]).db, input, readAt);
    expect(result.consumption.days.map((day) => day.observedCanonicalUnits)).toEqual([
      12,
      null,
      null,
    ]);
    expect(result.days.map((day) => day.observedCanonicalUnits)).toEqual([null, null, 7]);
    expect(result.coverage.businessUtcDateMismatchLineCount).toBe(2);
  });

  it('uses frozen canonicalUnits without quantity, pack, return or refund arithmetic', async () => {
    const row = {
      ...line(),
      quantity: 99,
      canonicalUnitsPerSaleUnit: 20,
      returnLines: [{ canonicalUnits: 12 }],
      refunds: [{ amountMinor: 1000 }],
    };
    const result = await readPharmacyDemandEvidence(database([row]).db, input, readAt);
    expect(result.consumption.observedCanonicalUnits).toBe(12);
    expect(result.provenance.sources.join(' ')).toMatch(/not netted/);
  });

  it('retains late current facts without inventing knownAt or historical backtest eligibility', async () => {
    const row = {
      ...line(),
      createdAt: at('2026-09-14T10:00:00Z'),
      sale: { ...line().sale, updatedAt: readAt },
    };
    const result = await readPharmacyDemandEvidence(database([row]).db, input, readAt);
    expect(result.consumption.observedCanonicalUnits).toBe(12);
    expect(result.coverage.factsAtOrAfterOriginLineCount).toBe(1);
    expect(result.days[0].knownAt).toBeNull();
    expect(result.forecastInput).toBeNull();
    expect(result.backtestEligibility).toMatchObject({ eligible: false });
    expect(result.provenance.historicalVersionsAvailable).toBe(false);
  });

  it.each(['lineCreatedAt', 'saleCreatedAt', 'updatedAt', 'completedAt'])(
    'excludes facts after readAt: %s',
    async (field) => {
      const row = line();
      const future = new Date(readAt.getTime() + 1);
      if (field === 'lineCreatedAt') row.createdAt = future;
      else if (field === 'saleCreatedAt') row.sale.createdAt = future;
      else if (field === 'updatedAt') row.sale.updatedAt = future;
      else row.sale.completedAt = future;
      const result = await readPharmacyDemandEvidence(database([row]).db, input, readAt);
      expect(result.consumption.observedCanonicalUnits).toBeNull();
      expect(result.coverage).toMatchObject({ factsAfterReadAtLineCount: 1, excludedLineCount: 1 });
    }
  );

  it('exposes missing date inputs and excludes missing completion timestamps', async () => {
    const rows = [
      { ...line(), sale: { ...line().sale, businessDate: null } },
      { ...line(), id: 'no-completion', sale: { ...line().sale, completedAt: null } },
    ];
    const result = await readPharmacyDemandEvidence(database(rows).db, input, readAt);
    expect(result.consumption.observedCanonicalUnits).toBeNull();
    expect(result.days[0].observedCanonicalUnits).toBe(12);
    expect(result.coverage).toMatchObject({
      missingBusinessDateLineCount: 1,
      missingCompletedAtLineCount: 1,
      excludedLineCount: 1,
    });
  });

  it('marks genuine UTC stockout capture days censored even with no sale and after recovery', async () => {
    const events = [
      { ...stockout(), quantity: 900, saleUnit: 'PACK', status: 'RECOVERED' },
      {
        ...stockout(),
        id: 'with-sale',
        createdAt: at('2026-09-10T12:00:00Z'),
        quantity: 20,
        status: 'CLOSED',
      },
    ];
    const result = await readPharmacyDemandEvidence(database([line()], events).db, input, readAt);
    expect(
      result.days.map((day) => [day.state, day.observedCanonicalUnits, day.stockoutEventCount])
    ).toEqual([
      ['STOCKOUT_CENSORED', 12, 1],
      ['STOCKOUT_CENSORED', null, 1],
      ['UNKNOWN', null, 0],
    ]);
    expect(result.consumption.observedCanonicalUnits).toBe(12);
    expect(result.coverage).toMatchObject({
      censoredDays: 2,
      unknownDays: 1,
      observedDemandDays: 0,
    });
    expect(result.missingInputs.join(' ')).toMatch(/lack frozen canonical conversion/);
    expect(
      result.days.every((day) => day.knownAt === null && day.estimatedDemandUnits === null)
    ).toBe(true);
  });

  it('excludes wrong scope, ambiguous medicine, other reasons, out-of-period and future stockouts', async () => {
    const events = [
      stockout(),
      ...['organizationId', 'branchId', 'requestedMedicineId'].map((key) => ({
        ...stockout(),
        id: key,
        [key]: 'foreign',
      })),
      { ...stockout(), id: 'ambiguous', requestedMedicineId: null },
      { ...stockout(), id: 'reason', reason: 'PRICE' },
      { ...stockout(), id: 'before', createdAt: at('2026-09-09T23:59:59Z') },
      { ...stockout(), id: 'end', createdAt: at('2026-09-13T00:00:00Z') },
      { ...stockout(), id: 'future', createdAt: new Date(readAt.getTime() + 1) },
    ];
    const result = await readPharmacyDemandEvidence(database([], events).db, input, readAt);
    expect(result.coverage).toMatchObject({ censoredDays: 1, excludedStockoutCount: 8 });
    expect(result.days[1].stockoutEventCount).toBe(1);
  });

  it('uses UTC stockout capture date rather than local labels and includes exact readAt', async () => {
    const capture = at('2026-09-12T00:30:00+05:00');
    const result = await readPharmacyDemandEvidence(
      database([], [{ ...stockout(), createdAt: capture }]).db,
      input,
      capture
    );
    expect(result.days[1].state).toBe('STOCKOUT_CENSORED');
    expect(result.days[2].state).toBe('UNKNOWN');
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    'rejects unsafe frozen units: %s',
    async (canonicalUnits) => {
      await expect(
        readPharmacyDemandEvidence(database([{ ...line(), canonicalUnits }]).db, input, readAt)
      ).rejects.toThrow('safe integers');
    }
  );

  it.each([false, true])(
    'rejects aggregate overflow within/across dates: %s',
    async (acrossDates) => {
      const second = { ...line(), id: 'second', canonicalUnits: 1 };
      if (acrossDates)
        second.sale = {
          ...second.sale,
          businessDate: at('2026-09-11T00:00:00Z'),
          completedAt: at('2026-09-11T10:00:00Z'),
        };
      await expect(
        readPharmacyDemandEvidence(
          database([{ ...line(), canonicalUnits: Number.MAX_SAFE_INTEGER }, second]).db,
          input,
          readAt
        )
      ).rejects.toThrow('safe integers');
    }
  );

  it('fails duplicate source IDs instead of silently merging ambiguous rows', async () => {
    await expect(
      readPharmacyDemandEvidence(
        database([line(), { ...line(), canonicalUnits: 3 }]).db,
        input,
        readAt
      )
    ).rejects.toThrow('Duplicate consumption');
    await expect(
      readPharmacyDemandEvidence(database([], [stockout(), stockout()]).db, input, readAt)
    ).rejects.toThrow('Duplicate stockout');
  });

  it('fails capped sources without publishing partial totals', async () => {
    const tooManyLines = database(Array.from({ length: 10_001 }, line));
    await expect(readPharmacyDemandEvidence(tooManyLines.db, input, readAt)).rejects.toThrow(
      'Consumption row limit'
    );
    expect(tooManyLines.reads.unfulfilledDemandEvent.findMany).not.toHaveBeenCalled();
    await expect(
      readPharmacyDemandEvidence(
        database([], Array.from({ length: 10_001 }, stockout)).db,
        input,
        readAt
      )
    ).rejects.toThrow('Stockout row limit');
  });

  it.each([
    { organizationId: '' },
    { medicineId: ' ' },
    { branchId: 'x'.repeat(129) },
    { historyStartDate: '2026-02-30' },
    { originDate: '2026-09-10' },
    { historyStartDate: '2025-01-01' },
    { horizonDays: 0 },
    { horizonDays: 367 },
    { horizonDays: 1.5 },
    { method: 'OTHER' },
  ])('rejects invalid input before reading: %j', async (override) => {
    const { db, reads } = database();
    await expect(
      readPharmacyDemandEvidence(
        db,
        { ...input, ...override } as PharmacyDemandEvidenceReaderInput,
        readAt
      )
    ).rejects.toThrow();
    expect(reads.pharmacyBranch.findFirst).not.toHaveBeenCalled();
  });

  it('rejects invalid read/source instants and instant-valued business labels', async () => {
    await expect(readPharmacyDemandEvidence(database().db, input, at('invalid'))).rejects.toThrow(
      'valid read instant'
    );
    await expect(
      readPharmacyDemandEvidence(
        database([{ ...line(), createdAt: at('invalid') }]).db,
        input,
        readAt
      )
    ).rejects.toThrow('Invalid source timestamp');
    const badLabel = {
      ...line(),
      sale: { ...line().sale, businessDate: at('2026-09-10T01:00:00Z') },
    };
    await expect(
      readPharmacyDemandEvidence(database([badLabel]).db, input, readAt)
    ).rejects.toThrow('stored business-date label');
  });

  it('propagates read failures instead of returning all-clear or an empty forecast', async () => {
    const { db, reads } = database();
    reads.unfulfilledDemandEvent.findMany.mockRejectedValue(new Error('read failed'));
    await expect(readPharmacyDemandEvidence(db, input, readAt)).rejects.toThrow('read failed');
  });

  it('executes exactly four sequential reads, zero writes, with no personal-field projections', async () => {
    const { db, reads, forbidden } = database();
    const result = await readPharmacyDemandEvidence(db, input, readAt);
    const calls = [
      reads.pharmacyBranch.findFirst,
      reads.medicine.findFirst,
      reads.pharmacySaleLine.findMany,
      reads.unfulfilledDemandEvent.findMany,
    ];
    for (const call of calls) expect(call).toHaveBeenCalledTimes(1);
    const order = calls.map((call) => call.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(forbidden).not.toHaveBeenCalled();
    expect(reads.pharmacySaleLine.findMany.mock.calls[0][0].select).toEqual({
      id: true,
      organizationId: true,
      branchId: true,
      medicineId: true,
      canonicalUnits: true,
      createdAt: true,
      sale: {
        select: {
          organizationId: true,
          branchId: true,
          status: true,
          businessDate: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    });
    expect(reads.unfulfilledDemandEvent.findMany.mock.calls[0][0].select).toEqual({
      id: true,
      organizationId: true,
      branchId: true,
      requestedMedicineId: true,
      reason: true,
      createdAt: true,
    });
    expect(JSON.stringify(calls.map((call) => call.mock.calls))).not.toMatch(
      /patient|customer|prescription|payload|requestedText|capturedBy|quantity|packLevel|dailyClose/i
    );
    expect(JSON.stringify(result)).not.toMatch(/line-1|stockout-1|patient|customer|prescription/);
  });
});
