import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeakageLedger, MarginLedger, ValuationLedger } from './ledger-reports';

type ValuationProps = Parameters<typeof ValuationLedger>[0]['report'];
type MarginProps = Parameters<typeof MarginLedger>[0]['report'];
type LeakageProps = Parameters<typeof LeakageLedger>[0]['report'];

const labels = {
  branches: { branch_1: 'Main' },
  lots: { cmvzlot000000000000000001: 'Panadol · batch B12' },
  batches: { cmvzbatch0000000000000001: 'Panadol · batch B12' },
  medicines: { cmvzmed00000000000000001: 'Panadol' },
  locations: { cmvzloc00000000000000001: 'Front shelf' },
};
const meta = {
  scope: { organizationId: 'org_1', branchId: 'branch_1' },
  timezone: 'UTC' as const,
  moneyUnit: 'integer_minor' as const,
  currency: 'PKR',
  currencyStatus: 'organization_setting' as const,
  definition: 'Definition.',
  source: 'finance_journal_lines' as const,
  coverage: {
    basis: 'posted_entries_only' as const,
    completeness: 'unknown' as const,
    costCoverage: 'unknown' as const,
    refunds: 'included_only_when_posted_as_reversals' as const,
    emptyRows: 'no_matching_postings_not_proof_of_zero_activity' as const,
  },
  freshness: { retrievedAt: new Date('2026-11-01T00:00:00Z'), latestPostingAt: null },
  labels,
};
const period = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-11-01T00:00:00Z'),
  bounds: '[from,to)' as const,
};

describe('ledger reports show names and the organization currency', () => {
  it('values stock by medicine, batch and location in PKR, balancing lot-less opening stock', () => {
    const report = {
      ...meta,
      period: { at: new Date('2026-11-01T00:00:00Z'), bounds: 'through_inclusive' as const },
      unallocatedValueMinor: BigInt(10_000),
      rows: [
        {
          branchId: 'branch_1',
          lotId: 'cmvzlot000000000000000001',
          locationId: 'cmvzloc00000000000000001',
          medicineId: 'cmvzmed00000000000000001',
          manufacturingBatchId: 'cmvzbatch0000000000000001',
          unitCostMinor: 1_500,
          valueMinor: -22_500,
        },
      ],
    } as ValuationProps;
    const { container } = render(<ValuationLedger report={report} branchName="Main" />);
    const text = container.textContent ?? '';
    expect(screen.getByText('Panadol · batch B12')).toBeVisible();
    expect(screen.getByText('Front shelf')).toBeVisible();
    expect(
      screen.getByText('Opening stock entered as one branch total (not split by batch)')
    ).toBeVisible();
    expect(screen.getByText('PKR -125.00')).toBeVisible();
    expect(text).toContain('PKR -225.00');
    expect(text).toContain('Branch: Main.');
    expect(text).not.toContain('Currency unknown');
    expect(text).not.toMatch(/cmvz/);
  });

  it('labels margin batches by name and explains refunds not matched to a batch', () => {
    const report = {
      ...meta,
      period,
      by: 'batch' as const,
      rows: [
        {
          key: 'cmvzbatch0000000000000001',
          revenueMinor: 900,
          discountMinor: 0,
          cogsMinor: 600,
          grossMarginMinor: 300,
        },
        {
          key: null,
          revenueMinor: -35_400,
          discountMinor: 0,
          cogsMinor: 0,
          grossMarginMinor: -35_400,
        },
      ],
    } as MarginProps;
    const { container } = render(<MarginLedger report={report} branchName="Main" />);
    expect(screen.getByRole('columnheader', { name: 'Batch' })).toBeVisible();
    expect(screen.getByText('Panadol · batch B12')).toBeVisible();
    expect(screen.getByText('Refunds not yet matched to a batch')).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent(/negative revenue with no cost/);
    expect(container.textContent).not.toMatch(/cmvz|Not recorded|Currency unknown/);
  });

  it('names leakage branches and medicines', () => {
    const report = {
      ...meta,
      period,
      rows: [
        {
          branchId: 'branch_1',
          medicineId: 'cmvzmed00000000000000001',
          discountMinor: 10,
          writeOffMinor: 20,
          shrinkageMinor: -40,
          totalMinor: -10,
        },
      ],
    } as LeakageProps;
    const { container } = render(<LeakageLedger report={report} branchName="Main" />);
    expect(screen.getByText('Panadol')).toBeVisible();
    expect(container.textContent).not.toMatch(/cmvz/);
  });

  it('shows leakage dates in PKT, not UTC ISO strings or ledger jargon', () => {
    const report = {
      ...meta,
      period: {
        from: new Date('2026-09-01T00:00:00Z'),
        to: new Date('2026-09-03T00:00:00Z'),
        bounds: '[from,to)',
      },
      rows: [],
    } as unknown as LeakageProps;
    const { container } = render(
      <LeakageLedger report={report} branchName="Main" timeZone="Asia/Karachi" />
    );
    expect(container.textContent).toContain('1 Sep 2026, 5:00 AM PKT');
    expect(container.textContent).not.toMatch(/T\d\d:\d\d|finance_journal_lines|UTC/);
  });

  it('keeps an unresolved id visible as a reference rather than inventing a name', () => {
    const report = {
      ...meta,
      period,
      labels: { ...labels, medicines: {} },
      rows: [
        {
          branchId: 'branch_1',
          medicineId: 'med_gone',
          discountMinor: 0,
          writeOffMinor: 0,
          shrinkageMinor: 0,
          totalMinor: 0,
        },
      ],
    } as LeakageProps;
    render(<LeakageLedger report={report} branchName="Main" />);
    expect(screen.getByText('Name not found (ref med_gone)')).toBeVisible();
  });
});
