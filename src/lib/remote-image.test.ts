import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  httpsRequest: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('node:dns/promises', () => ({ lookup: mocks.dnsLookup }));
vi.mock('node:https', () => ({ request: mocks.httpsRequest }));

import { loadRemoteImage } from './remote-image';

class FakeRequest extends EventEmitter {
  setTimeout = vi.fn();
  end = vi.fn();
  destroy = vi.fn((error: Error) => this.emit('error', error));
}

describe('loadRemoteImage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => vi.useRealTimers());

  it('enforces an absolute deadline even while the response remains active', async () => {
    const request = new FakeRequest();
    const response = Object.assign(new EventEmitter(), {
      headers: { 'content-type': 'image/png' },
      statusCode: 200,
    });
    mocks.httpsRequest.mockReturnValue(request);

    const result = loadRemoteImage('https://93.184.216.34/logo.png');
    expect(request.end).toHaveBeenCalled();
    request.emit('response', response);

    for (let elapsed = 0; elapsed < 5_000; elapsed += 1_000) {
      response.emit('data', Buffer.from([0]));
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await expect(result).rejects.toThrow('Logo request timed out.');
    expect(request.destroy).toHaveBeenCalledOnce();
  });
});
