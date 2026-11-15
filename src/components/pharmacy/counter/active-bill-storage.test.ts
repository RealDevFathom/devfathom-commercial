import { afterEach, describe, expect, it, vi } from 'vitest';

import { activeBillStorageKey, readActiveBill, rememberActiveBill } from './active-bill-storage';

const scope = { organizationId: 'org-a', accountId: 'account-a', branchId: 'branch-a' };

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('active bill storage (DEV-623)', () => {
  it('remembers and forgets the open bill for one account and branch', () => {
    rememberActiveBill(scope, 'sale-a');
    expect(readActiveBill(scope)).toBe('sale-a');
    expect(readActiveBill({ ...scope, accountId: 'account-b' })).toBeNull();
    expect(readActiveBill({ ...scope, branchId: 'branch-b' })).toBeNull();

    rememberActiveBill(scope, null);
    expect(window.localStorage.getItem(activeBillStorageKey(scope))).toBeNull();
    expect(readActiveBill(scope)).toBeNull();
  });

  it.each(['{', '"sale-a"', JSON.stringify({ version: 2, saleId: 'sale-a' }), 'x'.repeat(600)])(
    'ignores an unreadable record %#',
    (raw) => {
      window.localStorage.setItem(activeBillStorageKey(scope), raw);
      expect(readActiveBill(scope)).toBeNull();
    }
  );

  it('loses only the convenience when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => rememberActiveBill(scope, 'sale-a')).not.toThrow();
    expect(readActiveBill(scope)).toBeNull();
  });
});
