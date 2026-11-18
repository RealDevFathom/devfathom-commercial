import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({
  dashboard: vi.fn(),
  digest: vi.fn(),
  anomalies: vi.fn(),
  expiry: vi.fn(),
  returns: vi.fn(),
  credits: vi.fn(),
  refresh: vi.fn(),
  createDraft: vi.fn(),
}));
vi.mock('./stock-signals-operations', () => ({
  roleDashboard: mocks.dashboard,
  ownerDigest: mocks.digest,
  refreshStockSignals: mocks.refresh,
  createDraftAction: mocks.createDraft,
}));
vi.mock('./anomaly-signals-operations', () => ({
  readPharmacyAnomalySignals: mocks.anomalies,
  refreshPharmacyAnomalySignals: mocks.refresh,
}));
vi.mock('./expiry-advisor-operations', () => ({
  readExpiryAdvice: mocks.expiry,
  proposeExpiryReturn: mocks.createDraft,
}));
vi.mock('./purchasing-console', () => ({
  listPurchaseReturns: mocks.returns,
  listSupplierCredits: mocks.credits,
}));

import {
  readPharmacyDailyWorkPack,
  type PharmacyDailyWorkPack,
  type PharmacyDailyWorkPackInput,
} from './daily-work-pack';

const at = new Date('2026-09-12T12:00:00Z');
const db = {} as ScopedDb;
const input: PharmacyDailyWorkPackInput = {
  organizationId: 'org_1',
  branchIds: ['branch_1'],
  actorId: 'actor_1',
  financial: true,
  from: '2026-09-01',
  to: '2026-09-10',
  asOf: '2026-09-11T12:00:00Z',
};
const digest = (branchId = 'branch_1') => ({
  branchId,
  ownerUserId: 'actor_1',
  overdue: [],
  dueSoon: [],
  stale: [],
  resuming: [],
  counts: { overdue: 0, dueSoon: 0, stale: 0, snoozed: 0 },
});
const anomaly = (id = 'signal_1') => ({
  id,
  organizationId: 'org_1',
  branchId: 'branch_1',
  kind: 'CASH_VARIANCE',
  status: 'STALE',
  sourceObservedAt: new Date('2026-09-10T01:00:00Z'),
  computedAt: new Date('2026-09-10T02:00:00Z'),
  freshnessSeconds: 3600,
  exactNumbers: {
    varianceMinor: -340,
    expectedMinor: 1000,
    countedMinor: 660,
    secretMinor: 900000,
  },
  scope: { userId: 'private_user' },
  explanation: 'private_person phone email PKR 123',
  dedupKey: 'private_user',
});
const expiry = () => ({
  branchId: 'branch_1',
  lotId: 'lot_1',
  classification: 'INSUFFICIENT_HISTORY',
  onHandUnits: 4,
  projectedUnsoldUnits: 4,
  historyDays: 0,
  valueAtRiskMinor: 1234,
  expiresAt: new Date('2026-10-01T00:00:00Z'),
  returnWindowDays: null,
  proposalAllowed: false,
  explanation: 'private_person PKR 12.34',
  supplierName: 'private_person',
});
const allEvidence = (pack: PharmacyDailyWorkPack) =>
  pack.groups.flatMap((group) => group.tasks.flatMap((task) => task.evidence));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.dashboard.mockResolvedValue([]);
  mocks.digest.mockImplementation(async (_db, scope) => digest(scope.branchId));
  mocks.anomalies.mockResolvedValue([]);
  mocks.expiry.mockResolvedValue([]);
  mocks.returns.mockResolvedValue([]);
  mocks.credits.mockResolvedValue([]);
});

