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
  const first = buildCounterReplayRequest(result.snapshot, result.command);
  expect(first.headers['Idempotency-Key']).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  const retry = applyCounterReplayOutcome(JSON.parse(JSON.stringify(result.snapshot)), {
    commandId: result.command.commandId,
    outcome: { action: 'RETRY', reason: 'NETWORK', retryAfterMs: null },
  });
  expect(buildCounterReplayRequest(retry.snapshot, retry.snapshot.commands[0]!)).toEqual(first);
});
