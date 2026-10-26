import { afterEach, expect, it, vi } from 'vitest';

import {
  applyCounterReplayOutcome,
  buildCounterReplayRequest,
  createCounterQueue,
} from './counter-command-queue';

afterEach(() => vi.unstubAllGlobals());

it('composes on HTTP LAN and preserves the command key across persisted replay and retry', () => {
  const snapshot = createCounterQueue('counter-test');
  const command = {
    commandId: 'command-1',
    idempotencyKey: 'command-1',
    sequence: 1,
    action: 'CASH_OTC_SALE' as const,
    payload: {
      leasedReceipt: {},
      snapshots: [],
      lines: [],
      amountMinor: 100,
      cashReceivedMinor: 100,
    },
    authentication: { commandSignature: 'command-mac', receiptSignature: 'receipt-mac' },
    clientOriginAt: '2026-09-08T00:00:00.000Z',
    receiptNumber: 1,
    status: 'PENDING' as const,
    attempts: 0,
    serverRef: null,
    rejection: null,
  };
  snapshot.commands.push(command);
  const first = buildCounterReplayRequest(snapshot, command);
  expect(first).toMatchObject({
    path: '/api/pharmacy/counter/replay',
    headers: {
      'Idempotency-Key': 'command-1',
      'X-Command-Signature': 'command-mac',
      'X-Receipt-Signature': 'receipt-mac',
    },
    body: { sequence: 1, idempotencyKey: 'command-1', action: 'CASH_OTC_SALE' },
  });
  expect(first.body).not.toHaveProperty('payload');
  expect(first.body).not.toHaveProperty('deviceId');
  const retry = applyCounterReplayOutcome(JSON.parse(JSON.stringify(snapshot)), {
    commandId: command.commandId,
    outcome: { action: 'RETRY', reason: 'NETWORK', retryAfterMs: null },
  });
  expect(buildCounterReplayRequest(retry.snapshot, retry.snapshot.commands[0]!)).toEqual(first);
});
