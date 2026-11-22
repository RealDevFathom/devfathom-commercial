// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { acquireLargeUploadSlot } from './large-upload-slot';

const databaseUrl = process.env.UPLOAD_SLOT_TEST_DATABASE_URL;
afterEach(() => vi.unstubAllEnvs());

it.skipIf(!databaseUrl)(
  'admits two concurrent slots per user and makes rolled-back slots available again',
  async () => {
    const target = new URL(databaseUrl!);
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(target.hostname);
    expect(target.pathname).toMatch(/[_-]test$/);
    vi.stubEnv('DATABASE_URL', databaseUrl);
    const user = randomUUID();
    const releases: Array<() => Promise<void>> = [];
    async function acquire(id: string) {
      const release = await acquireLargeUploadSlot(id);
      if (release) releases.push(release);
      return release;
    }
    try {
      const sameUser = await Promise.all([acquire(user), acquire(user), acquire(user)]);
      expect(sameUser.filter(Boolean)).toHaveLength(2);
      expect(sameUser).toContain(null);
      expect(await acquire(randomUUID())).toBeTypeOf('function');
      await releases.shift()!();
      expect(await acquire(user)).toBeTypeOf('function');
      expect(await acquire(user)).toBeNull();
    } finally {
      await Promise.all(releases.map((release) => release()));
    }
  }
);
