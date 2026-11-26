// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UPLOAD_RATE_MESSAGE,
  UPLOAD_RATE_WINDOW_MS,
  UPLOADS_PER_BUSINESS_PER_WINDOW,
  UPLOADS_PER_USER_PER_WINDOW,
  uploadPost,
} from './multipart-request';
import { acquireLargeUploadSlot } from './large-upload-slot';
import { multipartUpload } from '../../../tests/fixtures/multipart-upload';

vi.mock('./large-upload-slot', () => ({ acquireLargeUploadSlot: vi.fn() }));
const acquire = vi.mocked(acquireLargeUploadSlot);
beforeEach(() => {
  acquire.mockReset();
});

it.each([null, '512', String(9 * 1024 * 1024)])(
  'refuses a large transfer at capacity with declared length %s',
  async (length) => {
    acquire.mockResolvedValue(null);
    const request = multipartUpload('/api/upload', 9);
    if (length) request.headers.set('content-length', length);
    const store = vi.fn();
    const response = await uploadPost(async (_, readUploadForm) => {
      const form = await readUploadForm('signed-in-user', 'business');
      if (form instanceof Response) return form;
      store();
      return new Response();
    })(request);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain('Wait for one to finish');
    expect(acquire).toHaveBeenCalledExactlyOnceWith('signed-in-user', 'business');
    expect(store).not.toHaveBeenCalled();
    if (Number(length) > 8 * 1024 * 1024) expect(request.bodyUsed).toBe(false);
  }
);

it.each([true, false])(
  'keeps the slot through storage and releases after handler success=%s',
  async (success) => {
    const release = vi.fn(async () => {});
    acquire.mockResolvedValue(release);
    const handle = uploadPost(async (_, readUploadForm) => {
      const form = await readUploadForm('signed-in-user', 'business');
      expect(form).toBeInstanceOf(FormData);
      expect(release).not.toHaveBeenCalled();
      if (!success) throw new Error('fixture storage failure');
      return new Response('stored');
    });
    const result = handle(multipartUpload('/api/upload', 9));
    if (success) expect(await (await result).text()).toBe('stored');
    else await expect(result).rejects.toThrow('fixture storage failure');
    expect(release).toHaveBeenCalledOnce();
  }
);

it('reads a small upload without taking a slot', async () => {
  const response = await uploadPost(async (_, read) => {
    expect(await read('user', 'business')).toBeInstanceOf(FormData);
    return new Response();
  })(multipartUpload('/api/upload', 1));
  expect(response.status).toBe(200);
  expect(acquire).not.toHaveBeenCalled();
});

it('returns a plain retry message when the slot store is unavailable', async () => {
  acquire.mockRejectedValue(new Error('private database detail'));
  const response = await uploadPost(async (_, read) => {
    const result = await read('user', 'business', 'text');
    if (!(result instanceof Response)) throw new Error('expected refusal');
    return result;
  })(multipartUpload('/api/restaurant/sop/evidence', 9));
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('Uploads are temporarily unavailable. Try again shortly.');
});

const handleJsonUpload = uploadPost(async (_, read) => {
  const result = await read('user', 'business');
  if (!(result instanceof Response)) throw new Error('expected refusal');
  return result;
});

it('times out a stalled body at 270 seconds and releases the slot once', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const release = vi.fn(async () => {});
    acquire.mockResolvedValue(release);
    const request = new Request('https://tenant.example.test/api/upload', {
      method: 'POST',
      headers: { 'content-length': String(10 * 1024 * 1024) },
      body: new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }),
      duplex: 'half',
    } as RequestInit);
    const pending = handleJsonUpload(request);
    await vi.advanceTimersByTimeAsync(269_999);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledOnce();
    const response = await pending;
    expect(response.status).toBe(408);
    expect(response.headers.get('Content-Type')).toMatch(/^text\/plain\b/);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('returns a plain 429 for business capacity on a JSON route', async () => {
  acquire.mockResolvedValue('organization-capacity');
  const request = multipartUpload('/api/upload', 10);
  request.headers.set('content-length', String(10 * 1024 * 1024));
  const response = await handleJsonUpload(request);
  expect(response.status).toBe(429);
  expect(response.headers.get('Content-Type')).toMatch(/^text\/plain\b/);
  expect(await response.text()).toBe('Large uploads are busy. Try again shortly.');
});

