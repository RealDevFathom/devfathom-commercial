import { afterEach, expect, it, vi } from 'vitest';
import type { CounterReplayRequest } from './counter-command-queue';
import { sendCounterReplay } from './counter-replay-transport';

const request: CounterReplayRequest = {
  path: '/api/pharmacy/counter/replay',
  method: 'POST',
  headers: {
    'Idempotency-Key': 'receipt-a',
    'X-Command-Signature': 'command',
    'X-Receipt-Signature': 'receipt',
  },
  body: { sequence: 1 },
};
afterEach(() => vi.restoreAllMocks());

it('keeps a receipt pending if the response is HTML or has no booking reference', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const response of [
    new Response('<html>Sign in</html>'),
    Response.json({}),
    Response.json({ saleId: '' }),
  ]) {
    fetch.mockResolvedValueOnce(response);
    expect(await sendCounterReplay('test-token', request)).toMatchObject({ status: 503 });
  }
});

it('requires an audited rejection before acknowledging a manager review', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ status: 'PENDING', commandId: 'server-command' })
  );
  expect(await sendCounterReplay('test-token', request, 'Reviewed with cashier')).toMatchObject({
    status: 503,
  });
});
