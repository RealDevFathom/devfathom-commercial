import { describe, expect, it } from 'vitest';
import {
  AccountActivityBridgeError,
  accountActivityBridge,
  accountActivityBridgeCsv,
  assertAccountActivityScope,
  type AccountActivityAggregate,
} from './account-activity-bridge';

const row = (overrides: Partial<AccountActivityAggregate> = {}): AccountActivityAggregate => ({
  accountCode: 'CASH',
  currency: 'PKR',
  openingMinor: '100',
  debitMinor: '50',
  creditMinor: '20',
  closingMinor: '130',
  ...overrides,
});

describe('single-account activity bridge', () => {
  it('isolates the requested recorded currency and proves opening + debit - credit = closing', () => {
    const aggregates = [row(), row({ currency: 'USD', closingMinor: '130' })];
    expect(accountActivityBridge(aggregates, { accountCode: 'CASH', currency: 'PKR' })).toEqual({
      accountCode: 'CASH',
      currency: 'PKR',
      openingMinor: '100',
      debitMinor: '50',
      creditMinor: '20',
      closingMinor: '130',
      postedCoverage: 'unknown',
    });
  });

  it('keeps additive reversals and arbitrary precision integer strings exact', () => {
    const huge = '900719925474099312345678901234567890';
    const bridge = accountActivityBridge(
      [
        row({
          openingMinor: huge,
          debitMinor: '-50',
          creditMinor: '-20',
          closingMinor: '900719925474099312345678901234567860',
        }),
      ],
      { accountCode: 'CASH', currency: 'PKR' }
    );
    expect(bridge.debitMinor).toBe('-50');
    expect(bridge.closingMinor).toBe('900719925474099312345678901234567860');
  });

  it.each([
    ['missing selected aggregate', [], 'No aggregate'],
    ['duplicate selected aggregate', [row(), row()], 'Duplicate'],
    ['missing amount', [row({ debitMinor: undefined })], 'Debit is missing'],
    ['non-integer amount', [row({ creditMinor: '2.5' })], 'integer minor-unit'],
    ['foreign closing amount', [row({ closingMinor: '999' })], 'does not reconcile'],
  ])('refuses %s', (_name, aggregates, message) => {
    expect(() =>
      accountActivityBridge(aggregates, { accountCode: 'CASH', currency: 'PKR' })
    ).toThrow(message);
  });

  it('does not mutate the source DTO or returned evidence', () => {
    const source = Object.freeze(row());
    const result = accountActivityBridge([source], { accountCode: 'CASH', currency: 'PKR' });
    expect(source).toEqual(row());
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('exports spreadsheet-safe, one-row evidence without formula cells', () => {
    const bridge = accountActivityBridge([row({ accountCode: '=HYPERLINK("bad")' })], {
      accountCode: '=HYPERLINK("bad")',
      currency: 'PKR',
    });
    const csv = accountActivityBridgeCsv(bridge);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv.split('\r\n')).toHaveLength(3);
    expect(csv).toContain('"unknown"');
  });

  it.each(['\n=1+1', '\r\n+SUM(A1)', '\u00a0@SUM(A1)', '\u0000=1+1', '\ttext'])(
    'neutralizes spreadsheet control and whitespace prefixes: %j',
    (accountCode) => {
      const bridge = accountActivityBridge([row({ accountCode })], {
        accountCode,
        currency: 'PKR',
      });
      expect(accountActivityBridgeCsv(bridge)).toContain(`"'${accountCode}"`);
    }
  );

  it('uses a specific domain error', () => {
    expect(() => accountActivityBridge([], { accountCode: 'CASH', currency: 'PKR' })).toThrow(
      AccountActivityBridgeError
    );
  });

  it.each([
    undefined,
    { organizationId: 'other', branchId: 'branch_1' },
    { organizationId: 'org_1', branchId: 'other' },
  ])('refuses a missing or foreign aggregate DTO scope', (scope) => {
    expect(() =>
      assertAccountActivityScope(scope, { organizationId: 'org_1', branchId: 'branch_1' })
    ).toThrow('outside the requested scope');
  });
});
