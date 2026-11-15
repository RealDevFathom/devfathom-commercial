import { describe, expect, it } from 'vitest';
import { reconcileInputTaxBills, type InputTaxBill } from './input-tax-reconciliation';

const line = {
  receivedPacks: 10,
  invoicedPricePerPackMinor: 1_000,
  discountBps: 1_000,
  taxBps: 1_800,
  taxCreditable: true,
};

function bill(overrides: Partial<InputTaxBill> = {}): InputTaxBill {
  return {
    id: 'bill-1',
    reference: 'GR-001',
    supplierInvoiceRef: 'INV-001',
    supplier: { name: 'Karachi Distributors' },
    distributorNtn: '1234567-8',
    distributorStrn: '12-34-5678-901-23',
    status: 'POSTED',
    lines: [line],
    ...overrides,
  };
}

describe('purchase bill input-tax reconciliation', () => {
  it('flags each missing distributor identifier and reconciles fixture claims', () => {
    const report = reconcileInputTaxBills([
      bill(),
      bill({ id: 'bill-2', distributorNtn: null }),
      bill({ id: 'bill-3', distributorStrn: '  ', lines: [{ ...line, taxCreditable: false }] }),
    ]);

    expect(
      report.rows.map(({ id, flagged, missing, claimMinor }) => ({
        id,
        flagged,
        missing,
        claimMinor,
      }))
    ).toEqual([
      { id: 'bill-1', flagged: false, missing: [], claimMinor: 1_620 },
      { id: 'bill-2', flagged: true, missing: ['NTN'], claimMinor: 1_620 },
      { id: 'bill-3', flagged: false, missing: ['STRN'], claimMinor: 0 },
    ]);
    expect(report).toMatchObject({
      flaggedBillCount: 1,
      claimedInputTaxMinor: 3_240,
      flaggedClaimMinor: 1_620,
    });
  });

  it.each([
    ['draft', { status: 'DRAFT' }],
    ['reversed', { status: 'REVERSED' }],
    ['no lines', { lines: [] }],
    ['non-creditable', { lines: [{ ...line, taxCreditable: false }] }],
    ['zero-rated', { lines: [{ ...line, taxBps: 0 }] }],
    ['fully discounted', { lines: [{ ...line, discountBps: 10_000 }] }],
    ['rounded to zero', { lines: [{ ...line, receivedPacks: 1, invoicedPricePerPackMinor: 1 }] }],
  ] satisfies [string, Partial<InputTaxBill>][])(
    'does not flag a %s bill with blank tax identifiers and no input-tax claim',
    (_reason, overrides) => {
      const report = reconcileInputTaxBills([
        bill({ distributorNtn: null, distributorStrn: '  ', ...overrides }),
      ]);

      expect(report).toMatchObject({
        rows: [{ missing: ['NTN', 'STRN'], flagged: false, claimMinor: 0 }],
        flaggedBillCount: 0,
        claimedInputTaxMinor: 0,
        flaggedClaimMinor: 0,
      });
    }
  );

  it.each([
    [null, null, ['NTN', 'STRN']],
    ['  ', '12345', ['NTN']],
    ['1234567-8', '', ['STRN']],
  ])('flags a one-paisa claim with missing identifiers (%s, %s)', (ntn, strn, missing) => {
    const report = reconcileInputTaxBills([
      bill({
        distributorNtn: ntn,
        distributorStrn: strn,
        lines: [{ ...line, receivedPacks: 1, invoicedPricePerPackMinor: 6, discountBps: 0 }],
      }),
    ]);

    expect(report).toMatchObject({
      rows: [{ missing, flagged: true, claimMinor: 1 }],
      flaggedBillCount: 1,
      claimedInputTaxMinor: 1,
      flaggedClaimMinor: 1,
    });
  });

  it('keeps supplier names and both references for reconciliation rows', () => {
    const report = reconcileInputTaxBills([bill({ distributorNtn: null })]);

    expect(report.rows).toEqual([
      {
        id: 'bill-1',
        supplierName: 'Karachi Distributors',
        reference: 'GR-001',
        supplierInvoiceRef: 'INV-001',
        missing: ['NTN'],
        flagged: true,
        claimMinor: 1_620,
      },
    ]);
  });

  it('does not claim tax from draft, reversed, cancelled, or non-creditable bills', () => {
    const report = reconcileInputTaxBills([
      bill({ id: 'draft', status: 'DRAFT' }),
      bill({ id: 'reversed', status: 'REVERSED' }),
      bill({ id: 'cancelled', status: 'CANCELLED' }),
      bill({ id: 'cost-tax', lines: [{ ...line, taxCreditable: false }] }),
    ]);
    expect(report.claimedInputTaxMinor).toBe(0);
    expect(report.rows.map((row) => row.id)).toEqual(['draft', 'reversed', 'cost-tax']);
  });
});
