import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  httpsRequest: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('node:dns/promises', () => ({
  default: { lookup: mocks.dnsLookup },
  lookup: mocks.dnsLookup,
}));
vi.mock('node:https', () => ({
  default: { request: mocks.httpsRequest },
  request: mocks.httpsRequest,
}));

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
    const rejected = expect(result).rejects.toThrow('Logo request timed out.');
    expect(request.end).toHaveBeenCalled();
    request.emit('response', response);

    for (let elapsed = 0; elapsed < 5_000; elapsed += 1_000) {
      response.emit('data', Buffer.from([0]));
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await rejected;
    expect(request.destroy).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'pins hostname connections to a validated address (all=%s)',
    async (all) => {
      const request = new FakeRequest();
      mocks.httpsRequest.mockReturnValue(request);

      const result = loadRemoteImage('https://cdn.example.com/logo.png');
      await vi.waitFor(() => expect(request.end).toHaveBeenCalled());

      const lookup = mocks.httpsRequest.mock.calls[0]![1].lookup;
      const callback = vi.fn();
      lookup('cdn.example.com', { all }, callback);
      if (all) {
        expect(callback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
      } else {
        expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
      }

      const response = Object.assign(new EventEmitter(), {
        headers: { 'content-type': 'image/png' },
        statusCode: 200,
      });
      request.emit('response', response);
      response.emit('data', Buffer.from([1, 2, 3]));
      response.emit('end');
      await expect(result).resolves.toEqual({
        body: Buffer.from([1, 2, 3]),
        contentType: 'image/png',
      });
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([
    { statusCode: 302, contentType: 'image/png' },
    { statusCode: 200, contentType: 'text/html' },
  ])('closes unsupported responses immediately: %o', async ({ statusCode, contentType }) => {
    const request = new FakeRequest();
    const response = Object.assign(new EventEmitter(), {
      headers: { 'content-type': contentType },
      statusCode,
      destroy: vi.fn(),
      resume: vi.fn(),
    });
    mocks.httpsRequest.mockReturnValue(request);

    const result = loadRemoteImage('https://93.184.216.34/logo.png');
    request.emit('response', response);

    await expect(result).rejects.toThrow('Logo server did not return a supported image.');
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(response.resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes supported images that exceed the size limit', async () => {
    const request = new FakeRequest();
    const response = Object.assign(new EventEmitter(), {
      headers: { 'content-type': 'image/png' },
      statusCode: 200,
    });
    mocks.httpsRequest.mockReturnValue(request);

    const result = loadRemoteImage('https://93.184.216.34/logo.png');
    request.emit('response', response);
    response.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1));

    await expect(result).rejects.toThrow('Logo exceeds the size limit.');
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects DNS responses containing a private address before making a request', async () => {
    mocks.dnsLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);

    await expect(loadRemoteImage('https://cdn.example.com/logo.png')).rejects.toThrow(
      'Logo URL may not resolve to a local or private network.'
    );
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });
});
