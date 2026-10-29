import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

import {
  applyCounterReplayOutcome,
  buildCounterReplayRequest,
  createCounterQueue,
  enqueueCounterCommand,
} from './counter-command-queue';

afterEach(() => vi.unstubAllGlobals());

it('composes on HTTP LAN and preserves the command key across persisted replay and retry', () => {
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const queue = createCounterQueue('counter-test');
  queue.leases = [{ leaseId: 'lease-1', blockStart: 1, blockEnd: 1, nextNumber: 1 }];
  queue.quotas = [
    {
      inventoryLotId: 'lot-1',
      stockLocationId: 'location-1',
      quotaUnits: 1,
      consumedUnits: 0,
    },
  ];
  const result = enqueueCounterCommand(
    queue,
    {
      deviceId: 'counter-test',
      action: 'CASH_OTC_SALE',
      payload: {
        leasedReceipt: { leaseId: 'lease-1' },
        sequence: 999,
        idempotencyKey: 'untrusted-payload-key',
        snapshots: [],
        lines: [{ medicineId: 'med-1' }],
        amountMinor: 100,
        cashReceivedMinor: 100,
      },
      replaySignatures: { command: 'command-signature', receipt: 'receipt-signature' },
      clientOriginAt: '2026-09-08T00:00:00.000Z',
      bucket: { inventoryLotId: 'lot-1', stockLocationId: 'location-1' },
      requestedUnits: 1,
    },
    {
      nowMs: 1,
      snapshots: ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'].map((kind) => ({
        kind: kind as 'CATALOG' | 'PRICES' | 'TAX' | 'RULES' | 'LOT_BALANCES',
        verified: true,
        expiresAtMs: 2,
      })),
      cachedCreditRemainingMinor: 0,
      controlledMedicinesPermittedOffline: false,
      originalSaleAvailable: false,
      deviceUsable: true,
      safetyLeaseOk: true,
    }
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  const first = buildCounterReplayRequest(result.snapshot, result.command);
  expect(first).toMatchObject({
    path: '/api/pharmacy/counter/replay',
    method: 'POST',
    headers: {
      'X-Command-Signature': 'command-signature',
      'X-Receipt-Signature': 'receipt-signature',
    },
    body: {
      sequence: 1,
      idempotencyKey: result.command.idempotencyKey,
      action: 'CASH_OTC_SALE',
      leasedReceipt: { leaseId: 'lease-1', receiptNumber: 1 },
      amountMinor: 100,
      cashReceivedMinor: 100,
    },
  });
  expect(first.body).not.toHaveProperty('deviceId');
  expect(first.body).not.toHaveProperty('payload');
  expect(first.body).not.toHaveProperty('clientOriginAt');
  expect(first.body).not.toHaveProperty('receiptNumber');
  expect(first.headers['Idempotency-Key']).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  const retry = applyCounterReplayOutcome(JSON.parse(JSON.stringify(result.snapshot)), {
    commandId: result.command.commandId,
    outcome: { action: 'RETRY', reason: 'NETWORK', retryAfterMs: null },
  });
  expect(buildCounterReplayRequest(retry.snapshot, retry.snapshot.commands[0]!)).toEqual(first);
});
