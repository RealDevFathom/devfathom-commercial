import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  AP_AGING_MAX_INVOICES,
  AP_PAYABLES_PAGE_ROWS,
  agingBucket,
  apAgingCsv,
  apAgingWindow,
  computeApAging,
  readApAging,
  type ApAgingInvoiceInput,
} from './ap-aging';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const d = (value: string) => new Date(value);

function invoice(overrides: Partial<ApAgingInvoiceInput> = {}): ApAgingInvoiceInput {
  return {
    id: 'inv_1',
    reference: 'AP-0001',
    payeeName: 'K-Electric',
    supplierInvoiceRef: 'KE-11',
    invoiceDate: d('2026-08-01T00:00:00.000Z'),
    dueDate: d('2026-08-31T00:00:00.000Z'),
    amountMinor: 100_000,
    currency: 'PKR',
    status: 'POSTED',
    reversedAt: null,
    settlements: [],
    ...overrides,
  };
}

describe('aging buckets', () => {
  it('uses inclusive boundaries at 0, 30, 60 and 90 days past due', () => {
    expect([-5, 0, 1, 30, 31, 60, 61, 90, 91].map(agingBucket)).toEqual([
      'CURRENT',
      'CURRENT',
      'DAYS_1_30',
      'DAYS_1_30',
      'DAYS_31_60',
      'DAYS_31_60',
      'DAYS_61_90',
      'DAYS_61_90',
      'DAYS_OVER_90',
    ]);
  });
});

describe('apAgingWindow', () => {
  it('is an inclusive UTC day with an exclusive next-day cutoff', () => {
    expect(apAgingWindow('2026-11-15', NOW)).toEqual({
      day: d('2026-11-15T00:00:00.000Z'),
      cutoff: d('2026-11-16T00:00:00.000Z'),
    });
  });

  it('ends the as-of day at the organization day boundary, and its today is the local day', () => {
    // 20:00 UTC on 15 Nov is already 16 Nov in Karachi, so the 16th is not in the future there.
    const late = d('2026-11-15T20:00:00.000Z');
    expect(apAgingWindow('2026-11-16', late, 'Asia/Karachi')).toEqual({
      day: d('2026-11-16T00:00:00.000Z'),
      cutoff: d('2026-11-16T19:00:00.000Z'),
    });
    expect(() => apAgingWindow('2026-11-16', late)).toThrow('INVALID_DATE');
  });

  it('refuses malformed, impossible, too-early or future days', () => {
    for (const bad of ['2026-11-16', '2026-02-30', '1999-12-31', '15-11-2026', '']) {
      expect(() => apAgingWindow(bad, NOW), bad).toThrow('INVALID_DATE');
    }
  });
});

