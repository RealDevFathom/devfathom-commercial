import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LedgerReportsLoading,
  LedgerReportsSection,
  LeakageLedger,
  MarginLedger,
  ValuationLedger,
} from './ledger-reports';

const metadata = {
  scope: { organizationId: 'organization_1', branchId: 'branch_1' },
  timezone: 'UTC' as const,
  moneyUnit: 'integer_minor' as const,
  currency: null,
  currencyStatus: 'not_recorded_by_ledger_reader' as const,
  definition: 'Posted ledger amounts; unposted evidence remains unknown.',
  source: 'finance_journal_lines' as const,
  coverage: {
    basis: 'posted_entries_only' as const,
    completeness: 'unknown' as const,
    costCoverage: 'unknown' as const,
    refunds: 'included_only_when_posted_as_reversals' as const,
    emptyRows: 'no_matching_postings_not_proof_of_zero_activity' as const,
  },
  freshness: { retrievedAt: new Date('2026-09-12T10:00:00Z'), latestPostingAt: null },
};
const period = {
  from: new Date('2026-09-01T00:00:00Z'),
  to: new Date('2026-09-12T00:00:00Z'),
  bounds: '[from,to)' as const,
};
const valuation = {
  ...metadata,
  period: { at: period.to, bounds: 'through_inclusive' as const },
  rows: [
    {
      branchId: 'branch_1',
      lotId: 'lot_1',
      locationId: null,
      medicineId: null,
      manufacturingBatchId: 'batch_1',
      unitCostMinor: null,
      valueMinor: 10001,
    },
  ],
} satisfies Parameters<typeof ValuationLedger>[0]['report'];
const margin = {
  ...metadata,
  period,
  by: 'batch' as const,
  rows: [
    { key: null, revenueMinor: 10001, discountMinor: 102, cogsMinor: 8000, grossMarginMinor: 1899 },
  ],
} satisfies Parameters<typeof MarginLedger>[0]['report'];
const leakage = {
  ...metadata,
  period,
  rows: [
    {
      branchId: 'branch_1',
      medicineId: null,
      discountMinor: 102,
      writeOffMinor: 200,
      shrinkageMinor: -501,
      totalMinor: -199,
    },
  ],
} satisfies Parameters<typeof LeakageLedger>[0]['report'];
const filters = {
  branch: { id: 'branch_1', name: 'Main pharmacy' },
  from: '2026-09-01',
  to: '2026-09-12',
  at: '2026-09-12',
  by: 'batch',
  marginFrom: '2026-08-01',
  marginTo: '2026-08-31',
};
function mockCaller() {
  return {
    perpetualValuation: vi.fn().mockResolvedValue(valuation),
    grossMargin: vi.fn().mockResolvedValue(margin),
    leakageReport: vi.fn().mockResolvedValue(leakage),
  };
}
afterEach(() => vi.useRealTimers());

