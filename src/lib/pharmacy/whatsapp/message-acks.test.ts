import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/scoped-db', () => ({}));

import { applyProviderAck, providerAckState, type ProviderAckState } from './message-acks';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const AT = new Date('2026-10-23T11:00:00.000Z');

type Log = {
  id: string;
  branchId: string | null;
  kind: string;
  status: string;
  refillCaptureId: string | null;
};

function refillLog(status: string): Log {
  return {
    id: 'log-a',
    branchId: 'branch-a',
    kind: 'REFILL_REMINDER',
    status,
    refillCaptureId: 'capture-a',
  };
}

function fakeDb(logs: Log[]) {
  const queries: Array<{ sql: string; text: string; values: unknown[] }> = [];
  const captures: Array<{ sql: string; values: unknown[] }> = [];
  const updateMany = vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({
    count: 1,
  }));
  return {
    queries,
    captures,
    updateMany,
    db: {
      $queryRaw: async (query: { sql: string; text: string; values: unknown[] }) => {
        queries.push(query);
        return logs;
      },
      $executeRaw: async (query: { sql: string; values: unknown[] }) => {
        captures.push(query);
        return 1;
      },
      pharmacyMessageLog: { updateMany },
    },
  };
}

function apply(logs: Log[], state: ProviderAckState, occurredAt = AT) {
  const fake = fakeDb(logs);
  const outcome = applyProviderAck(
    fake.db as never,
    'org-a',
    { providerMessageId: 'wamid.a', state, occurredAt },
    NOW
  );
  return { fake, outcome };
}

describe('provider acknowledgement transitions', () => {
  it('maps only the provider status words that acknowledge a message', () => {
    expect(
      ['sent', 'delivered', 'read', 'failed', 'deleted', 'constructor'].map(providerAckState)
    ).toEqual(['SENT', 'DELIVERED', 'READ', 'FAILED', null, null]);
  });

  it.each([
    ['SENT', 'DELIVERED', 'APPLIED', true],
    ['SENT', 'READ', 'APPLIED', true],
    ['DELIVERED', 'READ', 'APPLIED', true],
    ['SENT', 'FAILED', 'APPLIED', false],
    ['SENT', 'SENT', 'DUPLICATE', false],
    ['DELIVERED', 'DELIVERED', 'DUPLICATE', false],
    ['READ', 'READ', 'DUPLICATE', false],
    ['FAILED', 'FAILED', 'DUPLICATE', false],
    ['READ', 'DELIVERED', 'STALE', false],
    ['DELIVERED', 'SENT', 'STALE', false],
    ['DELIVERED', 'FAILED', 'STALE', false],
    ['READ', 'FAILED', 'STALE', false],
    ['FAILED', 'DELIVERED', 'STALE', false],
    ['PENDING', 'DELIVERED', 'UNBOUND', false],
    ['IGNORED', 'SENT', 'UNBOUND', false],
  ] as const)('%s + %s ack -> %s', async (current, state, expected, marksCapture) => {
    const { fake, outcome } = apply([refillLog(current)], state);
    await expect(outcome).resolves.toBe(expected);
    expect(fake.updateMany).toHaveBeenCalledTimes(expected === 'APPLIED' ? 1 : 0);
    expect(fake.captures).toHaveLength(marksCapture ? 1 : 0);
  });

  it('locks the one outbound log of this tenant that carries the message id', async () => {
    const { fake, outcome } = apply([refillLog('SENT')], 'DELIVERED');
    await outcome;
    const lock = fake.queries[0]!;
    const sql = lock.text.replace(/\s+/g, ' ');
    expect(sql).toContain('"organizationId" = $1 AND "providerMessageId" = $2');
    expect(sql).toContain(`"direction" = 'OUTBOUND'`);
    expect(sql).toContain('FOR UPDATE');
    expect(lock.values).toEqual(['org-a', 'wamid.a']);
  });

  it('compares and sets the locked state, and stamps the provider time', async () => {
    const { fake, outcome } = apply([refillLog('DELIVERED')], 'READ');
    await outcome;
    expect(fake.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'log-a', status: 'DELIVERED' },
      data: { status: 'READ', statusAt: AT, readAt: AT },
    });
    // The capture is matched by the log's tenant, branch, capture and id.
    expect(fake.captures[0]!.values).toEqual(
      expect.arrayContaining(['org-a', 'branch-a', 'capture-a', 'log-a', 'wamid.a', AT])
    );
  });

  it('records a provider failure without touching the capture', async () => {
    const { fake, outcome } = apply([refillLog('SENT')], 'FAILED');
    await expect(outcome).resolves.toBe('APPLIED');
    expect(fake.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'log-a', status: 'SENT' },
      data: { status: 'FAILED', statusAt: AT, error: 'PROVIDER_FAILURE' },
    });
    expect(fake.captures).toEqual([]);
  });

  it('fails closed on a missing or ambiguous log', async () => {
    await expect(apply([], 'DELIVERED').outcome).resolves.toBe('UNBOUND');
    await expect(
      apply([refillLog('SENT'), { ...refillLog('SENT'), id: 'log-b' }], 'DELIVERED').outcome
    ).resolves.toBe('UNBOUND');
  });

  it('rejects a future or invalid timestamp before reading anything', async () => {
    for (const occurredAt of [new Date(NOW.getTime() + 1_000), new Date(Number.NaN)]) {
      const { fake, outcome } = apply([refillLog('SENT')], 'DELIVERED', occurredAt);
      await expect(outcome).resolves.toBe('REJECTED');
      expect(fake.queries).toEqual([]);
    }
  });

  it('leaves non-refill messages without a capture transition', async () => {
    const { fake, outcome } = apply(
      [{ ...refillLog('SENT'), kind: 'KHATA_REMINDER', refillCaptureId: null }],
      'DELIVERED'
    );
    await expect(outcome).resolves.toBe('APPLIED');
    expect(fake.captures).toEqual([]);
  });
});