describe('computeApAging', () => {
  const window = apAgingWindow('2026-11-15', NOW);

  it('ages exact outstanding amounts and totals each currency separately', () => {
    const view = computeApAging(
      [
        invoice({
          settlements: [
            {
              amountMinor: 30_001,
              paidAt: d('2026-09-01T00:00:00Z'),
              status: 'ACTIVE',
              reversedAt: null,
            },
          ],
        }),
        invoice({
          id: 'inv_2',
          reference: 'AP-0002',
          dueDate: d('2026-11-30T00:00:00Z'),
          amountMinor: 999,
          currency: 'USD',
        }),
      ],
      window,
      true
    );
    expect(
      view.rows.map((row) => [row.reference, row.outstandingMinor, row.daysPastDue, row.bucket])
    ).toEqual([
      ['AP-0001', 69_999, 76, 'DAYS_61_90'],
      ['AP-0002', 999, -15, 'CURRENT'],
    ]);
    expect(view.totals).toEqual([
      {
        currency: 'PKR',
        CURRENT: 0,
        DAYS_1_30: 0,
        DAYS_31_60: 0,
        DAYS_61_90: 69_999,
        DAYS_OVER_90: 0,
        TOTAL: 69_999,
      },
      {
        currency: 'USD',
        CURRENT: 999,
        DAYS_1_30: 0,
        DAYS_31_60: 0,
        DAYS_61_90: 0,
        DAYS_OVER_90: 0,
        TOTAL: 999,
      },
    ]);
  });

  it('applies the invoice clock: future-dated and already-reversed invoices are excluded', () => {
    const view = computeApAging(
      [
        invoice({
          id: 'later',
          invoiceDate: d('2026-11-16T00:00:00Z'),
          dueDate: d('2026-11-30T00:00:00Z'),
        }),
        invoice({ id: 'gone', status: 'REVERSED', reversedAt: d('2026-11-15T23:00:00Z') }),
        invoice({
          id: 'still',
          reference: 'AP-STILL',
          status: 'REVERSED',
          reversedAt: d('2026-11-16T00:00:00Z'),
        }),
      ],
      window,
      true
    );
    expect(view.rows.map((row) => row.invoiceId)).toEqual(['still']);
  });

  it('applies the payment clock: later payments and reversed payments do not reduce the balance', () => {
    const view = computeApAging(
      [
        invoice({
          settlements: [
            {
              amountMinor: 10,
              paidAt: d('2026-11-16T00:00:00Z'),
              status: 'ACTIVE',
              reversedAt: null,
            },
            {
              amountMinor: 20,
              paidAt: d('2026-09-01T00:00:00Z'),
              status: 'REVERSED',
              reversedAt: d('2026-10-01T00:00:00Z'),
            },
            {
              amountMinor: 40,
              paidAt: d('2026-09-01T00:00:00Z'),
              status: 'REVERSED',
              reversedAt: d('2026-11-16T00:00:00Z'),
            },
            {
              amountMinor: 80,
              paidAt: d('2026-11-15T23:59:59Z'),
              status: 'ACTIVE',
              reversedAt: null,
            },
          ],
        }),
      ],
      window,
      true
    );
    expect(view.rows[0]).toMatchObject({ paidMinor: 120, outstandingMinor: 100_000 - 120 });
  });

  it('omits fully paid invoices', () => {
    const view = computeApAging(
      [
        invoice({
          settlements: [
            {
              amountMinor: 100_000,
              paidAt: d('2026-09-01T00:00:00Z'),
              status: 'ACTIVE',
              reversedAt: null,
            },
          ],
        }),
      ],
      window,
      true
    );
    expect(view.rows).toEqual([]);
    expect(view.totals).toEqual([]);
  });

  it('shows the same historical view for an earlier as-of day', () => {
    const view = computeApAging(
      [
        invoice({
          settlements: [
            {
              amountMinor: 100_000,
              paidAt: d('2026-10-01T00:00:00Z'),
              status: 'ACTIVE',
              reversedAt: null,
            },
          ],
        }),
      ],
      apAgingWindow('2026-09-15', NOW),
      true
    );
    expect(view.rows).toMatchObject([
      { outstandingMinor: 100_000, daysPastDue: 15, bucket: 'DAYS_1_30' },
    ]);
  });
});

