import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { applyTenderInTransaction, quoteOpenBillSettlement } = vi.hoisted(() => ({
  applyTenderInTransaction: vi.fn(),
  quoteOpenBillSettlement: vi.fn(),
}));
vi.mock('@/lib/restaurant/tenders', () => ({ applyTenderInTransaction, quoteOpenBillSettlement }));

import {
  processTerminalEvent,
  simulateTerminalEvent,
  terminalEventSchema,
  verifyTerminalSignature,
} from '@/lib/restaurant/terminal-payments';

const baseEvent = {
  status: 'approved' as const,
  terminalId: 'counter-1',
  reference: 'bill-1',
  amount: '12.50',
  tipAmount: '1.00',
  staffProfileId: 'staff-1',
  providerReference: 'provider-ref-1',
};

function makeDb(overrides: Record<string, unknown> = {}) {
  const created: Record<string, unknown>[] = [];
  const db = {
    restaurantTerminalReconciliation: {
      findFirst: vi.fn(async () => null),
      findFirstOrThrow: vi.fn(async () => ({ id: 'recon-1', outcome: 'APPLIED' })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'recon-1', ...data };
      }),
    },
    restaurantTerminalProviderConfig: {
      findFirst: vi.fn(async () => ({
        id: 'config-1',
        branchId: 'branch-1',
        deviceId: 'device-1',
        mode: 'WEBHOOK',
      })),
    },
    restaurantBill: {
      findFirst: vi.fn(async () => ({ id: 'bill-1', grandTotal: '12.50', tenders: [] })),
    },
    restaurantStaffProfile: { findFirst: vi.fn(async () => ({ id: 'staff-1' })) },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
    ...overrides,
  };
  return { db, created };
}

