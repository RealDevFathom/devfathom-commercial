import { describe, expect, it, vi } from 'vitest';
import {
  createFolioLedgerService,
  derivePostingMoney,
  folioPostingInput,
  MAX_POSTING_QUANTITY,
  type FolioLedgerStore,
} from './folio-ledger';

const scope = { organizationId: 'org-1', branchId: 'property-1' };

function fixture() {
  const store: FolioLedgerStore<object> = {
    read: vi.fn(async () => ({})),
    readEntries: vi.fn(async () => []),
    catalogPrice: vi.fn(async () => ({ unitMinor: 1_001, taxBasisPoints: 1_500 })),
    insert: vi.fn(async (_scope, value) => value),
    reverse: vi.fn(async () => ({})),
  };
  const requireFolio = vi.fn(async () => undefined);
  return { store, requireFolio, service: createFolioLedgerService(store, requireFolio) };
}

describe('folio ledger boundary', () => {
  it('checks hotel:folio on every read path before persistence', async () => {
    const { service, store, requireFolio } = fixture();
    await service.get(scope, 'folio-1');
    await service.entries(scope, 'folio-1');
    expect(requireFolio).toHaveBeenCalledTimes(2);
    expect(requireFolio.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.read).mock.invocationCallOrder[0]
    );
    expect(requireFolio.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(store.readEntries).mock.invocationCallOrder[0]
    );
  });

  it('rejects client money and derives net, tax and gross from catalog data', async () => {
    const { service, store } = fixture();
    await expect(
      service.post(scope, { folioId: 'f', catalogItemId: 'c', quantity: 2, grossMinor: 1 })
    ).rejects.toThrow();
    await service.post(scope, { folioId: 'f', catalogItemId: 'c', quantity: 2 });
    expect(store.insert).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        unitMinor: 1_001,
        netMinor: 2_002,
        taxMinor: 300,
        grossMinor: 2_302,
      })
    );
  });

  it('uses integer minor units and rejects unsafe totals', () => {
    expect(derivePostingMoney({ unitMinor: 101, taxBasisPoints: 750 }, 1)).toEqual({
      unitMinor: 101,
      netMinor: 101,
      taxMinor: 8,
      grossMinor: 109,
    });
    expect(() =>
      derivePostingMoney({ unitMinor: Number.MAX_SAFE_INTEGER, taxBasisPoints: 0 }, 2)
    ).toThrow('too large');
  });

  it('bounds quantity below the INTEGER column and refuses a malformed catalog tax rate', async () => {
    const posting = { folioId: 'f', catalogItemId: 'c' };
    expect(
      folioPostingInput.safeParse({ ...posting, quantity: MAX_POSTING_QUANTITY }).success
    ).toBe(true);
    expect(
      folioPostingInput.safeParse({ ...posting, quantity: MAX_POSTING_QUANTITY + 1 }).success
    ).toBe(false);
    expect(folioPostingInput.safeParse({ ...posting, quantity: 2 ** 31 }).success).toBe(false);
    // The store reports a non-integer `postingRule.taxBasisPoints` as -1.
    expect(() => derivePostingMoney({ unitMinor: 100, taxBasisPoints: -1 }, 1)).toThrow(
      'Invalid tax rate'
    );
  });

  it('rounds tax half up exactly at and around a half minor unit', () => {
    expect(derivePostingMoney({ unitMinor: 1, taxBasisPoints: 4_999 }, 1).taxMinor).toBe(0);
    expect(derivePostingMoney({ unitMinor: 1, taxBasisPoints: 5_000 }, 1).taxMinor).toBe(1);
    expect(derivePostingMoney({ unitMinor: 3, taxBasisPoints: 5_000 }, 1).taxMinor).toBe(2);
  });

  it('rejects a safe net whose tax makes gross overflow', () => {
    expect(() =>
      derivePostingMoney({ unitMinor: Number.MAX_SAFE_INTEGER, taxBasisPoints: 1 }, 1)
    ).toThrow('too large');
  });

  it('passes both tenant keys to writes and exposes reversal, not update', async () => {
    const { service, store } = fixture();
    expect('update' in service).toBe(false);
    await service.reverse(scope, 'entry-1', 'Wrong room');
    expect(store.reverse).toHaveBeenCalledWith(scope, 'entry-1', 'Wrong room');
  });
});
