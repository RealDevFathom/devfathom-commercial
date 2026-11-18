import { describe, expect, it } from 'vitest';
import {
  CHEQUE_MATURITY_COVERAGE,
  chequeMaturityCsv,
  chequeMaturityEvidence,
  chequeMaturityMonths,
  formatChequeAmount,
} from './cheque-maturity';

const cheque = (overrides: Record<string, unknown> = {}) => ({
  id: 'tx-1',
  kind: 'CHEQUE',
  reference: 'CH-1',
  chequeStatus: 'PDC',
  status: 'POSTED',
  chequeDueAt: '2026-10-31T23:59:59.999Z',
  amountMinor: 1200,
  currency: 'PKR',
  ...overrides,
});

describe('recorded cheque maturity evidence', () => {
  it('uses UTC calendar boundaries and separates null maturity', () => {
    const rows = chequeMaturityEvidence([
      cheque(),
      cheque({ id: '2', reference: 'CH-2', chequeDueAt: null }),
    ]);
    expect(rows.map((row) => row.dueDate)).toEqual(['2026-10-31', null]);
    expect(chequeMaturityMonths(rows)).toEqual([{ month: '2026-10', entries: [rows[0]] }]);
  });

  it('keeps PDC, cleared, bounced, reversed and unknown states distinct', () => {
    expect(
      chequeMaturityEvidence([
        cheque(),
        cheque({ id: '2', reference: '2', chequeStatus: 'CLEARED' }),
        cheque({ id: '3', reference: '3', chequeStatus: 'BOUNCED' }),
        cheque({ id: '4', reference: '4', status: 'REVERSED' }),
        cheque({ id: '5', reference: '5', chequeStatus: 'SURPRISE' }),
      ]).map((row) => row.state)
    ).toEqual(['PDC', 'CLEARED', 'BOUNCED', 'REVERSED', 'UNKNOWN']);
  });

  it('caps at the workspace boundary, rejects foreign DTO shapes and never manufactures values', () => {
    const input = Array.from({ length: 51 }, (_, index) =>
      cheque({ id: String(index), reference: String(index) })
    );
    expect(chequeMaturityEvidence(input)).toHaveLength(50);
    expect(
      chequeMaturityEvidence([null, {}, { ...cheque(), id: 9 }, { ...cheque(), kind: 'BANK' }])
    ).toEqual([]);
    expect(CHEQUE_MATURITY_COVERAGE).toMatch(/full branch coverage unknown/i);
  });

  it('produces formula-safe CSV without inferring currency', () => {
    const [row] = chequeMaturityEvidence([
      cheque({ reference: '=CMD()', counterpartyName: '\n+evil', currency: null }),
    ]);
    const csv = chequeMaturityCsv([row], '2026-10-28T00:00:00.000Z');
    expect(csv).toContain("'=CMD()");
    expect(csv).toContain("'+evil");
    expect(csv).not.toContain('PKR');
    expect(csv).toContain(CHEQUE_MATURITY_COVERAGE);
  });
});

describe('formatChequeAmount', () => {
  it('scales recorded minor units by the recorded currency minor-unit exponent', () => {
    expect(formatChequeAmount(12500, 'PKR')).toBe('PKR 125.00');
    expect(formatChequeAmount(123456789, 'USD')).toBe('USD 1,234,567.89');
    expect(formatChequeAmount(-5, 'PKR')).toBe('-PKR 0.05');
    expect(formatChequeAmount(0, 'USD')).toBe('USD 0.00');
  });

  it('labels raw smallest-unit amounts when the currency scale is unknown', () => {
    expect(formatChequeAmount(12500, null)).toBe('12500 (currency not recorded) (smallest unit)');
    expect(formatChequeAmount(12500, 'rupees')).toBe('12500 rupees (smallest unit)');
    expect(formatChequeAmount(12500, 'JPY')).toBe('12500 JPY (smallest unit)');
    expect(formatChequeAmount(12500, 'constructor')).toBe('12500 constructor (smallest unit)');
    expect(formatChequeAmount(null, 'PKR')).toBe('Unknown');
  });
});
