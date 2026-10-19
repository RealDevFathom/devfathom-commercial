import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  createWalletProviderDelivery,
  deliverWalletUpdates,
  reconcileWalletUpdates,
  WALLET_UPDATE_MAX_ATTEMPTS,
} from './balance-updates';

function fakeDb(rows: object[]) {
  const update = vi.fn().mockResolvedValue({});
  const passUpdate = vi.fn().mockResolvedValue({});
  const db = {
    $queryRaw: vi.fn().mockResolvedValue(rows),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    walletPassUpdate: { update },
    walletPass: { update: passUpdate },
  } as unknown as ScopedDb;
  return { db, update, passUpdate };
}

const row = (attempts = 1) => ({
  id: 'update_1',
  passId: 'pass_1',
  platform: 'GOOGLE',
  serialNumber: 'opaque',
  balance: 42,
  attempts,
});

describe('wallet balance updates', () => {
  it('patches an absolute Google balance and marks the intent sent', async () => {
    const { db, update, passUpdate } = fakeDb([row()]);
    const google = vi.fn().mockResolvedValue(undefined);
    const result = await deliverWalletUpdates(db, { google, apple: vi.fn() });
    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(google).toHaveBeenCalledWith({ passId: 'pass_1', serialNumber: 'opaque', balance: 42 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) })
    );
    expect(passUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastPushedBalance: 42 }) })
    );
  });

  it('bounds provider retries and keeps accepted/pushed distinct from delivery', async () => {
    const { db, update, passUpdate } = fakeDb([row(WALLET_UPDATE_MAX_ATTEMPTS)]);
    const result = await deliverWalletUpdates(db, {
      google: vi.fn().mockRejectedValue(new Error('accepted but delivery unconfirmed')),
      apple: vi.fn(),
    });
    expect(result.failed).toBe(1);
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) })
    );
    expect(passUpdate).not.toHaveBeenCalled();
  });

  it('reconciliation enqueues drift repair and is ledger read-only', async () => {
    const { db } = fakeDb([]);
    await expect(reconcileWalletUpdates(db)).resolves.toBe(1);
    expect(db.$executeRaw).toHaveBeenCalledOnce();
  });

  it('fails explicitly when live provider credentials are absent', async () => {
    const { db } = fakeDb([]);
    const delivery = createWalletProviderDelivery({ db });
    await expect(
      delivery.apple({ passId: 'pass_1', serialNumber: 'opaque', balance: 1 })
    ).rejects.toThrow('Apple APNs wallet update credentials are not configured.');
    await expect(
      delivery.google({ passId: 'pass_1', serialNumber: 'opaque', balance: 1 })
    ).rejects.toThrow('Google Wallet issuer credentials are not configured.');
  });
});
