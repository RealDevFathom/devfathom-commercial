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
      { id: 'bill-3', flagged: true, missing: ['STRN'], claimMinor: 0 },
    ]);
    expect(report).toMatchObject({
      flaggedBillCount: 2,
      claimedInputTaxMinor: 3_240,
      flaggedClaimMinor: 1_620,
    });
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
