import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeakageLedger } from './ledger-reports';

type Report = Parameters<typeof LeakageLedger>[0]['report'];

const report = {
  scope: { organizationId: 'org_1', branchId: 'branch_raw_id' },
  timezone: 'UTC',
  moneyUnit: 'integer_minor',
  currency: null,
  currencyStatus: 'not_recorded_by_ledger_reader',
  definition: 'x',
  source: 'finance_journal_lines',
  coverage: {},
  freshness: { retrievedAt: new Date('2026-09-03T19:30:00Z'), latestPostingAt: null },
  period: {
    from: new Date('2026-09-01T00:00:00Z'),
    to: new Date('2026-09-03T00:00:00Z'),
    bounds: '[from,to)',
  },
  names: { branches: { branch_raw_id: 'Main Branch' }, products: { med_raw_id: 'Panadol' } },
  rows: [
    {
      branchId: 'branch_raw_id',
      medicineId: 'med_raw_id',
      discountMinor: 1000,
      writeOffMinor: 0,
      shrinkageMinor: 0,
      totalMinor: 1000,
    },
  ],
} as unknown as Report;

describe('LeakageLedger plain display', () => {
  const html = renderToStaticMarkup(<LeakageLedger report={report} />);
  it('shows names, PKR and PKT dates, not raw ids or UTC ISO strings', () => {
    expect(html).toContain('Main Branch');
    expect(html).toContain('Panadol');
    expect(html).toContain('PKR');
    expect(html).toContain('1 Sept 2026, 05:00 PKT');
    for (const raw of ['branch_raw_id', 'med_raw_id', 'Currency unknown', '2026-09-01T', 'UTC'])
      expect(html).not.toContain(raw);
  });
});
