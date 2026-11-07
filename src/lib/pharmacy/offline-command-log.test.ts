import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { commandPayloadHash, recordOfflineCommand } from './offline-command-log';

const scope = { organizationId: 'org_a', branchId: 'branch_a' };
const input = {
  deviceId: 'counter_1',
  sequence: 1,
  idempotencyKey: 'command_1',
  action: 'CASH_OTC_SALE' as const,
  payload: { units: 1 },
  clientOriginAt: new Date('2026-09-02T09:00:00.000Z'),
};

describe('offline command recording after a competing cursor claim', () => {
  it.each([
    { change: 'identical command', patch: {}, error: null },
    {
      change: 'different payload',
      patch: { payloadHash: commandPayloadHash({ units: 2 }) },
      error: 'IDEMPOTENCY_CONFLICT',
    },
    {
      change: 'different action',
      patch: { action: 'CONTROLLED_MEDICINE_SALE' },
      error: 'IDEMPOTENCY_CONFLICT',
    },
    {
      change: 'different key',
      patch: { idempotencyKey: 'command_2' },
      error: 'SEQUENCE_CONFLICT',
    },
  ])('handles a concurrently committed $change', async ({ patch, error }) => {
    const committed = {
      ...scope,
      ...input,
      id: 'stored_command',
      payloadHash: commandPayloadHash(input.payload),
      status: 'PENDING',
      attempts: 0,
      ...patch,
    };
    // The initial read misses the competing transaction's uncommitted row.
    // Its commit advances the cursor before our compare-and-increment finishes.
    const createMany = vi.fn();
    const db = {
      pharmacyRegisteredDevice: {
        findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE', revokedAt: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      pharmacyOfflineCommand: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(committed),
        createMany,
      },
    } as unknown as ScopedDb;

    const result = recordOfflineCommand(db, scope, input);
    if (error) {
      await expect(result).rejects.toThrow(error);
    } else {
      await expect(result).resolves.toEqual({ command: committed, replayed: true });
    }
    expect(createMany).not.toHaveBeenCalled();
  });
});