describe('computeApAging — DEV-694 credit-note set-offs', () => {
  it('reduces the bill by approved set-offs from their approval instant, apart from payments', () => {
    const input = invoice({
      settlements: [
        {
          amountMinor: 10_000,
          paidAt: d('2026-09-01T00:00:00Z'),
          status: 'ACTIVE',
          reversedAt: null,
        },
      ],
      creditSetOffs: [{ amountMinor: 25_000, decidedAt: d('2026-11-10T09:00:00Z') }],
    });
    const after = computeApAging([input], apAgingWindow('2026-11-15', NOW), true);
    expect(after.rows).toMatchObject([
      { paidMinor: 10_000, setOffMinor: 25_000, outstandingMinor: 65_000 },
    ]);
    expect(after.totals[0]!.TOTAL).toBe(65_000);
    const before = computeApAging([input], apAgingWindow('2026-11-09', NOW), true);
    expect(before.rows).toMatchObject([
      { paidMinor: 10_000, setOffMinor: 0, outstandingMinor: 90_000 },
    ]);
  });

  it('omits a bill that payments and set-offs clear together', () => {
    const view = computeApAging(
      [
        invoice({
          settlements: [
            {
              amountMinor: 60_000,
              paidAt: d('2026-09-01T00:00:00Z'),
              status: 'ACTIVE',
              reversedAt: null,
            },
          ],
          creditSetOffs: [{ amountMinor: 40_000, decidedAt: d('2026-11-01T00:00:00Z') }],
        }),
      ],
      apAgingWindow('2026-11-15', NOW),
      true
    );
    expect(view.rows).toEqual([]);
  });

  it('reads only approved (or later reversed) set-offs decided before the as-of cutoff', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { pharmacyApInvoice: { findMany } } as unknown as ScopedDb;
    await readApAging(db, { organizationId: 'org_1', branchId: 'branch_1' }, '2026-11-15', NOW);
    expect(findMany.mock.calls[0]![0].select.creditSetOffs.where).toEqual({
      status: { in: ['APPROVED', 'REVERSED'] },
      decidedAt: { lt: d('2026-11-16T00:00:00.000Z') },
    });
  });

  it('stops counting a reversed set-off from its reversal instant', () => {
    const input = invoice({
      creditSetOffs: [
        {
          amountMinor: 25_000,
          decidedAt: d('2026-11-01T09:00:00Z'),
          status: 'REVERSED',
          reversedAt: d('2026-11-10T09:00:00Z'),
        },
      ],
    });
    expect(computeApAging([input], apAgingWindow('2026-11-05', NOW), true).rows[0]).toMatchObject({
      setOffMinor: 25_000,
      outstandingMinor: 75_000,
    });
    expect(computeApAging([input], apAgingWindow('2026-11-15', NOW), true).rows[0]).toMatchObject({
      setOffMinor: 0,
      outstandingMinor: 100_000,
    });
  });

  it('reads every invoice in pages of 5,000 before ageing them', async () => {
    const first = Array.from({ length: AP_PAYABLES_PAGE_ROWS }, (_, index) =>
      invoice({ id: `inv_${index}`, reference: `AP-${String(index).padStart(5, '0')}` })
    );
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([invoice({ id: 'inv_last', reference: 'AP-99999' })]);
    const db = { pharmacyApInvoice: { findMany } } as unknown as ScopedDb;
    const view = await readApAging(
      db,
      { organizationId: 'org_1', branchId: 'branch_1' },
      '2026-11-15',
      NOW,
      null
    );
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0]![0]).toMatchObject({ take: 5_000 });
    expect(findMany.mock.calls[0]![0].cursor).toBeUndefined();
    expect(findMany.mock.calls[1]![0]).toMatchObject({
      take: 5_000,
      cursor: { id: `inv_${AP_PAYABLES_PAGE_ROWS - 1}` },
      skip: 1,
    });
    expect(view).toMatchObject({ complete: true, scannedInvoices: AP_PAYABLES_PAGE_ROWS + 1 });
    expect(view.rows).toHaveLength(AP_PAYABLES_PAGE_ROWS + 1);
  });
});

