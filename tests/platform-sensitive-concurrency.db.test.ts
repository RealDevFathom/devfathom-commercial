// Run only in an isolated disposable database; this fixture resets platform operators.
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlatformIdentity } from '@/lib/platform/auth';

const url = process.env.WHA1597_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = describe.skipIf(!url);
let db: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
let execute: (typeof import('@/lib/platform/commands'))['executePlatformCommand'];

suite('last super-admin serialization on PostgreSQL', () => {
  beforeAll(async () => {
    if (!url || new URL(url).hostname !== '127.0.0.1' || !/^556\d\d$/.test(new URL(url).port)) {
      throw new Error('A disposable loopback database in ports 55600–55699 is required.');
    }
    ({ withPlatformDb: db } = await import('@/lib/tenancy/scoped-db'));
    ({ executePlatformCommand: execute } = await import('@/lib/platform/commands'));
    await db(async (tx) => {
      const roles = await tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await tx.platformUser.updateMany({ data: { role: 'AUDITOR' } });
      for (const id of ['sa_concurrent_a', 'sa_concurrent_b']) {
        await tx.platformUser.create({
          data: {
            id,
            name: id,
            email: `${id}@example.com`,
            passwordHash: 'fixture',
            role: 'SUPER_ADMIN',
            active: true,
          },
        });
      }
    });
  });

  it('commits only one of two concurrent cross-demotions and audits the rejected transaction', async () => {
    const request = new Request('http://admin.localhost/api/platform/control');
    const actors = ['sa_concurrent_a', 'sa_concurrent_b'];
    const results = await Promise.allSettled(
      actors.map((id, index) =>
        execute(
          { id, role: 'SUPER_ADMIN' } as PlatformIdentity,
          'operator.upsert',
          {
            id: actors[1 - index],
            name: actors[1 - index],
            email: `${actors[1 - index]}@example.com`,
            role: 'SUPPORT',
            active: true,
            mfaRequired: false,
          },
          request
        )
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { status: 403 } });
    await db(async (tx) => {
      expect(await tx.platformUser.count({ where: { role: 'SUPER_ADMIN', active: true } })).toBe(1);
      const audits = await tx.platformAuditLog.findMany({ where: { action: 'operator.upsert' } });
      expect(audits.filter((row) => row.success)).toHaveLength(1);
      expect(audits.filter((row) => !row.success)).toHaveLength(1);
    });
  });
});
