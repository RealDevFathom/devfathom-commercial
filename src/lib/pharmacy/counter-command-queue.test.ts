import { randomBytes, webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

import { authenticatePharmacyCommand, signPharmacyCommand } from './sales';
import { hashDeviceSecret } from '@/lib/retail-terminal/device-secret';
import { counterReplaySchema } from '@/server/routers/pharmacy-offline';

import {
  applyCounterReplayOutcome,
  buildCounterReplayRequest,
  createCounterQueue,
  enqueueCounterCommand,
} from './counter-command-queue';

afterEach(() => vi.unstubAllGlobals());

it('composes on HTTP LAN and signs the final route-valid body across retry', async () => {
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
        leasedReceipt: {
          leaseId: 'lease-1',
          originalSaleAt: '2026-09-08T00:00:00.000Z',
          envelope: {
            organizationId: 'org-1',
            branchId: 'branch-1',
            deviceId: 'counter-test',
            kind: 'RULES',
            version: 1,
            payloadHash: 'a'.repeat(64),
            issuedAt: '2026-09-07T00:00:00.000Z',
            expiresAt: '2026-09-09T00:00:00.000Z',
            safetyLease: {
              issuedAt: '2026-09-07T00:00:00.000Z',
              expiresAt: '2026-09-09T00:00:00.000Z',
              recallVersion: 0,
              licenceVersion: 1,
              ruleVersion: 1,
            },
            signingKeyId: 'key-1',
          },
          signature: 'snapshot-signature',
        },
        sequence: 999,
        idempotencyKey: 'untrusted-payload-key',
        snapshots: [],
        lines: [
          {
            medicineId: 'med-1',
            presentationId: 'presentation-1',
            packLevelId: 'pack-1',
            saleUnit: 'UNIT',
            quantity: 1,
            canonicalUnitsPerSaleUnit: 1,
            inventoryLotId: 'lot-1',
            stockLocationId: 'location-1',
          },
        ],
        amountMinor: 100,
        cashReceivedMinor: 100,
      },
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
  const deviceSecret = `pcd_${randomBytes(32).toString('base64url')}`;
  const signer = (body: Record<string, unknown>, receipt: Record<string, unknown>) => ({
    command: signPharmacyCommand(
      { organizationId: 'org-1', branchId: 'branch-1' },
      'counter-test',
      body,
      deviceSecret
    ),
    receipt: signPharmacyCommand(
      { organizationId: 'org-1', branchId: 'branch-1' },
      'counter-test',
      receipt,
      deviceSecret
    ),
  });
  const first = await buildCounterReplayRequest(result.snapshot, result.command, signer);
  expect(first).toMatchObject({
    path: '/api/pharmacy/counter/replay',
    method: 'POST',
    headers: {
      'X-Command-Signature': signer(first.body, first.body.leasedReceipt as Record<string, unknown>)
        .command,
      'X-Receipt-Signature': signer(first.body, first.body.leasedReceipt as Record<string, unknown>)
        .receipt,
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
  expect(counterReplaySchema.parse(first.body)).toEqual(first.body);
  const authenticationDb = {
    $queryRaw: async () => [{ deviceSecretHash: hashDeviceSecret(deviceSecret) }],
  };
  await expect(
    authenticatePharmacyCommand(
      authenticationDb as never,
      { organizationId: 'org-1', branchId: 'branch-1' },
      'counter-test',
      first.body,
      { deviceSecret, signature: first.headers['X-Command-Signature'] }
    )
  ).resolves.toBeUndefined();
  await expect(
    authenticatePharmacyCommand(
      authenticationDb as never,
      { organizationId: 'org-1', branchId: 'branch-1' },
      'counter-test',
      first.body.leasedReceipt,
      { deviceSecret, signature: first.headers['X-Receipt-Signature'] }
    )
  ).resolves.toBeUndefined();
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
  expect(
    await buildCounterReplayRequest(retry.snapshot, retry.snapshot.commands[0]!, signer)
  ).toEqual(first);
});
