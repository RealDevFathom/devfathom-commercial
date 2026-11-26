// @vitest-environment node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { WahaClient } from './waha-client';

const apiKey = randomBytes(32).toString('hex');
const session = 'synthetic-session';
const recipient = '12025550101';
let exists = true;
let redirect = false;
const calls: string[] = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  calls.push(url.pathname);
  if (req.headers['x-api-key'] !== apiKey) {
    res.writeHead(401).end();
    return;
  }
  if (redirect) {
    res.writeHead(307, { location: '/unexpected' }).end();
    return;
  }
  if (url.pathname === '/api/contacts/check-exists') {
    const valid =
      url.searchParams.get('phone') === recipient && url.searchParams.get('session') === session;
    res.end(JSON.stringify({ numberExists: exists && valid, chatId: recipient + '@c.us' }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const valid =
    body.session === session &&
    body.chatId === recipient + '@c.us' &&
    (url.pathname === '/api/sendText'
      ? body.text === 'Synthetic notice' && body.linkPreview === false
      : !!body.file.data &&
        !body.file.url &&
        body.file.mimetype ===
          (url.pathname === '/api/sendImage' ? 'image/png' : 'application/pdf'));
  res.writeHead(valid ? 201 : 422).end(JSON.stringify({ id: 'synthetic-outgoing' }));
});
let client: WahaClient;
beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('missing port');
  vi.stubEnv('PHARMACY_WAHA_BASE_URL', 'http://127.0.0.1:' + addr.port);
  client = new WahaClient(session, apiKey);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it('checks the number and sends text, an image and a PDF using the documented requests', async () => {
  await client.send(recipient, { text: 'Synthetic notice' });
  await client.send(recipient, { bytes: Buffer.from('synthetic'), mime: 'image/png' });
  await client.send(recipient, { bytes: Buffer.from('synthetic'), mime: 'application/pdf' });
  expect(calls).toEqual(
    ['sendText', 'sendImage', 'sendFile'].flatMap((method) => [
      '/api/contacts/check-exists',
      '/api/' + method,
    ])
  );
});
it('withholds sends to an absent number and does not follow redirects', async () => {
  calls.length = 0;
  exists = false;
  await expect(client.send(recipient, { text: 'Synthetic notice' })).rejects.toMatchObject({
    definitive: true,
  });
  redirect = true;
  await expect(client.send(recipient, { text: 'Synthetic notice' })).rejects.toThrow();
  expect(calls).toEqual(['/api/contacts/check-exists', '/api/contacts/check-exists']);
});

it('never dispatches to a different phone returned by a contact lookup', async () => {
  redirect = false;
  exists = true;
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ numberExists: true, chatId: '12025550199@c.us' }));
  try {
    await expect(client.send(recipient, { text: 'Synthetic notice' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    fetchMock.mockRestore();
  }
});
