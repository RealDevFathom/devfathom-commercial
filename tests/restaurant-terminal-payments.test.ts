import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { applyTenderInTransaction } = vi.hoisted(() => ({ applyTenderInTransaction: vi.fn() }));
vi.mock('@/lib/restaurant/tenders', () => ({ applyTenderInTransaction }));

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

describe('terminal webhook signatures', () => {
  const source = 'provider-neutral';
  const rawBody = JSON.stringify({ externalEventId: 'event-1', payload: baseEvent });
  const now = 1_800_000_000;
  const timestamp = String(now);
  const sign = (ts: string) =>
    createHmac('sha256', 'test-terminal-secret').update(`${ts}.${source}.${rawBody}`).digest('hex');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    vi.stubEnv('RESTAURANT_TERMINAL_WEBHOOK_SECRET', 'test-terminal-secret');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([-300, 0, 300])('accepts a valid signature at a %i second offset', (offset) => {
    const ts = String(now + offset);
    expect(verifyTerminalSignature(source, rawBody, sign(ts), ts)).toBe('VERIFIED');
    expect(verifyTerminalSignature(source, rawBody, `sha256=${sign(ts)}`, ts)).toBe('VERIFIED');
  });

  it.each([
    ['stale', -301],
    ['future', 301],
  ] as const)('rejects a correctly signed %s timestamp outside five minutes', (_, offset) => {
    const ts = String(now + offset);
    expect(verifyTerminalSignature(source, rawBody, sign(ts), ts)).toBe('FAILED');
  });

  it.each([
    null,
    '',
    'not-a-timestamp',
    'NaN',
    'Infinity',
    '1e9',
    '0x123',
    '1800000000.5',
    '9'.repeat(400),
  ])('rejects a missing or invalid timestamp: %s', (ts) => {
    expect(verifyTerminalSignature(source, rawBody, sign(ts ?? ''), ts)).toBe('FAILED');
  });

  it('binds the signature to the exact timestamp, source, and raw body', () => {
    const signature = sign(timestamp);
    expect(verifyTerminalSignature(source, rawBody, signature, String(now + 1))).toBe('FAILED');
    expect(verifyTerminalSignature('other-source', rawBody, signature, timestamp)).toBe('FAILED');
    expect(verifyTerminalSignature(source, `${rawBody} `, signature, timestamp)).toBe('FAILED');
  });

  it.each([null, 'not-a-signature', 'ab'.repeat(31), 'ab'.repeat(33), `${'ab'.repeat(32)}a`])(
    'rejects a missing, malformed, or wrong-length signature: %s',
    (signature) => {
      expect(verifyTerminalSignature(source, rawBody, signature, timestamp)).toBe('FAILED');
    }
  );
});

describe('provider-neutral terminal payments', () => {
  beforeEach(() => {
    applyTenderInTransaction.mockReset();
    applyTenderInTransaction.mockResolvedValue({
      tenderId: 'tender-1',
      paymentId: 'payment-1',
      settled: true,
    });
  });

  it('strictly accepts only the card-terminal event contract', () => {
    expect(terminalEventSchema.parse(baseEvent)).toEqual(baseEvent);
    expect(() => terminalEventSchema.parse({ ...baseEvent, pan: '4111111111111111' })).toThrow();
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

  it('returns the reconciliation on replay without another tender', async () => {
    const { db } = makeDb();
    const input = {
      source: 'provider-neutral',
      externalEventId: 'event-1',
      event: baseEvent,
    };
    const first = await processTerminalEvent(db as never, input);
    db.restaurantTerminalReconciliation.findFirst.mockResolvedValueOnce(
      first.reconciliation as never
    );

    const replay = await processTerminalEvent(db as never, input);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ reconciliation: first.reconciliation, replayed: true });
    expect(db.restaurantTerminalReconciliation.findFirst).toHaveBeenCalledTimes(2);
    expect(db.restaurantTerminalReconciliation.findFirst).toHaveBeenLastCalledWith({
      where: { source: input.source, externalEventId: input.externalEventId },
    });
    expect(db.restaurantTerminalProviderConfig.findFirst).toHaveBeenCalledOnce();
    expect(db.restaurantBill.findFirst).toHaveBeenCalledOnce();
    expect(applyTenderInTransaction).toHaveBeenCalledOnce();
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
