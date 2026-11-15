import { describe, expect, it, vi } from 'vitest';

import {
  BACK_IN_STOCK_DEFAULTS,
  BackInStockTemplateError,
  backInStockQueue,
  backInStockReference,
  backInStockTemplateParameters,
  captureReceiptArrivals,
  isRestockRequestExpired,
  readBackInStockPolicy,
  selectRecoveryLine,
  summarizeLostSalesRecovery,
  templateNamesProduct,
} from './back-in-stock';

const DAY = 86_400_000;
const NOW = new Date('2026-11-15T10:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const policy = BACK_IN_STOCK_DEFAULTS;

describe('DEV-79 back-in-stock policy', () => {
  it('defaults to the research windows and reads overrides from configuration', () => {
    expect(readBackInStockPolicy({})).toEqual({ requestExpiryDays: 14, recoveryWindowDays: 7 });
    expect(
      readBackInStockPolicy({
        PHARMACY_BACK_IN_STOCK_REQUEST_EXPIRY_DAYS: '21',
        PHARMACY_BACK_IN_STOCK_RECOVERY_WINDOW_DAYS: '3',
      })
    ).toEqual({ requestExpiryDays: 21, recoveryWindowDays: 3 });
  });

  it('falls back to the defaults for invalid configured windows', () => {
    for (const raw of ['0', '-1', '1.5', 'abc', '91']) {
      expect(
        readBackInStockPolicy({
          PHARMACY_BACK_IN_STOCK_REQUEST_EXPIRY_DAYS: raw,
          PHARMACY_BACK_IN_STOCK_RECOVERY_WINDOW_DAYS: raw,
        })
      ).toEqual(BACK_IN_STOCK_DEFAULTS);
    }
  });
});

describe('DEV-79 back-in-stock template', () => {
  const forbidden = ['Panadol Extra 500mg', 'Paracetamol', 'Caffeine', 'panadol'];

  it('carries only the branch, request date and an opaque reference', () => {
    const parameters = backInStockTemplateParameters(
      { branchName: '  Gulberg   Branch ', requestedOn: '2026-11-03', interestId: 'interest-1' },
      forbidden
    );
    expect(parameters).toEqual([
      'Gulberg Branch',
      '2026-11-03',
      backInStockReference('interest-1'),
    ]);
    expect(parameters[2]).toMatch(/^[A-Z2-9]{8}$/);
    expect(templateNamesProduct(parameters, forbidden)).toBe(false);
    for (const text of parameters)
      for (const term of forbidden) expect(text.toLowerCase()).not.toContain(term.toLowerCase());
  });

  it('never produces template variables containing a product, salt or category name', () => {
    for (const branchName of [
      'Panadol Corner',
      'PARACETAMOL point',
      'Caffeine Hub',
      'Antibiotic Store',
      'Insulin Point',
      'Vitamin House',
    ]) {
      expect(() =>
        backInStockTemplateParameters(
          { branchName, requestedOn: '2026-11-03', interestId: 'interest-1' },
          forbidden
        )
      ).toThrow(BackInStockTemplateError);
    }
  });

  it('refuses a malformed date or empty branch rather than send free text', () => {
    expect(() =>
      backInStockTemplateParameters(
        { branchName: 'Main', requestedOn: 'Panadol on 3 Nov', interestId: 'interest-1' },
        []
      )
    ).toThrow(BackInStockTemplateError);
    expect(() =>
      backInStockTemplateParameters(
        { branchName: ' ', requestedOn: '2026-11-03', interestId: 'interest-1' },
        []
      )
    ).toThrow(BackInStockTemplateError);
  });

  it('derives a stable reference from the request id alone', () => {
    expect(backInStockReference('interest-1')).toBe(backInStockReference('interest-1'));
    expect(backInStockReference('interest-1')).not.toBe(backInStockReference('interest-2'));
  });
});

describe('DEV-79 back-in-stock queue', () => {
  it('serves waiting requests first-in, first-out', () => {
    const { queue } = backInStockQueue(
      [
        { id: 'c', status: 'OPEN', createdAt: ago(1) },
        { id: 'b', status: 'OPEN', createdAt: ago(5) },
        { id: 'a', status: 'OPEN', createdAt: ago(5) },
        { id: 'd', status: 'OPEN', createdAt: ago(3) },
      ],
      NOW,
      policy
    );
    expect(queue.map((request) => request.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('notifies each request once: already notified, recovered or opted-out requests are skipped', () => {
    const { queue } = backInStockQueue(
      [
        { id: 'open', status: 'OPEN', createdAt: ago(2) },
        { id: 'notified', status: 'NOTIFIED', createdAt: ago(3) },
        { id: 'recovered', status: 'RECOVERED', createdAt: ago(3) },
        { id: 'opted-out', status: 'OPTED_OUT', createdAt: ago(3) },
      ],
      NOW,
      policy
    );
    expect(queue.map((request) => request.id)).toEqual(['open']);
  });

  it('expires requests after 14 days', () => {
    expect(isRestockRequestExpired(ago(13.99), NOW, policy)).toBe(false);
    expect(isRestockRequestExpired(ago(14), NOW, policy)).toBe(true);
    const { queue, expired } = backInStockQueue(
      [
        { id: 'fresh', status: 'OPEN', createdAt: ago(13) },
        { id: 'stale', status: 'OPEN', createdAt: ago(15) },
      ],
      NOW,
      policy
    );
    expect(queue.map((request) => request.id)).toEqual(['fresh']);
    expect(expired.map((request) => request.id)).toEqual(['stale']);
  });

  it('honours a configured expiry window', () => {
    const { queue } = backInStockQueue(
      [{ id: 'request', status: 'OPEN', createdAt: ago(15) }],
      NOW,
      { ...policy, requestExpiryDays: 30 }
    );
    expect(queue).toHaveLength(1);
  });
});

describe('DEV-79 recovery linking', () => {
  const notifiedAt = ago(10);
  const request = { medicineId: 'med-a', patientId: 'patient-a', notifiedAt };
  const at = (days: number) => new Date(notifiedAt.getTime() + days * DAY);
  const line = (
    id: string,
    days: number,
    overrides: Partial<{ medicineId: string; patientId: string | null }> = {}
  ) => ({
    saleLineId: id,
    saleId: `sale-${id}`,
    medicineId: 'med-a',
    patientId: null as string | null,
    completedAt: at(days),
    ...overrides,
  });

  it('links a sale of the same SKU within 7 days of the notice', () => {
    expect(selectRecoveryLine(request, [line('l1', 6.5)], policy)?.saleLineId).toBe('l1');
    expect(selectRecoveryLine(request, [line('l1', 7)], policy)?.saleLineId).toBe('l1');
  });

  it('does not link sales before the notice, after 7 days, or of another SKU', () => {
    expect(
      selectRecoveryLine(
        request,
        [line('before', -0.1), line('late', 7.01), line('other', 1, { medicineId: 'med-b' })],
        policy
      )
    ).toBeNull();
  });

  it('prefers the customer who asked, then the earliest sale', () => {
    const chosen = selectRecoveryLine(
      request,
      [line('walk-in', 1), line('customer', 4, { patientId: 'patient-a' }), line('walk-in-2', 2)],
      policy
    );
    expect(chosen?.saleLineId).toBe('customer');
    expect(
      selectRecoveryLine(request, [line('second', 2), line('first', 1)], policy)?.saleLineId
    ).toBe('first');
  });

  it('honours a configured recovery window', () => {
    expect(
      selectRecoveryLine(request, [line('l1', 9)], { ...policy, recoveryWindowDays: 10 })
        ?.saleLineId
    ).toBe('l1');
  });
});

describe('DEV-79 lost-sales dashboard totals', () => {
  const fixtures = [
    {
      branchId: 'b1',
      branchName: 'Main',
      salts: ['Paracetamol'],
      distributor: 'Muller & Phipps',
      estimatedLostMinor: 50_000,
      recoveredMinor: 45_000,
    },
    {
      branchId: 'b1',
      branchName: 'Main',
      salts: ['Paracetamol', 'Caffeine'],
      distributor: 'Muller & Phipps',
      estimatedLostMinor: 30_000,
      recoveredMinor: 0,
    },
    {
      branchId: 'b2',
      branchName: 'Gulberg',
      salts: ['Amoxicillin'],
      distributor: 'United Distributors',
      estimatedLostMinor: 120_000,
      recoveredMinor: 20_000,
    },
    {
      branchId: 'b2',
      branchName: 'Gulberg',
      salts: [],
      distributor: null,
      estimatedLostMinor: null,
      recoveredMinor: 0,
    },
  ];

  it('totals estimated lost, recovered and net', () => {
    const summary = summarizeLostSalesRecovery(fixtures);
    expect(summary.totals).toEqual({
      estimatedLostMinor: 200_000,
      recoveredMinor: 65_000,
      netMinor: 135_000,
      events: 4,
      recoveredEvents: 2,
    });
    expect(summary.missingEstimates).toBe(1);
  });

  it('groups by branch, salt and distributor, ranked by net still lost', () => {
    const summary = summarizeLostSalesRecovery(fixtures);
    expect(
      summary.byBranch.map(({ label, estimatedLostMinor, recoveredMinor, netMinor, events }) => ({
        label,
        estimatedLostMinor,
        recoveredMinor,
        netMinor,
        events,
      }))
    ).toEqual([
      {
        label: 'Gulberg',
        estimatedLostMinor: 120_000,
        recoveredMinor: 20_000,
        netMinor: 100_000,
        events: 2,
      },
      {
        label: 'Main',
        estimatedLostMinor: 80_000,
        recoveredMinor: 45_000,
        netMinor: 35_000,
        events: 2,
      },
    ]);
    expect(
      Object.fromEntries(
        summary.bySalt.map((row) => [
          row.label,
          [row.estimatedLostMinor, row.recoveredMinor, row.netMinor],
        ])
      )
    ).toEqual({
      Amoxicillin: [120_000, 20_000, 100_000],
      Paracetamol: [80_000, 45_000, 35_000],
      Caffeine: [30_000, 0, 30_000],
      'Unresolved salt': [0, 0, 0],
    });
    expect(
      Object.fromEntries(
        summary.byDistributor.map((row) => [
          row.label,
          [row.estimatedLostMinor, row.recoveredMinor, row.netMinor],
        ])
      )
    ).toEqual({
      'United Distributors': [120_000, 20_000, 100_000],
      'Muller & Phipps': [80_000, 45_000, 35_000],
      'Unknown distributor': [0, 0, 0],
    });
    // Branch and distributor groups partition the totals.
    const sum = (rows: { netMinor: number }[]) => rows.reduce((n, row) => n + row.netMinor, 0);
    expect(sum(summary.byBranch)).toBe(summary.totals.netMinor);
    expect(sum(summary.byDistributor)).toBe(summary.totals.netMinor);
  });
});

describe('DEV-79 goods receipt arrivals', () => {
  it('captures each received lot once and never lets one failure stop the rest', async () => {
    const capture = vi.fn(async (lot: string) => {
      if (lot === 'lot-b') throw new Error('UNSAFE_STOCK');
    });
    const onError = vi.fn();
    const failed = await captureReceiptArrivals(
      ['lot-a', 'lot-b', 'lot-a', 'lot-c'],
      capture,
      onError
    );
    expect(capture.mock.calls.map(([lot]) => lot)).toEqual(['lot-a', 'lot-b', 'lot-c']);
    expect(failed).toEqual(['lot-b']);
    expect(onError).toHaveBeenCalledWith('lot-b', expect.any(Error));
  });
});
