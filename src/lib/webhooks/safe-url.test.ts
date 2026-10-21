import { describe, expect, it, vi } from 'vitest';
import {
  assertWebhookUrl,
  assertWebhookUrlAllowed,
  deliverWebhookRequest,
  isBlockedAddress,
  WebhookUrlError,
} from './safe-url';

const publicAnswer = [{ address: '8.8.8.8', family: 4 }];

describe('webhook URL policy', () => {
  it.each([
    'file:///etc/passwd',
    'http://user:pass@example.com/hook',
    'http://localhost/hook',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://db.internal/hook',
    'http://printer.local/hook',
    'http://app.localhost/hook',
    'http://2130706433/hook',
    'http://127.0.0.1/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/hook',
    'http://100.64.0.1/hook',
    'http://192.0.0.1/hook',
    'http://192.88.99.1/hook',
    'http://192.0.2.1/hook',
    'http://198.18.0.1/hook',
    'http://198.51.100.1/hook',
    'http://203.0.113.1/hook',
    'http://[::1]/hook',
    'http://[64:ff9b::1]/hook',
    'http://[64:ff9b:1::1]/hook',
    'http://[100::1]/hook',
    'http://[2001:db8::1]/hook',
    'http://[2002:db8::1]/hook',
    'http://[fd00::1]/hook',
    'http://0177.0.0.1/hook',
  ])('rejects %s before any connection', (raw) => {
    expect(() => assertWebhookUrl(raw)).toThrow(WebhookUrlError);
  });

  it('blocks private, loopback, link-local, and metadata addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '100.127.255.255',
      '192.0.0.1',
      '192.0.0.8',
      '192.0.0.255',
      '192.88.99.1',
      '192.88.99.255',
      '192.0.2.1',
      '198.18.0.1',
      '198.19.255.1',
      '198.51.100.1',
      '203.0.113.1',
      '::1',
      '::192.0.2.1',
      '64:ff9b::1',
      '64:ff9b::808:808',
      '64:ff9b:1::1',
      '64:ff9b:1:ffff::1',
      '100::1',
      '100::ffff:ffff:ffff:ffff',
      '2001:db8::1',
      '2001:db8:ffff::1',
      '2002:808:808::',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:100.64.0.1',
      '::ffff:203.0.113.1',
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('100.128.0.1')).toBe(false);
    expect(isBlockedAddress('198.20.0.1')).toBe(false);
    expect(isBlockedAddress('192.0.1.1')).toBe(false);
    expect(isBlockedAddress('192.0.3.1')).toBe(false);
    expect(isBlockedAddress('64:ff9b:2::1')).toBe(false);
    expect(isBlockedAddress('192.88.98.1')).toBe(false);
    expect(isBlockedAddress('192.88.100.1')).toBe(false);
    expect(isBlockedAddress('100:0:0:1::')).toBe(false);
    expect(isBlockedAddress('2001:db9::1')).toBe(false);
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('rejects a public name when any DNS answer is private', async () => {
    const lookup = vi.fn(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(
      assertWebhookUrlAllowed('https://example.com/hook', lookup)
    ).rejects.toBeInstanceOf(WebhookUrlError);
    expect(lookup).toHaveBeenCalledWith('example.com');
  });

  it('connects to the resolved address and does not follow a redirect', async () => {
    const request = vi.fn(async () => ({ statusCode: 302 }));
    const result = await deliverWebhookRequest(
      'https://example.com/hook',
      { headers: { 'X-Test': '1' }, body: '{}', timeoutMs: 1000 },
      { lookup: async () => publicAnswer, request }
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ address: '8.8.8.8', family: 4 })
    );
    expect(result).toEqual({ statusCode: 302, success: false, error: 'HTTP 302' });
    expect(result.error).not.toMatch(/location|10\.|127\./i);
  });

  it('hides resolver and socket details from the tenant-facing error', async () => {
    const blocked = await deliverWebhookRequest(
      'https://rebind.example/hook',
      { headers: {}, body: '', timeoutMs: 1000 },
      { lookup: async () => [{ address: '169.254.169.254', family: 4 }] }
    );
    expect(blocked.error).toBe('Webhook URL is not allowed.');

    const failed = await deliverWebhookRequest(
      'https://example.com/hook',
      { headers: {}, body: '', timeoutMs: 1000 },
      {
        lookup: async () => publicAnswer,
        request: async () => {
          throw new Error('connect ECONNREFUSED 169.254.169.254:443');
        },
      }
    );
    expect(failed).toEqual({ statusCode: null, success: false, error: 'Delivery failed' });

    const timedOut = await deliverWebhookRequest(
      'https://example.com/hook',
      { headers: {}, body: '', timeoutMs: 1000 },
      {
        lookup: async () => publicAnswer,
        request: async () => {
          throw Object.assign(new Error('socket hang up at 10.0.0.5'), { code: 'TIMEOUT' });
        },
      }
    );
    expect(timedOut.error).toBe('Delivery timed out');
  });
});
