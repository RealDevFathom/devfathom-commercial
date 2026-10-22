import { beforeEach, describe, expect, it } from 'vitest';

import {
  activeSaleStorageKey,
  clearActiveSale,
  persistActiveSale,
  readActiveSale,
} from './active-sale-storage';

const scope = { organizationId: 'org-a', accountId: 'account-a' };

beforeEach(() => window.localStorage.clear());

describe('active counter sale storage', () => {
  it('restores the branch and sale for only the authenticated operator scope', () => {
    persistActiveSale({ ...scope, branchId: 'branch-a', saleId: 'sale-a' });

    expect(readActiveSale(scope)).toEqual({
      version: 1,
      ...scope,
      branchId: 'branch-a',
      saleId: 'sale-a',
    });
    expect(readActiveSale({ ...scope, accountId: 'account-b' })).toBeNull();
    expect(readActiveSale({ ...scope, organizationId: 'org-b' })).toBeNull();
  });

  it('rejects malformed or cross-scope records and can clear the pointer', () => {
    const key = activeSaleStorageKey(scope);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        accountId: 'account-b',
        branchId: 'branch-a',
        saleId: 'sale-a',
      })
    );
    expect(readActiveSale(scope)).toBeNull();

    persistActiveSale({ ...scope, branchId: 'branch-a', saleId: 'sale-a' });
    clearActiveSale(scope);
    expect(readActiveSale(scope)).toBeNull();
  });
});
