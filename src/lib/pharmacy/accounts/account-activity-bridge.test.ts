import { describe, expect, it } from 'vitest';
import {
  AccountActivityBridgeError,
  accountActivityBridgeCsv,
  projectAccountActivityBridge,
  validAccountActivityQuery,
  type AccountAggregate,
} from './account-activity-bridge';

const row = (overrides: Partial<AccountAggregate> = {}): AccountAggregate => ({
  accountCode: 'CASH',
  currency: 'PKR',
  openingMinor: '100',
  debitMinor: '50',
  creditMinor: '20',
  closingMinor: '130',
  ...overrides,
});

describe('account activity bridge', () => {
  it('projects opening + debits - credits = closing without mutating its input', () => {
    const rows = [row()];
    const before = structuredClone(rows);
    const outcome = projectAccountActivityBridge(rows, { accountCode: 'CASH', currency: 'PKR' });
    expect(outcome).toEqual({
      status: 'ready',
      bridge: { ...row(), coverage: 'posted-ledger-coverage-unknown' },
    });
    expect(rows).toEqual(before);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(outcome.status === 'ready' && Object.isFrozen(outcome.bridge)).toBe(true);
  });

  it('preserves additive reversals and integers beyond Number safe range', () => {
    const huge = row({
      openingMinor: '900719925474099300000',
      debitMinor: '-50',
      creditMinor: '-20',
      closingMinor: '900719925474099299970',
    });
    expect(
      projectAccountActivityBridge([huge], { accountCode: 'CASH', currency: 'PKR' })
    ).toMatchObject({ status: 'ready', bridge: huge });
  });

  it('returns explicit account and currency missing outcomes rather than zero', () => {
    expect(projectAccountActivityBridge([row()], { accountCode: 'BANK', currency: 'PKR' })).toEqual(
      { status: 'account-not-found' }
    );
    expect(projectAccountActivityBridge([row()], { accountCode: 'CASH', currency: 'USD' })).toEqual(
      { status: 'currency-not-found' }
    );
  });

  it('refuses duplicate, malformed, and inconsistent DTO evidence', () => {
    expect(() =>
      projectAccountActivityBridge([row(), row()], { accountCode: 'CASH', currency: 'PKR' })
    ).toThrowError(new AccountActivityBridgeError('DUPLICATE'));
    expect(() =>
      projectAccountActivityBridge([row({ debitMinor: '1.5' })], {
        accountCode: 'CASH',
        currency: 'PKR',
      })
    ).toThrowError(new AccountActivityBridgeError('INVALID_DTO'));
    expect(() =>
      projectAccountActivityBridge([row({ closingMinor: '999' })], {
        accountCode: 'CASH',
        currency: 'PKR',
      })
    ).toThrowError(new AccountActivityBridgeError('INCONSISTENT_CLOSING'));
  });

  it('quotes deterministic CSV and protects spreadsheet formulas and controls', () => {
    const outcome = projectAccountActivityBridge([row({ accountCode: '=CASH,\n"x"' })], {
      accountCode: '=CASH,\n"x"',
      currency: 'PKR',
    });
    if (outcome.status !== 'ready') throw new Error('expected bridge');
    expect(accountActivityBridgeCsv(outcome.bridge)).toBe(
      '"account_code","currency","opening_minor","debits_minor","credits_minor","closing_minor","coverage"\r\n' +
        '"\'=CASH, ""x""","PKR","100","50","20","130","posted-ledger-coverage-unknown"\r\n'
    );
  });
});

describe('strict pre-reader input validation', () => {
  it.each([{ from: '' }, { to: [] }, { branchId: ['one', 'two'] }, { currency: '' }])(
    'rejects explicit malformed %j',
    (params) => {
      expect(validAccountActivityQuery(params, '2026-10-01', '2026-10-26')).toBe(false);
    }
  );
  it('accepts only genuine calendar days in a bounded half-open period', () => {
    expect(validAccountActivityQuery({}, '2026-02-30', '2026-03-02')).toBe(false);
    expect(validAccountActivityQuery({}, '2026-10-01', '2026-10-01')).toBe(false);
    expect(validAccountActivityQuery({}, '2026-01-01', '2026-10-01')).toBe(false);
    expect(validAccountActivityQuery({}, '2026-10-01', '2026-10-26')).toBe(true);
  });
  it('neutralizes whitespace-prefixed formula tokens without numeric coercion', () => {
    const result = projectAccountActivityBridge([row({ accountCode: ' \t=PAYLOAD' })], {
      accountCode: ' \t=PAYLOAD',
      currency: 'PKR',
    });
    if (result.status !== 'ready') throw new Error('not ready');
    expect(accountActivityBridgeCsv(result.bridge)).toContain(`"'  =PAYLOAD"`);
  });
});