describe('daily Pharmacy work pack source composition', () => {
  it('exposes a typed read-only contract and never treats empty sources as all clear', async () => {
    const pack = await readPharmacyDailyWorkPack(db, input, at);
    expectTypeOf(pack).toEqualTypeOf<PharmacyDailyWorkPack>();
    expect(pack).toMatchObject({
      mode: 'read-only-preparation',
      completeness: {
        allClear: false,
        status: 'unknown',
        uniqueProblemCount: null,
        additiveSavings: false,
      },
    });
    expect(pack.sources).toHaveLength(5);
    for (const group of pack.groups) {
      const link = new URL(group.tasks[0].nextActions[0].href, 'https://example.test');
      expect(link.searchParams.get('branch')).toBe('branch_1');
      expect(link.searchParams.has('branchId')).toBe(false);
      expect(link.searchParams.has('section')).toBe(false);
      expect(link.pathname).toBe(
        group.key === 'supplier-credit-review'
          ? '/pharmacy/purchasing/returns'
          : '/pharmacy/reports'
      );
    }
    expect(
      pack.sources.every((source) =>
        source.missingInputs.some(
          (reason) =>
            reason === 'No items were returned by this check; other items may still need attention.'
        )
      )
    ).toBe(true);
  });

  it('does not query or expose financial sources, amounts or metadata without permission', async () => {
    mocks.anomalies.mockResolvedValue([anomaly()]);
    mocks.expiry.mockResolvedValue([expiry()]);
    mocks.dashboard.mockResolvedValue([
      {
        kind: 'LOW_STOCK',
        ownerUserId: 'private_user',
        open: 2,
        acknowledged: 0,
        snoozed: 0,
        stale: 0,
        overdue: 1,
      },
    ]);
    const pack = await readPharmacyDailyWorkPack(db, { ...input, financial: false }, at);
    expect(pack.sources.map((source) => source.kind)).toEqual(['stock-dashboard', 'stock-digest']);
    for (const fn of [mocks.anomalies, mocks.expiry, mocks.returns, mocks.credits])
      expect(fn).not.toHaveBeenCalled();
    const json = JSON.stringify(pack);
    for (const forbidden of [
      'private_user',
      'supplier-credit',
      'anomalies',
      'Minor',
      'currency',
      'amounts',
    ])
      expect(json).not.toContain(forbidden);
    expect(allEvidence(pack)[0].counts.open).toBe(2);
  });

  it('preserves source windows, clocks, unbounded readers and explicit scope', async () => {
    const pack = await readPharmacyDailyWorkPack(db, input, at);
    expect(mocks.dashboard).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_1', branchId: 'branch_1' },
      new Date(input.asOf)
    );
    expect(mocks.digest).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_1', branchId: 'branch_1' },
      'actor_1',
      new Date(input.asOf)
    );
    expect(mocks.anomalies).toHaveBeenCalledWith(db, {
      branchIds: ['branch_1'],
      from: input.from,
      to: input.to,
    });
    expect(mocks.expiry).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_1', branchIds: ['branch_1'] },
      new Date(input.asOf)
    );
    expect(mocks.returns).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_1', branchId: 'branch_1' },
      { at: new Date(input.asOf) }
    );
    expect(pack.sources.find((source) => source.kind === 'expiry')).toMatchObject({
      rowLimit: null,
      freshness: 'live-inputs-not-historical',
      window: { from: '2026-08-12T12:00:00.000Z', toExclusive: '2026-09-11T12:00:00.000Z' },
    });
    expect(pack.sources.find((source) => source.kind === 'anomalies')).toMatchObject({
      rowLimit: 200,
      evaluatedAsOf: null,
      window: { from: '2026-09-01T00:00:00.000Z', toExclusive: '2026-09-11T00:00:00.000Z' },
    });
  });

  it('surfaces the 200 cap and preserves safe source money, negative variance and unknown currency', async () => {
    mocks.anomalies.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => anomaly(`signal_${i}`))
    );
    const pack = await readPharmacyDailyWorkPack(db, input, at);
    expect(pack.sources.find((source) => source.kind === 'anomalies')).toMatchObject({
      rowLimit: 200,
      returnedRows: 200,
      limitReached: true,
      coverage: 'partial',
    });
    expect(pack.completeness.status).toBe('partial');
    expect(allEvidence(pack)[0]).toMatchObject({
      observedAt: '2026-09-10T01:00:00.000Z',
      computedAt: '2026-09-10T02:00:00.000Z',
      freshnessSeconds: 3600,
      amounts: expect.arrayContaining([
        {
          key: 'varianceMinor',
          value: -340,
          unit: 'minor',
          currency: null,
          definition: 'Counted less expected cash; not profit.',
        },
      ]),
    });
    for (const forbidden of ['private_user', 'private_person', 'secretMinor', 'PKR'])
      expect(JSON.stringify(pack)).not.toContain(forbidden);
  });

  it('groups overlapping stock, expiry and shrinkage evidence without counting distinct problems', async () => {
    const entry = {
      signalId: 'stock_1',
      status: 'STALE',
      dueAt: at,
      confidence: 'PARTIAL',
      explanation: 'private_person',
    };
    mocks.digest.mockResolvedValue({ ...digest(), stale: [entry, entry] });
    mocks.expiry.mockResolvedValue([expiry()]);
    mocks.anomalies.mockResolvedValue([
      { ...anomaly(), kind: 'SHRINKAGE', exactNumbers: { missingUnits: 4 } },
    ]);
    const pack = await readPharmacyDailyWorkPack(db, input, at);
    const tasks = pack.groups.find((group) => group.key === 'inventory-review')!.tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].evidence).toHaveLength(3);
    expect(
      tasks[0].evidence.find((item) => item.reference.kind === 'lot')!.missingInputs
    ).toContain('Supplier return window is not recorded.');
    expect(pack.completeness).toMatchObject({ uniqueProblemCount: null, additiveSavings: false });
  });

  it('reuses supplier follow-up calculations and excludes malformed records without zeroing amounts', async () => {
    mocks.returns.mockResolvedValue([
      {
        organizationId: 'org_1',
        branchId: 'branch_1',
        id: 'return_1',
        supplierId: 'supplier_1',
        supplier: { name: 'private_person' },
        reference: 'private_person',
        status: 'DISPATCHED',
        dispatchedAt: at,
        lines: [],
        debitNotes: [
          {
            organizationId: 'org_1',
            branchId: 'branch_1',
            id: 'note_1',
            supplierId: 'supplier_1',
            purchaseReturnId: 'return_1',
            reference: 'private_person',
            status: 'OPEN',
            cancelledAt: null,
            issuedAt: new Date('2026-09-01T12:00:00Z'),
            expectedCreditMinor: 500,
            allocations: [{ organizationId: 'org_1', debitNoteId: 'note_1', amountMinor: 125 }],
          },
        ],
      },
    ]);
    mocks.credits.mockResolvedValue([
      {
        organizationId: 'foreign_org',
        branchId: 'branch_1',
        id: 'foreign_credit',
        supplierId: 'supplier_1',
        amountMinor: 50,
        allocations: [],
      },
    ]);
    const pack = await readPharmacyDailyWorkPack(db, input, at);
    const claim = allEvidence(pack).find((item) => item.reference.kind === 'debit-note')!;
    expect(claim.counts.ageDays).toBe(10);
    expect(claim.amounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'outstandingMinor', value: 375 }),
        expect.objectContaining({ key: 'allocatedMinor', value: 125 }),
      ])
    );
    expect(pack.sources.find((source) => source.kind === 'supplier-credit')!.coverage).toBe(
      'partial'
    );
    expect(JSON.stringify(pack)).not.toContain('private_person');
    expect(JSON.stringify(pack)).not.toContain('foreign_credit');
  });

  it('keeps available evidence on source error without exposing database messages', async () => {
    mocks.anomalies.mockRejectedValue(new Error('private_person database password'));
    mocks.expiry.mockResolvedValue([expiry()]);
    const pack = await readPharmacyDailyWorkPack(db, input, at);
    expect(pack.sources.find((source) => source.kind === 'anomalies')).toMatchObject({
      status: 'unavailable',
      returnedRows: null,
    });
    expect(allEvidence(pack).some((item) => item.reference.id === 'lot_1')).toBe(true);
    expect(JSON.stringify(pack)).not.toContain('password');
  });

  it('explains an expiry reader failure without reporting empty stock or losing other evidence', async () => {
    mocks.expiry.mockRejectedValue(new Error('private_person database password'));
    mocks.anomalies.mockResolvedValue([anomaly()]);
    const pack = await readPharmacyDailyWorkPack(db, input, at);
    expect(pack.sources.find((source) => source.kind === 'expiry')).toMatchObject({
      status: 'unavailable',
      coverage: 'partial',
      returnedRows: null,
      missingInputs: expect.arrayContaining([
        'Expiry advice could not load; refresh to try again.',
      ]),
    });
    expect(pack.completeness.status).toBe('partial');
    expect(allEvidence(pack).some((item) => item.reference.id === 'signal_1')).toBe(true);
    expect(allEvidence(pack).some((item) => item.reference.kind === 'lot')).toBe(false);
    expect(JSON.stringify(pack)).not.toContain('password');
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it.each(['branch', 'tenant'])(
    'rejects cross-%s source results and removes partly projected rows',
    async (kind) => {
      mocks.anomalies.mockResolvedValue([
        anomaly(),
        {
          ...anomaly('foreign'),
          ...(kind === 'branch' ? { branchId: 'branch_other' } : { organizationId: 'org_other' }),
        },
      ]);
      const pack = await readPharmacyDailyWorkPack(db, input, at);
      expect(allEvidence(pack)).toHaveLength(0);
      expect(pack.sources.find((source) => source.kind === 'anomalies')!.status).toBe(
        'unavailable'
      );
      expect(JSON.stringify(pack)).not.toContain('foreign');
    }
  );

  it('does not turn unknown or unsafe source amounts into zero', async () => {
    mocks.expiry.mockResolvedValue([
      { ...expiry(), valueAtRiskMinor: Number.MAX_SAFE_INTEGER + 1 },
    ]);
    const pack = await readPharmacyDailyWorkPack(db, input, at);
    const item = allEvidence(pack)[0];
    expect(item.amounts).toBeUndefined();
    expect(item.missingInputs).toContain('Valid source amount required: valueAtRiskMinor.');
  });

  it('keeps branch evidence separate and repeated reads create zero actions', async () => {
    const scoped = { ...input, branchIds: ['branch_1', 'branch_2'] };
    const first = await readPharmacyDailyWorkPack(db, scoped, at);
    const second = await readPharmacyDailyWorkPack(db, scoped, at);
    expect(second).toEqual(first);
    expect(first.sources).toHaveLength(10);
    expect(first.groups[0].tasks.map((task) => task.branchId)).toEqual(['branch_1', 'branch_2']);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it.each([
    { from: '2026-02-30' },
    { from: '2026-01-01' },
    { branchIds: [] },
    { branchIds: ['branch_1', 'branch_1'] },
    { asOf: 'invalid' },
    { asOf: '2027-01-01T00:00:00Z' },
  ])('rejects invalid scoped input before readers: %j', async (overrides) => {
    await expect(readPharmacyDailyWorkPack(db, { ...input, ...overrides }, at)).rejects.toThrow();
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });
});
