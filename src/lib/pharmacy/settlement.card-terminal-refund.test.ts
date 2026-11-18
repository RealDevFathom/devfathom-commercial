/**
 * DEV-743: a sale paid on the integrated card terminal is never refunded as cash from the drawer
 * or through a provider DevFathom has no refund for. The refund refuses with a plain reason that
 * tells the cashier to refund through the card provider's own process. Manual Card tenders keep
 * their own refund path and are not even looked up.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./finance-postings', () => ({
  postTenderEntry: vi.fn(),
  postTenderRefundEntry: vi.fn(),
  postDailyCloseEntry: vi.fn(),
}));
vi.mock('./counter-evidence', () => ({ requestCounterEvidence: vi.fn() }));

import { COUNTER_ERROR_MESSAGES } from './counter-messages';
import { refundPharmacyTender } from './settlement';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'manager-a' };

function fixture(tender: { provider: string }, refund: object, linkedAttempts: number) {
  return {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => ({
        id: 'key-a',
        commandType: 'refund',
        payloadHash: createHash('sha256').update(JSON.stringify(refund)).digest('hex'),
        resultPayload: null,
      })),
      update: vi.fn(),
    },
    pharmacyDailyClose: { findFirst: vi.fn(async () => null) },
    pharmacyTender: {
      findFirst: vi.fn(async () => ({
        id: 'tender-a',
        saleId: 'sale-a',
        type: 'CARD',
        provider: tender.provider,
        amountMinor: 950,
        providerRef: 'RRN-1',
        refunds: [],
        sale: { customerId: null, status: 'COMPLETED' },
      })),
    },
    pharmacyCardTerminalAttempt: { count: vi.fn(async () => linkedAttempts) },
    pharmacySale: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 1) },
    pharmacyRefund: { create: vi.fn() },
    pharmacyDrawerMovement: { create: vi.fn() },
  };
}

const refundOf = (manualCashFallback: boolean) => ({
  originalTenderId: 'tender-a',
  deviceId: 'counter-a',
  businessDate: new Date('2026-11-18'),
  amountMinor: 950,
  reason: 'Returned',
  idempotencyKey: `refund-${manualCashFallback}`,
  manualCashFallback,
});

describe('DEV-743 refund of a card-terminal tender', () => {
  it.each([true, false])(
    'refuses (cash fallback %s) and pays nothing out of the drawer',
    async (manualCashFallback) => {
      const refund = refundOf(manualCashFallback);
      const db = fixture({ provider: 'FAKE_TERMINAL' }, refund, 1);
      await expect(refundPharmacyTender(db as never, scope, refund)).rejects.toMatchObject({
        reason: 'CARD_TERMINAL_REFUND_VIA_PROVIDER',
      });
      expect(db.pharmacyCardTerminalAttempt.count).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', branchId: 'branch-a', tenderId: { in: ['tender-a'] } },
      });
      expect(db.pharmacyRefund.create).not.toHaveBeenCalled();
      expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
    }
  );

  it('tells the cashier what to do today: refund through the provider, never cash', () => {
    const message = COUNTER_ERROR_MESSAGES.CARD_TERMINAL_REFUND_VIA_PROVIDER!;
    expect(message).toMatch(/Do not give cash/);
    expect(message).toMatch(/card provider’s own refund process/);
    expect(COUNTER_ERROR_MESSAGES.BILL_HAS_CARD_TERMINAL_PAYMENT).toMatch(/Do not give cash/);
  });

  it('never looks up a manual Card tender, whose refund path is unchanged', async () => {
    const refund = refundOf(true);
    const db = fixture({ provider: 'MANUAL_TERMINAL' }, refund, 1);
    const outcome = await refundPharmacyTender(db as never, scope, refund).catch(
      (error: unknown) => error
    );
    expect(outcome).not.toMatchObject({ reason: 'CARD_TERMINAL_REFUND_VIA_PROVIDER' });
    expect(db.pharmacyCardTerminalAttempt.count).not.toHaveBeenCalled();
  });
});
