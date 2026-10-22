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
  const result = enqueueCounterCommand(
    createCounterQueue('counter-test'),
    {
      deviceId: 'counter-test',
      action: 'PROVISIONAL_CLOSE',
      payload: {},
      clientOriginAt: '2026-09-08T00:00:00.000Z',
    },
    {
      nowMs: 1,
      snapshots: [{ kind: 'RULES', verified: true, expiresAtMs: 2 }],
      cachedCreditRemainingMinor: 0,
      controlledMedicinesPermittedOffline: false,
      originalSaleAvailable: false,
      deviceUsable: true,
    }
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  const signatures = { commandSignature: 'command-hmac', receiptSignature: 'receipt-hmac' };
  const first = buildCounterReplayRequest(result.command, signatures);
  expect(first.headers['Idempotency-Key']).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  const retry = applyCounterReplayOutcome(JSON.parse(JSON.stringify(result.snapshot)), {
    commandId: result.command.commandId,
    outcome: { action: 'RETRY', reason: 'NETWORK', retryAfterMs: null },
  });
  expect(buildCounterReplayRequest(retry.snapshot.commands[0]!, signatures)).toEqual(first);
});

it('targets the replay route with the strict flat body and both authentication headers', () => {
  const command = {
    commandId: 'command-1',
    idempotencyKey: 'command-1',
    sequence: 7,
    action: 'CASH_OTC_SALE' as const,
    payload: {
      leasedReceipt: { leaseId: 'lease-1', receiptNumber: 12 },
      snapshots: [{ envelope: { kind: 'RULES' }, signature: 'signed', payload: {} }],
      lines: [{ medicineId: 'medicine-1', quantity: 1 }],
      amountMinor: 500,
      cashReceivedMinor: 500,
    },
    clientOriginAt: '2026-10-22T00:00:00.000Z',
    receiptNumber: 12,
    status: 'PENDING' as const,
    attempts: 0,
    serverRef: null,
    rejection: null,
  };

  expect(
    buildCounterReplayRequest(command, {
      commandSignature: 'command-hmac',
      receiptSignature: 'receipt-hmac',
    })
  ).toEqual({
    path: '/api/pharmacy/counter/replay',
    method: 'POST',
    headers: {
      'Idempotency-Key': 'command-1',
      'X-Command-Signature': 'command-hmac',
      'X-Receipt-Signature': 'receipt-hmac',
    },
    body: {
      leasedReceipt: { leaseId: 'lease-1', receiptNumber: 12 },
      snapshots: [{ envelope: { kind: 'RULES' }, signature: 'signed', payload: {} }],
      lines: [{ medicineId: 'medicine-1', quantity: 1 }],
      amountMinor: 500,
      cashReceivedMinor: 500,
      sequence: 7,
      idempotencyKey: 'command-1',
      action: 'CASH_OTC_SALE',
    },
  });
});
