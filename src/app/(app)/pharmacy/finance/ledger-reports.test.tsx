import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeakageLedger, MarginLedger, ValuationLedger } from './ledger-reports';
import type { ComponentProps } from 'react';

const metadata = {
  scope: { organizationId: 'org', branchId: 'branch-id', branchName: 'SehatCart Main' },
  timezone: 'Asia/Karachi', currency: 'PKR', currencyStatus: 'organization_setting',
  moneyUnit: 'integer_minor', definition: 'Recorded entries; no inferred expiry exposure or causes.',
  source: 'finance_journal_lines', coverage: { completeness: 'unknown', costCoverage: 'unknown' },
  freshness: { retrievedAt: new Date('2026-11-02T21:30:00Z'), latestPostingAt: null },
};
const valuation = (values: number[]) => ({
  ...metadata, period: { at: new Date('2026-11-02T21:30:00Z'), bounds: 'through_inclusive' },
  rows: values.map((valueMinor, i) => ({
    branchId: 'branch-id', branchName: 'SehatCart Main', lotId: `lot-id-${i}`,
    lotReference: `INV-${i}`, manufacturingBatchId: `batch-id-${i}`, batchNumber: `BATCH-${i}`,
    medicineId: 'medicine-id', medicineName: 'Paracetamol', locationId: 'location-id',
    locationName: 'Front shelf', unitCostMinor: 4500, valueMinor,
  })),
}) as ComponentProps<typeof ValuationLedger>['report'];

describe('readable signed finance reports', () => {
  it('keeps negative net valuation visible despite positive current unit costs', () => {
    render(<ValuationLedger report={valuation([-45000, 22500])} />);
    expect(screen.getByText('PKR -225.00')).toBeVisible();
    expect(screen.getByText('PKR -450.00')).toBeVisible();
    expect(screen.getAllByText('PKR 45.00')).toHaveLength(2);
    expect(screen.getByText('BATCH-0')).toBeVisible();
    expect(screen.getByText('Receipt INV-0')).toBeVisible();
    expect(screen.getAllByText('Paracetamol')[0]).toBeVisible();
    expect(screen.getAllByText('Front shelf')[0]).toBeVisible();
    expect(screen.getByText('lot-id-0')).not.toBeVisible();
    expect(screen.getAllByText(/3 Nov 2026, 02:30/)[0]).toBeVisible();
  });
  it('cannot total positive rows to a negative inventory balance', () => {
    render(<ValuationLedger report={valuation([45000, 22500])} />);
    expect(screen.getByText('PKR 675.00')).toBeVisible();
    expect(screen.queryByText('PKR -225.00')).toBeNull();
  });
  it('retains revenue, reversed discounts and zero recorded COGS for batchless refunds', () => {
    const report = { ...metadata, by: 'batch', period: { from: new Date('2026-11-01Z'), to: new Date('2026-11-03Z') }, rows: [
      { key: null, label: 'Refunds without batch', revenueMinor: -35400, discountMinor: -24500, cogsMinor: 0, grossMarginMinor: -10900 },
      { key: 'batch-id', label: 'B-123 · Paracetamol', revenueMinor: 10000, discountMinor: 0, cogsMinor: 4500, grossMarginMinor: 5500 },
    ] } as ComponentProps<typeof MarginLedger>['report'];
    render(<MarginLedger report={report} />);
    const row = screen.getByText('Refunds without batch').closest('tr')!;
    expect(within(row).getByText('PKR -354.00')).toBeVisible();
    expect(within(row).getByText('PKR -245.00')).toBeVisible();
    expect(within(row).getAllByText('PKR -109.00')).toHaveLength(2);
    expect(within(row).getByText('PKR 0.00')).toBeVisible();
    expect(screen.getByText('B-123 · Paracetamol')).toBeVisible();
  });
  it('shows leakage names, signed stock-found offsets and collapsed technical references', () => {
    const report = { ...metadata, period: { from: new Date('2026-11-01Z'), to: new Date('2026-11-03Z') }, rows: [{
      branchId: 'branch-id', branchName: 'SehatCart Main', medicineId: 'medicine-id', medicineName: 'Paracetamol',
      discountMinor: 100, writeOffMinor: 0, shrinkageMinor: -200, totalMinor: -100,
    }] } as ComponentProps<typeof LeakageLedger>['report'];
    render(<LeakageLedger report={report} />);
    expect(screen.getByText('PKR -1.00')).toBeVisible();
    expect(screen.getByText('Paracetamol')).toBeVisible();
    expect(screen.getByText('medicine-id')).not.toBeVisible();
    expect(screen.queryByText(/Currency unknown/)).toBeNull();
  });
});
