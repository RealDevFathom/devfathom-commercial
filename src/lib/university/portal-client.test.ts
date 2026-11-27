// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postPortalAction } from './portal-client';

afterEach(() => vi.unstubAllGlobals());

describe('learner portal registration retries', () => {
  const request = { id: 'section-1' };
  const receipt = { id: 'enrollment-1', status: 'ENROLLED' };

  it('repeats the same registration after losing the first response', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Network connection lost'))
      .mockResolvedValueOnce(Response.json(receipt));
    vi.stubGlobal('fetch', fetch);

    expect(await postPortalAction('register', request)).toEqual(receipt);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]);
  });

  it('stops after the second transport failure', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Network connection lost'));
    vi.stubGlobal('fetch', fetch);
    await expect(postPortalAction('register', request)).rejects.toThrow('Network connection lost');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 409, 500])('returns an explicit HTTP %s without retrying', async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ error: 'Registration denied' }, { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(postPortalAction('register', request)).rejects.toThrow('Registration denied');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit rejection when its response body is interrupted', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.reject(new TypeError('Response stream closed')),
    });
    vi.stubGlobal('fetch', fetch);
    await expect(postPortalAction('register', request)).rejects.toThrow('Request unavailable.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['submit', 'accept', 'withdraw', 'upload-part'])(
    'does not replay a failed %s action',
    async (action) => {
      const fetch = vi.fn().mockRejectedValue(new TypeError('Offline'));
      vi.stubGlobal('fetch', fetch);
      await expect(postPortalAction(action, request)).rejects.toThrow('Offline');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
});
