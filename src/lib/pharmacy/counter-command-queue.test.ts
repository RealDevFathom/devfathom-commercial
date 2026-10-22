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
  const signatures = {
    commandSignature: 'command-hmac',
    receiptSignature: 'receipt-hmac',
    authorization: 'Bearer pcd_test',
    terminalSession: 'session-test',
  };
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
  const envelope = {
    organizationId: 'org-1',
    branchId: 'branch-1',
    deviceId: 'device-1',
    kind: 'RULES' as const,
    version: 1,
    payloadHash: 'a'.repeat(64),
    issuedAt: '2026-10-22T00:00:00.000Z',
    expiresAt: '2026-10-22T08:00:00.000Z',
    safetyLease: {
      issuedAt: '2026-10-22T00:00:00.000Z',
      expiresAt: '2026-10-22T08:00:00.000Z',
      recallVersion: 1,
      licenceVersion: 1,
      ruleVersion: 1,
    },
    signingKeyId: 'key-1',
  };
  const leasedReceipt = {
    leaseId: 'lease-1',
    receiptNumber: 12,
    originalSaleAt: '2026-10-22T01:00:00.000Z',
    envelope,
    signature: 'snapshot-signature',
  };
  const lines = [
    {
      medicineId: 'medicine-1',
      presentationId: 'presentation-1',
      packLevelId: 'pack-1',
      saleUnit: 'UNIT' as const,
      quantity: 1,
      canonicalUnitsPerSaleUnit: 1,
      inventoryLotId: 'lot-1',
      stockLocationId: 'location-1',
    },
  ];
  const command = {
    commandId: 'command-1',
    idempotencyKey: 'command-1',
    sequence: 7,
    action: 'CASH_OTC_SALE' as const,
    payload: {
      leasedReceipt,
      snapshots: [{ envelope, signature: 'signed', payload: {} }],
      lines,
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
      authorization: 'Bearer pcd_test',
      terminalSession: 'session-test',
    })
  ).toEqual({
    path: '/api/pharmacy/counter/replay',
    method: 'POST',
    headers: {
      'Idempotency-Key': 'command-1',
      'X-Command-Signature': 'command-hmac',
      'X-Receipt-Signature': 'receipt-hmac',
      Authorization: 'Bearer pcd_test',
      'X-Terminal-Session': 'session-test',
    },
    body: {
      leasedReceipt,
      snapshots: [{ envelope, signature: 'signed', payload: {} }],
      lines,
      amountMinor: 500,
      cashReceivedMinor: 500,
      sequence: 7,
      idempotencyKey: 'command-1',
      action: 'CASH_OTC_SALE',
    },
  });
});
