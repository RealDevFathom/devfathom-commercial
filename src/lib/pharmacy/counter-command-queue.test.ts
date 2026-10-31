import { afterEach, expect, it, vi } from 'vitest';

import {
  applyCounterReplayOutcome,
  buildCounterReplayRequest,
  createCounterQueue,
} from './counter-command-queue';
import { counterReplaySchema } from './counter-replay-contract';

const envelope = {
  organizationId: 'org',
  branchId: 'branch',
  deviceId: 'counter-test',
  kind: 'RULES' as const,
  version: 1,
  payloadHash: 'a'.repeat(64),
  issuedAt: '2026-09-08T00:00:00.000Z',
  expiresAt: '2026-09-09T00:00:00.000Z',
  safetyLease: {
    issuedAt: '2026-09-08T00:00:00.000Z',
    expiresAt: '2026-09-09T00:00:00.000Z',
    recallVersion: 1,
    licenceVersion: 1,
    ruleVersion: 1,
  },
  signingKeyId: 'key',
};

afterEach(() => vi.unstubAllGlobals());

it('composes on HTTP LAN and preserves the command key across persisted replay and retry', () => {
  const snapshot = createCounterQueue('counter-test');
  snapshot.leases.push({ leaseId: 'lease', blockStart: 1, blockEnd: 10, nextNumber: 2 });
  const command = {
    commandId: 'command-1',
    idempotencyKey: 'command-1',
    sequence: 1,
    action: 'CASH_OTC_SALE' as const,
    payload: {
      leasedReceipt: {
        leaseId: 'lease',
        receiptNumber: 1,
        originalSaleAt: '2026-09-08T00:00:00.000Z',
        envelope,
        signature: 'snapshot-mac',
      },
      snapshots: [],
      lines: [
        {
          medicineId: 'medicine',
          presentationId: 'presentation',
          packLevelId: 'pack',
          saleUnit: 'UNIT' as const,
          quantity: 1,
          canonicalUnitsPerSaleUnit: 1,
          inventoryLotId: 'lot',
          stockLocationId: 'location',
        },
      ],
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
  Object.assign(command.payload, {
    sequence: 999,
    idempotencyKey: 'payload-controlled',
    action: 'CONTROLLED_MEDICINE_SALE',
  });
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
  expect(counterReplaySchema.parse(first.body)).toEqual(first.body);
  expect(first.body).not.toHaveProperty('payload');
  expect(first.body).not.toHaveProperty('deviceId');
  expect(counterReplaySchema.safeParse({ ...first.body, payload: command.payload }).success).toBe(
    false
  );
  const retry = applyCounterReplayOutcome(JSON.parse(JSON.stringify(snapshot)), {
    commandId: command.commandId,
    outcome: { action: 'RETRY', reason: 'NETWORK', retryAfterMs: null },
  });
  expect(buildCounterReplayRequest(retry.snapshot, retry.snapshot.commands[0]!)).toEqual(first);

  expect(() =>
    buildCounterReplayRequest(snapshot, { ...command, idempotencyKey: 'different-command-key' })
  ).toThrow('INVALID_REPLAY_CONTRACT');
  expect(() =>
    buildCounterReplayRequest(snapshot, {
      ...command,
      authentication: { ...command.authentication, receiptSignature: '' },
    })
  ).toThrow('INVALID_REPLAY_CONTRACT');
  expect(() =>
    buildCounterReplayRequest(snapshot, { ...command, action: 'PROVISIONAL_CLOSE' })
  ).toThrow('INVALID_REPLAY_CONTRACT');
  expect(() => buildCounterReplayRequest(snapshot, { ...command, payload: {} })).toThrow(
    'INVALID_REPLAY_CONTRACT'
  );
  expect(() =>
    buildCounterReplayRequest(snapshot, {
      ...command,
      payload: {
        ...command.payload,
        leasedReceipt: { ...command.payload.leasedReceipt, leaseId: 'different-lease' },
      },
    })
  ).toThrow('INVALID_REPLAY_CONTRACT');
});