describe('pharmacy ledger finance UI', () => {
  it('renders exact minor amounts and preserves unknown cost, currency and disposition', () => {
    const html = renderToStaticMarkup(<ValuationLedger report={valuation} />);
    for (const text of [
      'Currency unknown 100.01',
      'Unknown',
      'Not recorded',
      'batch_1',
      'lot_1',
      'completeness unknown',
      'Cost coverage: unknown',
      'quarantine',
      'must not be treated as usable',
      'current metadata',
      'Latest posting: unknown',
      '2026-09-12T10:00:00.000Z',
      'finance_journal_lines',
      'all returned groups shown',
      'overflow-x-auto',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('PKR');
    expect(html).not.toContain('organization_1');
  });

  it('renders maximum safe signed minor values without floating point rounding', () => {
    const html = renderToStaticMarkup(
      <ValuationLedger
        report={{
          ...valuation,
          rows: [{ ...valuation.rows[0], valueMinor: -Number.MAX_SAFE_INTEGER, unitCostMinor: 1 }],
        }}
      />
    );
    expect(html).toContain('Currency unknown -90071992547409.91');
    expect(html).toContain('Currency unknown 0.01');
  });

  it('does not turn invalid cost or overflowing aggregate money into zero', () => {
    const html = renderToStaticMarkup(
      <ValuationLedger
        report={{
          ...valuation,
          rows: [
            { ...valuation.rows[0], valueMinor: Number.MAX_SAFE_INTEGER, unitCostMinor: NaN },
            { ...valuation.rows[0], lotId: 'lot_2', valueMinor: 1 },
          ],
        }}
      />
    );
    expect(html).toContain('Unavailable (amount exceeds safe bounds)');
    expect(html).toContain('Unavailable (invalid minor amount)');
    expect(html).not.toContain('Currency unknown 0.00');
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it('shows net revenue after discounts, posted COGS and qualified margin', () => {
    const html = renderToStaticMarkup(<MarginLedger report={margin} />);
    for (const text of [
      'Currency unknown 100.01',
      'Currency unknown 1.02',
      'Currency unknown 98.99',
      'Currency unknown 80.00',
      'Currency unknown 18.99',
      'tax excluded',
      'not net profit or cash flow',
      'Missing or unposted costs may overstate margin',
      'not substituted for historical COGS',
      'grouped by batch',
      'start inclusive, end exclusive',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('100%');
  });

  it('keeps signed leakage categories separate without invented loss causes', () => {
    const html = renderToStaticMarkup(<LeakageLedger report={leakage} />);
    for (const text of [
      'Discounts',
      'Write-offs',
      'Signed shrinkage',
      'Currency unknown -5.01',
      'Currency unknown -1.99',
      'Stock found offsets stock lost',
      'not all realized loss',
      'Expiry exposure',
    ])
      expect(html).toContain(text);
  });

  it('shows empty rows without a zero inventory, revenue or cost-coverage claim', () => {
    for (const element of [
      <ValuationLedger key="v" report={{ ...valuation, rows: [] }} />,
      <MarginLedger key="m" report={{ ...margin, rows: [] }} />,
      <LeakageLedger key="l" report={{ ...leakage, rows: [] }} />,
    ]) {
      const html = renderToStaticMarkup(element);
      expect(html).toContain('No matching posted ledger rows');
      expect(html).toContain('not proof of zero activity');
      expect(html).toContain('Cost coverage: unknown');
      expect(html).not.toContain('Currency unknown 0.00');
      expect(html).not.toContain('data-slot="stat"');
    }
  });

  it('calls all three authorized server APIs with explicit branch, UTC dates and grouping', async () => {
    const caller = mockCaller();
    const html = renderToStaticMarkup(await LedgerReportsSection({ ...filters, caller }));
    const input = {
      branchId: 'branch_1',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-12T00:00:00.000Z',
    };
    expect(caller.perpetualValuation).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch_1',
      at: '2026-09-12T00:00:00.000Z',
    });
    expect(caller.grossMargin).toHaveBeenCalledExactlyOnceWith({ ...input, by: 'batch' });
    expect(caller.leakageReport).toHaveBeenCalledExactlyOnceWith(input);
    for (const text of [
      'name="ledgerFrom"',
      'name="ledgerTo"',
      'name="ledgerAt"',
      'name="ledgerBy"',
      'value="2026-09-01"',
      'value="branch_1"',
      'name="marginFrom"',
      'value="2026-08-01"',
      'name="marginTo"',
      'value="2026-08-31"',
      'Main pharmacy',
      'Perpetual valuation',
      'Ledger gross margin',
      'Recorded leakage',
    ])
      expect(html).toContain(text);
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'])(
    'handles %s without exposing report data or error details',
    async (code) => {
      const caller = mockCaller();
      Object.values(caller).forEach((method) =>
        method.mockRejectedValue({ code, message: 'secret internal detail' })
      );
      const html = renderToStaticMarkup(await LedgerReportsSection({ ...filters, caller }));
      expect(html.match(/Permission required:/g)).toHaveLength(3);
      expect(html).toContain('administrator financial and operational report access');
      expect(html).toContain('name="ledgerFrom"');
      expect(html).not.toMatch(/secret internal detail|100\.01|finance_journal_lines/);
    }
  );

  it('isolates one failed read and retains successful reports plus retry filters', async () => {
    const caller = mockCaller();
    caller.grossMargin.mockRejectedValue({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'private connection detail',
    });
    const html = renderToStaticMarkup(await LedgerReportsSection({ ...filters, caller }));
    expect(html).toContain('Ledger report unavailable');
    expect(html).toContain('Apply ledger filters');
    expect(html).toContain('Currency unknown 100.01');
    expect(html).toContain('Currency unknown -1.99');
    expect(html).not.toContain('private connection detail');
    expect(html).not.toContain('Currency unknown 18.99');
  });

  it.each([
    { from: '2026-02-30' },
    { from: '2026-09-12' },
    { to: '2026-08-31' },
    { from: '2026-01-01' },
    { at: '2026-09-13' },
    { by: 'invalid' },
    { from: '' },
  ])('rejects invalid filters before any ledger API call: %j', async (override) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
    const caller = mockCaller();
    const html = renderToStaticMarkup(
      await LedgerReportsSection({ ...filters, ...override, caller })
    );
    Object.values(caller).forEach((method) => expect(method).not.toHaveBeenCalled());
    expect(html).toContain('No ledger queries ran');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="ledger-filter-error"');
    expect(html).toContain('Submitted filters:');
  });

  it('accepts the 92-day boundary and defaults missing filters deterministically in UTC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
    const caller = mockCaller();
    await LedgerReportsSection({ caller, branch: filters.branch, from: '2026-06-12' });
    expect(caller.grossMargin).toHaveBeenCalledWith({
      branchId: 'branch_1',
      from: '2026-06-12T00:00:00.000Z',
      to: '2026-09-12T00:00:00.000Z',
      by: 'batch',
    });
    expect(caller.perpetualValuation).toHaveBeenCalledWith({
      branchId: 'branch_1',
      at: '2026-09-12T00:00:00.000Z',
    });
  });

  it('provides a named loading state and disabled loading control', () => {
    const html = renderToStaticMarkup(<LedgerReportsLoading />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading valuation, margin and recorded leakage');
    expect(html).toContain('disabled');
    expect(html).not.toContain('0.00');
  });
});
