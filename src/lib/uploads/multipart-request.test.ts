// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { uploadPost } from './multipart-request';
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
