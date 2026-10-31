/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }),
  }),
}));
vi.mock('@/lib/platform/page-access', () => ({
  requirePlatformRead: vi.fn().mockResolvedValue({ role: 'AUDITOR' }),
}));
const suffix = randomUUID();
const org = `audit_${suffix}`;
const actor = `actor_${suffix}`;
const action = `test.${suffix}`;
const tenantAuditId = `${org}_tenant_audit`;
let scoped: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let page: typeof import('@/app/platform/(console)/audit/page').default;
const timestamp = new Date('2026-09-20T12:00:00Z');

describe.skipIf(!url)('platform audit ledger on disposable PostgreSQL', () => {
  beforeAll(async () => {
    ({ withPlatformDb: scoped } = await import('@/lib/tenancy/scoped-db'));
    page = (await import('@/app/platform/(console)/audit/page')).default;
    await scoped(async (db) => {
      const [role] = await db.$queryRaw<
        { rolsuper: boolean; rolbypassrls: boolean }[]
      >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await db.organization.create({
        data: { id: org, slug: org, legalName: org, displayName: org },
      });
      await db.organizationLifecycleEvent.create({
        data: {
          id: org,
          organizationId: org,
          action: 'CREATED',
          toStatus: 'PROSPECT',
          reason: 'test',
        },
      });
      await db.platformAuditLog.createMany({
        data: Array.from({ length: 103 }, (_, i) => ({
          id: `${org}_${String(i).padStart(3, '0')}`,
          organizationId: org,
          actorPlatformUserId: actor,
          action,
          createdAt: timestamp,
          reason: '=HYPERLINK("https://example.invalid")',
        })),
      });
      await db.$executeRaw`
        INSERT INTO audit_logs (id, "organizationId", source, category, action)
        VALUES (${tenantAuditId}, ${org}, 'TRPC', 'SYSTEM', ${action})
      `;
    });
  });
  afterAll(async () => {
    await (await import('@/lib/db')).db.$disconnect();
  });

  for (const table of ['platform_audit_logs', 'organization_lifecycle_events']) {
    for (const operation of ['UPDATE', 'DELETE']) {
      it(`${table} rejects ${operation} even with platform and purge context`, async () => {
        await expect(
          scoped(async (db) => {
            await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${org}, true)`;
            await db.$executeRawUnsafe(
              operation === 'UPDATE'
                ? `UPDATE ${table} SET reason = 'tampered' WHERE "organizationId" = $1`
                : `DELETE FROM ${table} WHERE "organizationId" = $1`,
              org
            );
          })
        ).rejects.toThrow(/append-only/);
      });
    }
  }

  for (const context of [
    { name: 'tenant-scoped', platform: false, purgeOrg: '' },
    { name: 'tenant-scoped with a matching purge flag', platform: false, purgeOrg: org },
    { name: 'platform-scoped without a purge', platform: true, purgeOrg: '' },
    { name: 'platform-scoped with another purge', platform: true, purgeOrg: `${org}_other` },
    { name: 'platform-scoped with the exact purge', platform: true, purgeOrg: org },
  ]) {
    const operations =
      context.platform && context.purgeOrg === org ? ['UPDATE'] : ['UPDATE', 'DELETE'];
    for (const operation of operations) {
      it(`audit_logs rejects ${context.name} ${operation}`, async () => {
        const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
        const scope = context.platform
          ? scoped
          : (run: Parameters<typeof scoped>[0]) => withTenantDb(org, run);
        const mutation = scope(async (db) => {
          await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${context.purgeOrg}, true)`;
          return db.$executeRawUnsafe(
            operation === 'UPDATE'
              ? `UPDATE audit_logs SET action = 'tampered' WHERE id = $1`
              : `DELETE FROM audit_logs WHERE id = $1`,
            tenantAuditId
          );
        });

        const error = await mutation.catch((cause: unknown) => cause);

        expect(error).toEqual(
          expect.objectContaining({
            message: expect.stringMatching(
              new RegExp(`audit_logs is append-only: ${operation} is forbidden`, 'i')
            ),
          })
        );
        expect(error).toMatchObject({
          meta: { driverAdapterError: { cause: { originalCode: '55000' } } },
        });

        await expect(
          withTenantDb(
            org,
            (db) =>
              db.$queryRaw<{ action: string }[]>`
            SELECT action FROM audit_logs WHERE id = ${tenantAuditId}
          `
          )
        ).resolves.toEqual([{ action }]);
      });
    }
  }

  it('allows deletion only for the exact platform purge and keeps that context transaction-local', async () => {
    const purgeId = `${org}_purged_audit`;
    await scoped(
      (db) =>
        db.$executeRaw`
        INSERT INTO audit_logs (id, "organizationId", source, category, action)
        VALUES (${purgeId}, ${org}, 'TRPC', 'SYSTEM', ${action})
      `
    );
    await expect(
      scoped(async (db) => {
        await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${org}, true)`;
        return db.$executeRaw`DELETE FROM audit_logs WHERE id = ${purgeId}`;
      })
    ).resolves.toBe(1);
    await expect(
      scoped((db) => db.$queryRaw`SELECT id FROM audit_logs WHERE id = ${purgeId}`)
    ).resolves.toEqual([]);
    await expect(
      scoped((db) => db.$executeRaw`DELETE FROM audit_logs WHERE id = ${tenantAuditId}`)
    ).rejects.toThrow(/audit_logs is append-only: DELETE is forbidden/);
  });

  it('continues to allow tenant-scoped inserts', async () => {
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const insertedId = `${org}_tenant_audit_insert`;

    await expect(
      withTenantDb(
        org,
        (db) =>
          db.$executeRaw`
          INSERT INTO audit_logs (id, "organizationId", source, category, action)
          VALUES (${insertedId}, ${org}, 'TRPC', 'SYSTEM', ${action})
        `
      )
    ).resolves.toBe(1);

    await expect(
      withTenantDb(
        org,
        (db) =>
          db.$queryRaw<{ action: string }[]>`
          SELECT action FROM audit_logs WHERE id = ${insertedId}
        `
      )
    ).resolves.toEqual([{ action }]);
  });

  for (const platform of [false, true]) {
    it(`preserves audit facts when ${platform ? 'platform' : 'tenant'} scope deletes actors`, async () => {
      const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
      const scope = platform
        ? scoped
        : <T,>(run: (db: ScopedDb) => Promise<T>) => withTenantDb(org, run);
      const prefix = `${org}_${platform ? 'platform' : 'tenant'}_actor`;
      const userId = `${prefix}_user`;
      const staffId = `${prefix}_staff`;
      const before = await scope(async (db) => {
        await db.organizationDepartment.create({
          data: { organizationId: org, key: prefix, name: prefix },
        });
        await db.user.create({
          data: {
            id: userId,
            organizationId: org,
            name: 'Historical user',
            email: `${userId}@example.invalid`,
            department: prefix,
            title: 'Test',
          },
        });
        await db.restaurantStaffProfile.create({
          data: { id: staffId, organizationId: org, displayName: 'Historical operator' },
        });
        await db.auditLog.createMany({
          data: [
            {
              id: userId,
              organizationId: org,
              source: 'TRPC',
              category: 'SYSTEM',
              action,
              actorType: 'USER',
              actorId: userId,
              actorName: 'Historical user',
              actorEmail: `${userId}@example.invalid`,
              input: { original: 'user input' },
              metadata: { original: 'user context' },
            },
            {
              id: staffId,
              organizationId: org,
              source: 'REST_API',
              category: 'TERMINAL',
              action,
              actorType: 'RESTAURANT_OPERATOR',
              actorStaffProfileId: staffId,
              actorName: 'Historical operator',
              actorRole: 'CASHIER',
              input: { original: 'operator input' },
              metadata: { staffId, deviceId: 'test' },
            },
          ],
        });
        return db.auditLog.findMany({
          where: { id: { in: [userId, staffId] } },
          orderBy: { id: 'asc' },
        });
      });

      // Clients cannot erase attribution or change facts alongside it.
      for (const [id, assignment] of [
        [userId, '"actorId" = NULL'],
        [staffId, '"actorStaffProfileId" = NULL'],
        [staffId, '"actorStaffProfileId" = NULL, "actorName" = \'tampered\''],
        [userId, `"actorId" = NULL, "actorType" = 'SYSTEM'`],
      ]) {
        await expect(
          scope((db) =>
            db.$executeRawUnsafe(`UPDATE audit_logs SET ${assignment} WHERE id = $1`, id)
          )
        ).rejects.toMatchObject({
          meta: { driverAdapterError: { cause: { originalCode: '55000' } } },
        });
      }

      await scope(async (db) => {
        await db.user.delete({ where: { id: userId } });
        await db.restaurantStaffProfile.delete({ where: { id: staffId } });
        // Force deferred tenant FKs to be checked before comparing the retained rows.
        await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        expect(
          await db.auditLog.findMany({
            where: { id: { in: [userId, staffId] } },
            orderBy: { id: 'asc' },
          })
        ).toEqual(before.map((row) => ({ ...row, actorId: null, actorStaffProfileId: null })));
      });

      await expect(
        scope((db) => db.$executeRaw`
          UPDATE audit_logs SET "actorName" = 'tampered' WHERE id = ${staffId}
        `)
      ).rejects.toThrow(/append-only/);
      await expect(
        scope((db) => db.$executeRaw`
          INSERT INTO audit_logs (id, "organizationId", source, category, action, "actorType")
          VALUES (${`${prefix}_invalid_operator`}, ${org}, 'REST_API', 'TERMINAL',
                  ${action}, 'RESTAURANT_OPERATOR')
        `)
      ).rejects.toMatchObject({
        meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
      });
      await expect(
        scope((db) => db.$executeRaw`
          INSERT INTO audit_logs
            (id, "organizationId", source, category, action, "actorType", "actorStaffProfileId")
          VALUES (${`${prefix}_invalid_user`}, ${org}, 'REST_API', 'SYSTEM',
                  ${action}, 'USER', ${staffId})
        `)
      ).rejects.toMatchObject({
        meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
      });
    });
  }

  for (const table of ['audit_logs', 'platform_audit_logs', 'organization_lifecycle_events']) {
    it(`${table} has an unconditional statement-level TRUNCATE guard`, async () => {
      await scoped(async (db) => {
        const triggers = await db.$queryRaw<{ tgtype: number; tgenabled: string }[]>`
          SELECT tgtype::int, tgenabled::text FROM pg_trigger
          WHERE tgrelid = ${table}::regclass AND tgname = ${`${table}_no_truncate`}
        `;
        // BEFORE (2) + TRUNCATE (32), without the ROW bit (1).
        expect(triggers).toEqual([{ tgtype: 34, tgenabled: 'O' }]);
      });
      const error = await scoped(async (db) => {
        await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${org}, true)`;
        await db.$executeRawUnsafe(`TRUNCATE TABLE ${table}`);
        // Keep this attempted destructive operation rolled back even if the guard regresses.
        throw new Error('TRUNCATE unexpectedly succeeded');
      }).catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        meta: {
          driverAdapterError: {
            cause: { originalCode: expect.stringMatching(/^(42501|55000)$/) },
          },
        },
      });
    });
  }

  const filters = { org, actor, action, from: '2026-09-20', through: '2026-09-20' };
  it('filters, exports escaped CSV, and pages tied timestamps without duplicates', async () => {
    const html = renderToStaticMarkup(await page({ searchParams: Promise.resolve(filters) }));
    expect(html).toContain('100 records');
    expect(html).toContain('Export this page (CSV)');
    const href = html.match(/href="(\/platform\/audit\?[^\"]*cursor=[^\"]*)"/)?.[1];
    expect(href).toBeTruthy();
    const cursor = new URL(href!.replaceAll('&amp;', '&'), 'http://localhost').searchParams.get(
      'cursor'
    )!;
    const second = renderToStaticMarkup(
      await page({ searchParams: Promise.resolve({ ...filters, cursor }) })
    );
    expect(second).toContain('3 records');
    expect(second).not.toContain('Older records');
    const csvFrom = (markup: string) =>
      decodeURIComponent(
        markup.match(/href="data:text\/csv;charset=utf-8,([^\"]+)"/)![1].replaceAll('&#x27;', "'")
      );
    const firstCsv = csvFrom(html);
    const secondCsv = csvFrom(second);
    expect(firstCsv).toContain("'＝".replace('＝', '=') + 'HYPERLINK(""https://example.invalid"")');
    expect(firstCsv).toContain(`${org}_003`);
    expect(secondCsv).not.toContain(`${org}_003`);
    expect(secondCsv).toContain(`${org}_000`);
  });
  it('combines org, actor, action and date filters without widening', async () => {
    for (const override of [
      { org: 'missing' },
      { actor: 'missing' },
      { action: 'missing' },
      { from: '2026-09-21', through: '2026-09-22' },
    ]) {
      const html = renderToStaticMarkup(
        await page({ searchParams: Promise.resolve({ ...filters, ...override }) })
      );
      expect(html).toContain('No records match');
      expect(html).not.toContain('Export this page');
    }
  });
  it('invalid ranges and cursors fail closed with a visible error', async () => {
    for (const override of [{ from: '2026-02-30' }, { cursor: 'broken' }, { from: '2026-09-22' }]) {
      const html = renderToStaticMarkup(
        await page({ searchParams: Promise.resolve({ ...filters, ...override }) })
      );
      expect(html).toContain('Invalid date range or pagination cursor');
      expect(html).not.toContain('Export this page');
    }
  });
  it('checks audit read authorization before exposing rows or CSV', async () => {
    const { requirePlatformRead } = await import('@/lib/platform/page-access');
    vi.mocked(requirePlatformRead).mockRejectedValueOnce(new Error('denied'));
    await expect(page({ searchParams: Promise.resolve(filters) })).rejects.toThrow('denied');
    expect(requirePlatformRead).toHaveBeenLastCalledWith('/platform/audit');
  });
});