// DEV-1056: every upload counts against its user and its business before the body is read.
describe('upload rate limit', () => {
  /** A body that records whether anything tried to read it. */
  function unreadUpload() {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(16));
      controller.close();
    });
    const request = new Request('https://tenant.example.test/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }),
      duplex: 'half',
    } as RequestInit);
    return { request, pull };
  }
  const upload = (userId: string, organizationId: string, request?: Request) => {
    const stored = vi.fn();
    const response = uploadPost(async (_, read) => {
      const form = await read(userId, organizationId);
      if (form instanceof Response) return form;
      if (!form) return new Response('too large', { status: 413 });
      stored();
      return new Response('stored');
    })(request ?? multipartUpload('/api/upload', 0));
    return response.then((result) => ({ response: result, stored }));
  };
  const unique = () => crypto.randomUUID();

  it('takes every upload up to the user limit, then refuses before reading the body', async () => {
    const user = `user-${unique()}`;
    const business = `business-${unique()}`;
    for (let n = 0; n < UPLOADS_PER_USER_PER_WINDOW; n += 1) {
      const { response, stored } = await upload(user, business);
      expect(response.status).toBe(200);
      expect(stored).toHaveBeenCalledOnce();
    }
    const { request, pull } = unreadUpload();
    const { response, stored } = await upload(user, business, request);
    expect(response.status).toBe(429);
    expect(response.headers.get('Content-Type')).toMatch(/^text\/plain\b/);
    expect(await response.text()).toBe(UPLOAD_RATE_MESSAGE);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(600);
    // Nothing of the body was read, no slot was taken and nothing was stored.
    expect(pull).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
    expect(stored).not.toHaveBeenCalled();

    // Another user of the same business is unaffected, and so is another business.
    expect((await upload(`user-${unique()}`, business)).response.status).toBe(200);
    expect((await upload(`user-${unique()}`, `business-${unique()}`)).response.status).toBe(200);
    // The refused user stays refused, on every route format.
    const text = await uploadPost(async (_, read) => {
      const result = await read(user, business, 'text');
      if (!(result instanceof Response)) throw new Error('expected refusal');
      return result;
    })(multipartUpload('/api/restaurant/sop/evidence', 0));
    expect(text.status).toBe(429);
    expect(await text.text()).toBe(UPLOAD_RATE_MESSAGE);
  });

  it('refuses a business over its limit before reading the body, and no other business', async () => {
    const business = `business-${unique()}`;
    // Many users, each well under their own limit.
    for (let n = 0; n < UPLOADS_PER_BUSINESS_PER_WINDOW; n += 1) {
      const { response } = await upload(`user-${n % 20}-${business}`, business);
      expect(response.status).toBe(200);
    }
    const { request, pull } = unreadUpload();
    const fresh = `user-${unique()}`;
    const { response, stored } = await upload(fresh, business, request);
    expect(response.status).toBe(429);
    expect(await response.text()).toBe(UPLOAD_RATE_MESSAGE);
    expect(pull).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(stored).not.toHaveBeenCalled();
    // The same user at another business, and another business altogether, still upload.
    expect((await upload(fresh, `business-${unique()}`)).response.status).toBe(200);
    expect((await upload(`user-${unique()}`, `business-${unique()}`)).response.status).toBe(200);
  });

  it('does not charge the business for a user who is over their own limit', async () => {
    const user = `user-${unique()}`;
    const business = `business-${unique()}`;
    const { rateLimit } = await import('@/lib/rate-limit');
    for (let n = 0; n < UPLOADS_PER_USER_PER_WINDOW + 25; n += 1) await upload(user, business);
    // 60 counted, the 25 refusals not: the next count for the business is its 61st.
    const next = await rateLimit(
      `upload:org:${business}`,
      UPLOADS_PER_BUSINESS_PER_WINDOW,
      UPLOAD_RATE_WINDOW_MS
    );
    expect(next.remaining).toBe(
      UPLOADS_PER_BUSINESS_PER_WINDOW - UPLOADS_PER_USER_PER_WINDOW - 1
    );
  });
});
