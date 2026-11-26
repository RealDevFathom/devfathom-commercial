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

it('sends the original command and supervisor note to the retry route and requires a booking', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ saleId: 'sale-1' }));
  expect(await sendCounterReplay('test-token', request, 'Drawer opened', 'retry')).toMatchObject({
    serverRef: 'sale-1',
  });
  expect(fetch).toHaveBeenCalledWith(
    '/api/pharmacy/counter/retry',
    expect.objectContaining({
      body: JSON.stringify({ command: request.body, reason: 'Drawer opened' }),
      headers: expect.objectContaining(request.headers),
    })
  );
});
