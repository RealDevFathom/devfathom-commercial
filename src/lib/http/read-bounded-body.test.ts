import { expect, it, vi } from 'vitest';

import { readBoundedBody } from './read-bounded-body';

it('refuses a declared overflow before acquiring a reader', async () => {
  const request = new Request('https://tenant.example.test', {
    method: 'POST',
    headers: { 'content-length': '4' },
    body: '1234',
  });
  const reader = vi.spyOn(request.body!, 'getReader');
  expect(await readBoundedBody(request, 3)).toBeNull();
  expect(reader).not.toHaveBeenCalled();
  expect(request.bodyUsed).toBe(false);
});

it('returns exactly the wire bytes at the limit across chunk boundaries', async () => {
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0xc3, 0xa9]);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 4));
      controller.enqueue(bytes.subarray(4));
      controller.close();
    },
  });
  const request = new Request('https://tenant.example.test', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
  expect(await readBoundedBody(request, bytes.length)).toEqual(Buffer.from(bytes));
});
