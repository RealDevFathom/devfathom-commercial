// @vitest-environment node
import { createHmac, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { authenticateWaha, parseWahaEvent } from './waha-webhook';
const secret = randomBytes(48);
const now = Date.now();
const raw = Buffer.from(
  JSON.stringify({
    id: 'event-a',
    timestamp: now,
    session: 'scope-a',
    event: 'message.ack',
    payload: { fromMe: true, id: 'outbound', ack: 2 },
  })
);
const headers = new Headers({
  'X-Webhook-Hmac-Algorithm': 'sha512',
  'X-Webhook-Request-Id': 'request-a',
  'X-Webhook-Timestamp': String(now),
  'X-Webhook-Hmac': createHmac('sha512', secret).update(raw).digest('hex'),
});
it('authenticates exact raw bytes and rejects invalid, stale or incomplete transport headers', () => {
  expect(authenticateWaha(raw, headers, secret, now)).toBe(true);
  expect(authenticateWaha(Buffer.from('unrelated'), headers, secret, now)).toBe(false);
  expect(authenticateWaha(raw, headers, secret, now + 600000)).toBe(false);
  const missing = new Headers(headers);
  missing.delete('x-webhook-hmac-algorithm');
  expect(authenticateWaha(raw, missing, secret, now)).toBe(false);
});
it('cross-checks the signed session and distinguishes delivery from read', () => {
  expect(parseWahaEvent(raw, 'scope-b')).toBeNull();
  const delivered = parseWahaEvent(raw, 'scope-a');
  const read = parseWahaEvent(Buffer.from(raw.toString().replace('"ack":2', '"ack":3')), 'scope-a');
  expect(delivered?.kind).toBe('ack');
  expect(read?.semanticKey).not.toBe(delivered?.semanticKey);
});
