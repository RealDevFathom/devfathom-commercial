// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { acquireLargeUploadSlot } from './large-upload-slot';
import { uploadPost } from './multipart-request';
import { multipartUpload } from '../../../tests/fixtures/multipart-upload';

const databaseUrl = process.env.UPLOAD_SLOT_TEST_DATABASE_URL;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function useLocalDatabase() {
  const target = new URL(databaseUrl!);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(target.hostname);
  expect(target.pathname).toMatch(/[_-]test$/);
  expect(target.search).toBe('');
  vi.stubEnv('DATABASE_URL', databaseUrl);
}

it.skipIf(!databaseUrl)(
  'admits two concurrent slots per user and makes rolled-back slots available again',
  async () => {
    useLocalDatabase();
    const user = randomUUID();
    const organization = randomUUID();
    const releases: Array<() => Promise<void>> = [];
    async function acquire(id: string, org = organization) {
      const release = await acquireLargeUploadSlot(id, org);
      if (typeof release === 'function') releases.push(release);
      return release;
    }
    try {
      const sameUser = await Promise.all([acquire(user), acquire(user), acquire(user)]);
      expect(sameUser.filter(Boolean)).toHaveLength(2);
      expect(sameUser).toContain(null);
      expect(await acquire(user, randomUUID())).toBeNull();
      expect(await acquire(randomUUID())).toBeTypeOf('function');
      await releases.shift()!();
      expect(await acquire(user)).toBeTypeOf('function');
      expect(await acquire(user)).toBeNull();
    } finally {
      await Promise.all(releases.map((release) => release()));
    }
  }
);

function uploadAs(user: string, organization: string) {
  return uploadPost(async (_, readForm) => {
    const form = await readForm(user, organization);
    if (form instanceof Response) return form;
    expect(form?.get('file')).toBeInstanceOf(File);
    return new Response(null, { status: 201 });
  });
}

it.skipIf(!databaseUrl)(
  'refuses a business at its four-slot cap but still accepts an upload from another business',
  async () => {
    useLocalDatabase();
    const firstBusiness = randomUUID();
    const releases: Array<() => Promise<void>> = [];
    try {
      const slots = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const slot = await acquireLargeUploadSlot(randomUUID(), firstBusiness);
          if (typeof slot === 'function') releases.push(slot);
          return slot;
        })
      );
      expect(slots.every((slot) => typeof slot === 'function')).toBe(true);
      const upload = (organization: string, sizeMiB = 9) => {
        const request = multipartUpload('/api/upload', sizeMiB);
        request.headers.set('content-length', String(sizeMiB * 1024 * 1024 + 1024));
        return uploadAs(randomUUID(), organization)(request);
      };
      const refused = await upload(firstBusiness);
      expect(refused.status).toBe(429);
      expect(refused.headers.get('Content-Type')).toMatch(/^text\/plain\b/);
      expect(await refused.text()).toBe('Large uploads are busy. Try again shortly.');
      expect((await upload(randomUUID(), 25)).status).toBe(201);
      await releases.shift()!();
      expect((await upload(firstBusiness)).status).toBe(201);
    } finally {
      await Promise.all(releases.map((release) => release()));
    }
  }
);

it.skipIf(!databaseUrl).each([true, false])(
  'cancels a pending body read at 270 seconds and frees its slot (declared size: %s)',
  async (declared) => {
    useLocalDatabase();
    const user = randomUUID();
    const business = randomUUID();
    const occupied = await acquireLargeUploadSlot(user, business);
    if (typeof occupied !== 'function') throw new Error('expected the first user slot');
    const { promise: reading, resolve: markReading } = Promise.withResolvers<void>();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let started = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          if (!started) {
            started = true;
            // Undeclared transfers acquire the real slot on crossing 8 MiB.
            controller.enqueue(new Uint8Array(declared ? 1024 : 9 * 1024 * 1024));
            return;
          }
          markReading();
          return new Promise<void>(() => {});
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    const request = new Request('https://tenant.example.test/api/upload', {
      method: 'POST',
      headers: declared ? { 'content-length': String(10 * 1024 * 1024) } : undefined,
      body,
      duplex: 'half',
    } as RequestInit);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const response = uploadAs(user, business)(request);
      await reading;
      await vi.advanceTimersByTimeAsync(269_999);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(cancel).toHaveBeenCalledOnce();
      vi.useRealTimers();
      expect((await response).status).toBe(408);
      expect((await uploadAs(user, business)(multipartUpload('/api/upload', 9))).status).toBe(201);
    } finally {
      await occupied();
    }
  }
);
