import { describe, expect, it } from 'vitest';
import {
  CHEQUE_MATURITY_COVERAGE,
  chequeMaturityCsv,
  projectChequeMaturity,
} from './cheque-maturity';

const scope = { organizationId: 'org-1', branchId: 'branch-1' };
const period = { from: '2026-10-01', to: '2026-11-01' };
function transaction(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    kind: 'CHEQUE',
    status: 'POSTED',
    chequeStatus: 'PDC',
    reference: 'CHQ-1',
    counterpartyName: 'Supplier One',
    chequeNumber: '0007',
    amountMinor: 9007199254740991,
    currency: 'PKR',
    occurredAt: new Date('2026-09-30T22:00:00.000Z'),
    chequeDueAt: new Date('2026-10-01T00:00:00.000Z'),
    reversedAt: null,
    ...overrides,
  };
}

describe('cheque maturity projection', () => {
  it('uses UTC half-open due boundaries and retains an unknown due date', () => {
    const report = projectChequeMaturity(
      [
        transaction({ reference: 'FROM' }),
        transaction({ reference: 'BEFORE', chequeDueAt: new Date('2026-09-30T23:59:59.999Z') }),
        transaction({ reference: 'TO', chequeDueAt: new Date('2026-11-01T00:00:00.000Z') }),
        transaction({ reference: 'UNKNOWN', chequeDueAt: null }),
      ],
      scope,
      period
    );
    expect(report.rows.map(({ reference, dueDate }) => [reference, dueDate])).toEqual([
      ['FROM', '2026-10-01'],
      ['UNKNOWN', null],
    ]);
    expect(report.period).toEqual({ ...period, bounds: '[from,to)', timezone: 'UTC' });
  });

  it.each([
    ['PDC', 'POSTED', null, 'PDC'],
    ['CLEARED', 'POSTED', null, 'CLEARED'],
    ['BOUNCED', 'POSTED', null, 'BOUNCED'],
    ['PDC', 'REVERSED', new Date('2026-10-05T00:00:00Z'), 'REVERSED'],
  ])('keeps %s / %s evidence distinct', (chequeStatus, status, reversedAt, expected) => {
    const [row] = projectChequeMaturity(
      [transaction({ chequeStatus, status, reversedAt })],
      scope,
      period
    ).rows;
    expect(row).toMatchObject({ chequeStatus, transactionStatus: status, evidenceState: expected });
    expect(row?.amountMinor).toBe('9007199254740991');
  });

  it('always labels empty and exactly-50 reads as capped with unknown full coverage', () => {
    expect(projectChequeMaturity([], scope, period)).toMatchObject({
      sourceCount: 0,
      coverage: CHEQUE_MATURITY_COVERAGE,
    });
    const fifty = Array.from({ length: 50 }, (_, index) =>
      transaction({ reference: `C-${index}` })
    );
    expect(projectChequeMaturity(fifty, scope, period)).toMatchObject({
      sourceCount: 50,
      sourceCap: 50,
      coverage: CHEQUE_MATURITY_COVERAGE,
    });
  });

  it.each([
    { organizationId: 'foreign' },
    { branchId: 'foreign' },
    { kind: 'NOT_A_REAL_KIND' },
    { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { currency: 'ASSUMED' },
    { chequeDueAt: '2026-10-01' },
  ])('rejects unsafe or foreign DTO evidence: %j', (unsafe) => {
    expect(() => projectChequeMaturity([transaction(unsafe)], scope, period)).toThrow(
      'Unsafe transaction evidence.'
    );
  });

  it('does not turn other workspace transactions into cheque or BANK deductions', () => {
    const report = projectChequeMaturity(
      [transaction({ kind: 'BANK_DEPOSIT', chequeStatus: 'NONE' }), transaction()],
      scope,
      period
    );
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.reference).toBe('CHQ-1');
  });

  it.each([
    { from: '2026-10-01', to: '2026-10-01' },
    { from: '2026-10-02', to: '2026-10-01' },
    { from: '2026-01-01', to: '2026-04-04' },
    { from: '2026-02-30', to: '2026-03-02' },
  ])('rejects invalid or over-92-day periods: %j', (invalid) => {
    expect(() => projectChequeMaturity([], scope, invalid)).toThrow(RangeError);
  });

  it('quotes CSV and neutralizes formulas and control characters without inventing currency', () => {
    const report = projectChequeMaturity(
      [
        transaction({
          reference: '=2+2',
          chequeNumber: '"quoted"',
          counterpartyName: 'Supplier\n@attack',
          currency: 'USD',
        }),
      ],
      scope,
      period
    );
    const csv = chequeMaturityCsv(report);
    expect(csv).toContain('"\'=2+2"');
    expect(csv).toContain('"""quoted"""');
    expect(csv).toContain('"Supplier @attack"');
    expect(csv).toContain('"9007199254740991","USD"');
    expect(csv).not.toContain('PKR');
  });
});

describe('empty standalone CSV coverage regressions', () => {
  it('retains non-record current-state/unknown metadata for zero source transactions', () => {
    const report = projectChequeMaturity([], scope, period);
    const csv = chequeMaturityCsv(report);
    expect(report.rows).toHaveLength(0);
    expect(csv).toContain(CHEQUE_MATURITY_COVERAGE);
    expect(csv).toContain('"metadata","sourceCount","0"');
    expect(csv).toContain('"metadata","sourceCap","50"');
    expect(csv).toContain('"metadata","fromInclusiveUTC","2026-10-01"');
    expect(csv).toContain('"metadata","toExclusiveUTC","2026-11-01"');
    expect(csv).toContain('RECENT_CAPPED_CURRENT_STATE_NOT_AP_AGING');
  });
  it('retains cap50/unknown coverage when all fifty cheques are filtered out', () => {
    const input = Array.from({ length: 50 }, (_, i) =>
      transaction({
        reference: `FILTERED-${i}`,
        chequeDueAt: new Date('2026-12-01T00:00:00Z'),
      })
    );
    const report = projectChequeMaturity(input, scope, period);
    const csv = chequeMaturityCsv(report);
    expect(report.rows).toHaveLength(0);
    expect(csv).toContain(CHEQUE_MATURITY_COVERAGE);
    expect(csv).toContain('"metadata","sourceCount","50"');
    expect(csv).not.toContain('FILTERED-');
    expect(csv.split('\r\n').filter((line) => line.startsWith('"metadata"'))).toHaveLength(6);
  });
});
