import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  AP_AGING_MAX_INVOICES,
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
        take: AP_AGING_MAX_INVOICES + 1,
      })
    );
    expect(findMany.mock.calls[0]![0].select.settlements.where).toEqual({ paidAt: { lt: cutoff } });
    expect(view).toMatchObject({ complete: true, scannedInvoices: 1 });
  });

  it('reports an incomplete view when the bound is exceeded and never ages past it', async () => {
    const rows = Array.from({ length: AP_AGING_MAX_INVOICES + 1 }, (_, index) =>
      invoice({ id: `inv_${index}`, reference: `AP-${String(index).padStart(5, '0')}` })
    );
    const db = {
      pharmacyApInvoice: { findMany: vi.fn().mockResolvedValue(rows) },
    } as unknown as ScopedDb;
    const view = await readApAging(
      db,
      { organizationId: 'org_1', branchId: 'branch_1' },
      '2026-11-15',
      NOW
    );
    expect(view.complete).toBe(false);
    expect(view.scannedInvoices).toBe(AP_AGING_MAX_INVOICES);
    expect(view.rows).toHaveLength(AP_AGING_MAX_INVOICES);
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
      '"branch_id","as_of_date","view_complete","reference","payee","supplier_invoice_ref","invoice_date","due_date","days_past_due","bucket","currency","invoice_amount_minor","paid_minor","outstanding_minor"'
    );
    expect(lines[1]).toContain('"branch_1","2026-11-15","false","AP-0001"');
    expect(lines[1]).not.toContain('"=HYPERLINK');
    expect(lines[1]).toContain('"A,""B"""');
    expect(lines[1]).toContain('"76","DAYS_61_90","PKR","100000","0","100000"');
  });
});