describe('provider-neutral terminal payments', () => {
  beforeEach(() => {
    applyTenderInTransaction.mockReset();
    quoteOpenBillSettlement.mockReset();
    quoteOpenBillSettlement.mockResolvedValue({ remainingDue: '12.50' });
    applyTenderInTransaction.mockResolvedValue({
      tenderId: 'tender-1',
      paymentId: 'payment-1',
      settled: true,
    });
  });

  afterEach(() => {
    delete process.env.RESTAURANT_TERMINAL_WEBHOOK_SECRET;
  });

  it('strictly accepts only the card-terminal event contract', () => {
    expect(terminalEventSchema.parse(baseEvent)).toEqual(baseEvent);
    expect(() => terminalEventSchema.parse({ ...baseEvent, pan: '4111111111111111' })).toThrow();
  });

  it('authenticates a timestamp plus the source and raw body, and rejects skew and short digests', () => {
    process.env.RESTAURANT_TERMINAL_WEBHOOK_SECRET = 'test-terminal-secret';
    const source = 'provider-neutral';
    const now = 1_700_000_000_000;
    const timestamp = String(Math.floor(now / 1000));
    const rawBody = JSON.stringify({ externalEventId: 'event-1', payload: baseEvent });
    const sign = (at: string, signedSource = source, body = rawBody) =>
      createHmac('sha256', 'test-terminal-secret')
        .update(`${at}.${signedSource}.${body}`)
        .digest('hex');
    const signature = sign(timestamp);
    const bodyOnly = createHmac('sha256', 'test-terminal-secret')
      .update(`${source}.${rawBody}`)
      .digest('hex');
    const edge = String(Number(timestamp) - 5 * 60);
    const stale = String(Number(timestamp) - 5 * 60 - 1);
    const future = String(Number(timestamp) + 5 * 60 + 1);

    expect(verifyTerminalSignature(source, rawBody, `sha256=${signature}`, timestamp, now)).toBe(
      'VERIFIED'
    );
    expect(verifyTerminalSignature('other-source', rawBody, signature, timestamp, now)).toBe(
      'FAILED'
    );
    expect(verifyTerminalSignature(source, `${rawBody} `, signature, timestamp, now)).toBe(
      'FAILED'
    );
    expect(verifyTerminalSignature(source, rawBody, bodyOnly, timestamp, now)).toBe('FAILED');
    expect(verifyTerminalSignature(source, rawBody, signature, null, now)).toBe('FAILED');
    expect(verifyTerminalSignature(source, rawBody, sign(edge), edge, now)).toBe('VERIFIED');
    expect(verifyTerminalSignature(source, rawBody, sign(stale), stale, now)).toBe('FAILED');
    expect(verifyTerminalSignature(source, rawBody, sign(future), future, now)).toBe('FAILED');
    expect(() => verifyTerminalSignature(source, rawBody, 'aa', timestamp, now)).not.toThrow();
    expect(verifyTerminalSignature(source, rawBody, 'aa', timestamp, now)).toBe('FAILED');
    expect(verifyTerminalSignature(source, rawBody, 'not-a-signature', timestamp, now)).toBe(
      'FAILED'
    );
  });

  it('turns an approved event into the existing CARD tender path exactly once', async () => {
    const { db } = makeDb();
    const result = await processTerminalEvent(db as never, {
      source: 'provider-neutral',
      externalEventId: 'event-1',
      event: baseEvent,
      requiredMode: 'WEBHOOK',
    });

    expect(applyTenderInTransaction).toHaveBeenCalledOnce();
    expect(applyTenderInTransaction).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        billId: 'bill-1',
        tender: expect.objectContaining({ type: 'CARD', amount: expect.anything() }),
        actor: expect.objectContaining({ idempotencyKey: 'terminal:event-1' }),
      })
    );
    expect(result.reconciliation).toMatchObject({ outcome: 'APPLIED' });
  });

  it('validates an approval against the live tax-inclusive CARD settlement quote', async () => {
    const { db, created } = makeDb();
    db.restaurantBill.findFirst.mockResolvedValueOnce({
      id: 'bill-1',
      grandTotal: '10.00',
      tenders: [],
    } as never);
    quoteOpenBillSettlement.mockResolvedValueOnce({ remainingDue: '10.80' });

    await processTerminalEvent(db as never, {
      source: 'provider-neutral',
      externalEventId: 'event-tax-inclusive',
      event: { ...baseEvent, amount: '10.80' },
      requiredMode: 'WEBHOOK',
    });

    expect(quoteOpenBillSettlement).toHaveBeenCalledWith(db, 'bill-1', expect.any(Date), 'CARD');
    const quotedAt = quoteOpenBillSettlement.mock.calls[0]![2];
    expect(applyTenderInTransaction).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        now: quotedAt,
        tender: expect.objectContaining({ type: 'CARD', amount: expect.anything() }),
      })
    );
    const appliedAmount = applyTenderInTransaction.mock.calls[0]![1].tender.amount;
    expect(appliedAmount.toFixed(2)).toBe('10.80');
    expect(created).toEqual([]);
  });

  it('records an amount mismatch and never tenders', async () => {
    const { db, created } = makeDb();
    await processTerminalEvent(db as never, {
      source: 'provider-neutral',
      externalEventId: 'event-mismatch',
      event: { ...baseEvent, amount: '12.49' },
      requiredMode: 'WEBHOOK',
    });
    expect(applyTenderInTransaction).not.toHaveBeenCalled();
    expect(created[0]).toMatchObject({ outcome: 'REJECTED', failureReason: 'AMOUNT_MISMATCH' });
  });

  it('rejects a pre-tax approval amount that does not match the live CARD quote', async () => {
    const { db, created } = makeDb();
    db.restaurantBill.findFirst.mockResolvedValueOnce({ id: 'bill-1' } as never);
    quoteOpenBillSettlement.mockResolvedValueOnce({ remainingDue: '10.80' });

    await processTerminalEvent(db as never, {
      source: 'provider-neutral',
      externalEventId: 'event-pre-tax-amount',
      event: { ...baseEvent, amount: '10.00' },
      requiredMode: 'WEBHOOK',
    });

    expect(applyTenderInTransaction).not.toHaveBeenCalled();
    expect(quoteOpenBillSettlement).toHaveBeenCalledWith(db, 'bill-1', expect.any(Date), 'CARD');
    expect(created[0]).toMatchObject({
      amount: expect.objectContaining({ toFixed: expect.any(Function) }),
      outcome: 'REJECTED',
      failureReason: 'AMOUNT_MISMATCH',
    });
  });

  it('rejects an event without throwing when the live settlement cannot be quoted', async () => {
    const { db, created } = makeDb();
    quoteOpenBillSettlement.mockResolvedValueOnce(null);

    await processTerminalEvent(db as never, {
      source: 'provider-neutral',
      externalEventId: 'event-unquoted',
      event: baseEvent,
      requiredMode: 'WEBHOOK',
    });

    expect(applyTenderInTransaction).not.toHaveBeenCalled();
    expect(quoteOpenBillSettlement).toHaveBeenCalledWith(db, 'bill-1', expect.any(Date), 'CARD');
    expect(created[0]).toMatchObject({
      outcome: 'REJECTED',
      failureReason: 'SETTLEMENT_QUOTE_UNAVAILABLE',
      amount: expect.objectContaining({ toFixed: expect.any(Function) }),
    });
    expect(
      (created[0]!.amount as { toFixed: (places: number) => string }).toFixed(2)
    ).toBe('12.50');
  });

  it('returns the reconciliation on replay without another tender', async () => {
    const { db } = makeDb();
    db.restaurantTerminalReconciliation.findFirst.mockResolvedValueOnce({
      id: 'recon-existing',
      outcome: 'APPLIED',
    } as never);
    const result = await processTerminalEvent(db as never, {
      source: 'provider-neutral',
      externalEventId: 'event-1',
      event: baseEvent,
    });
    expect(result).toMatchObject({ replayed: true });
    expect(applyTenderInTransaction).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant/unconfigured terminals and labels simulation mode', async () => {
    const missing = makeDb({
      restaurantTerminalProviderConfig: { findFirst: vi.fn(async () => null) },
    }).db;
    await expect(
      processTerminalEvent(missing as never, {
        source: 'provider-neutral',
        externalEventId: 'event-x',
        event: baseEvent,
      })
    ).rejects.toMatchObject({ reason: 'CONFIG_NOT_FOUND' });

    const webhookOnly = makeDb().db;
    await expect(
      simulateTerminalEvent(webhookOnly as never, {
        source: 'provider-neutral',
        externalEventId: 'event-sim',
        event: baseEvent,
      })
    ).rejects.toMatchObject({ reason: 'MODE_MISMATCH' });
  });
});