describe('readApAging', () => {
  it('reads only native invoices in the scoped branch with a bounded, eligibility-filtered query', async () => {
    const findMany = vi.fn().mockResolvedValue([invoice()]);
    const db = { pharmacyApInvoice: { findMany } } as unknown as ScopedDb;
    const view = await readApAging(
      db,
      { organizationId: 'org_1', branchId: 'branch_1' },
      '2026-11-15',
      NOW
    );
    const cutoff = d('2026-11-16T00:00:00.000Z');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_1',
          branchId: 'branch_1',
          invoiceDate: { lt: cutoff },
          OR: [{ status: 'POSTED' }, { reversedAt: { gte: cutoff } }],
        },
        take: AP_PAYABLES_PAGE_ROWS,
      })
    );
    expect(findMany.mock.calls[0]![0].select.settlements.where).toEqual({ paidAt: { lt: cutoff } });
    expect(view).toMatchObject({ complete: true, scannedInvoices: 1 });
  });

  it('refuses a view above the ceiling with no rows and no totals, never a partial one', async () => {
    const page = (start: number) =>
      Array.from({ length: AP_PAYABLES_PAGE_ROWS }, (_, index) =>
        invoice({ id: `inv_${start + index}`, reference: `AP-${start + index}` })
      );
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(page(0))
      .mockResolvedValueOnce(page(AP_PAYABLES_PAGE_ROWS))
      .mockResolvedValueOnce([invoice({ id: 'inv_over', reference: 'AP-over' })]);
    const db = { pharmacyApInvoice: { findMany } } as unknown as ScopedDb;
    const view = await readApAging(
      db,
      { organizationId: 'org_1', branchId: 'branch_1' },
      '2026-11-15',
      NOW
    );
    expect(AP_AGING_MAX_INVOICES).toBe(2 * AP_PAYABLES_PAGE_ROWS);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(view).toMatchObject({ complete: false, rows: [], totals: [] });
    expect(view.scannedInvoices).toBe(AP_AGING_MAX_INVOICES + 1);
  });

  it('narrows the read to one payee by its normalized key', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { pharmacyApInvoice: { findMany } } as unknown as ScopedDb;
    await readApAging(
      db,
      { organizationId: 'org_1', branchId: 'branch_1' },
      '2026-11-15',
      NOW,
      null,
      { payeeName: '  K-Electric   LTD ' }
    );
    expect(findMany.mock.calls[0]![0].where.payeeKey).toBe('k-electric ltd');
  });

  it('refuses a future as-of day before reading', async () => {
    const findMany = vi.fn();
    const db = { pharmacyApInvoice: { findMany } } as unknown as ScopedDb;
    await expect(
      readApAging(db, { organizationId: 'org_1', branchId: 'branch_1' }, '2026-11-16', NOW)
    ).rejects.toMatchObject({ reason: 'INVALID_DATE' });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('apAgingCsv', () => {
  it('exports exactly the rows of the view with its completeness and neutralizes formulas', () => {
    const view = computeApAging(
      [invoice({ payeeName: '=HYPERLINK("x")', supplierInvoiceRef: 'A,"B"' })],
      apAgingWindow('2026-11-15', NOW),
      false
    );
    const lines = apAgingCsv(view, 'branch_1').split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      '"branch_id","as_of_date","view_complete","reference","payee","supplier_invoice_ref","invoice_date","due_date","days_past_due","bucket","currency","invoice_amount_minor","paid_minor","outstanding_minor","set_off_minor"'
    );
    expect(lines[1]).toContain('"branch_1","2026-11-15","false","AP-0001"');
    expect(lines[1]).not.toContain('"=HYPERLINK');
    expect(lines[1]).toContain('"A,""B"""');
    expect(lines[1]).toContain('"76","DAYS_61_90","PKR","100000","0","100000"');
  });
});

it('keeps invoice date labels distinct from settlement instants on either side of UTC', () => {
  const at = new Date('2026-11-02T00:30:00+05:00');
  const row = invoice({ invoiceDate: new Date('2026-11-02'), dueDate: new Date('2026-11-02') });
  expect(
    computeApAging([row], apAgingWindow('2026-11-02', at, 'Asia/Karachi'), true).rows
  ).toHaveLength(1);
  expect(
    computeApAging([row], apAgingWindow('2026-11-01', at, 'America/New_York'), true).rows
  ).toHaveLength(0);
});
