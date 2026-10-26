/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

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
const otherOrg = `audit_other_${suffix}`;
const tenantActor = `tenant_actor_${suffix}`;
const action = `test.${suffix}`;
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
      await db.organization.create({
        data: { id: otherOrg, slug: otherOrg, legalName: otherOrg, displayName: otherOrg },
      });
      await db.organizationDepartment.create({
        data: { organizationId: otherOrg, key: 'ADMINISTRATION', name: 'Administration' },
      });
      await db.user.create({
        data: {
          id: tenantActor,
          organizationId: otherOrg,
          name: 'Other tenant actor',
          email: `${tenantActor}@example.test`,
          department: 'ADMINISTRATION',
          title: 'Administrator',
        },
      });
      await db.platformUser.create({
        data: {
          id: actor,
          name: 'Audit actor',
          email: `${actor}@example.test`,
          passwordHash: 'fixture',
          role: 'AUDITOR',
        },
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
    });
  });
  it('rejects attribution to an actor from another organization', async () => {
    await expect(
      scoped((db) =>
        db.platformAuditLog.create({
          data: {
            organizationId: org,
            actorTenantUserId: tenantActor,
            action: `${action}.cross_tenant`,
          },
        })
      )
    ).rejects.toThrow(/foreign key constraint/i);
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
