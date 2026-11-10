/**
 * @vitest-environment node
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway PostgreSQL database). This
 * test deliberately uses two physical connections: one commits a stale import
 * while the retention worker is waiting for the same row lock.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { verticalForModuleKey } from '@/lib/module-catalog';
import { purgeStaleMenuImports, type MenuImportRuntime } from './menu-import';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('menu import retention concurrency', () => {
  const suffix = randomBytes(6).toString('hex');
  const organizationId = `menu_purge_org_${suffix}`;
  const importId = `menu_purge_import_${suffix}`;
  let commitConnection: Client;
  let sweepConnection: Client;

  beforeAll(async () => {
    commitConnection = new Client({ connectionString: TEST_DATABASE_URL });
    sweepConnection = new Client({
      connectionString: TEST_DATABASE_URL,
      application_name: `menu-purge-sweep-${suffix}`,
    });
    await Promise.all([commitConnection.connect(), sweepConnection.connect()]);
    await commitConnection.query("SET app.is_platform_admin = 'true'");
    await sweepConnection.query("SET app.is_platform_admin = 'true'");
    await commitConnection.query(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", vertical, "updatedAt")
       VALUES ($1, $1, $1, $1, $2, now())`,
      [organizationId, verticalForModuleKey('restaurant-core')!]
    );
    await commitConnection.query(
      `INSERT INTO restaurant_menu_imports
         (id, "organizationId", status, adapter, "fileName", "mimeType", "byteSize",
          "pageCount", checksum, "idempotencyKey", "createdById", "createdAt", "updatedAt")
       VALUES ($1, $2, 'AWAITING_REVIEW', 'FIXTURE', 'menu.png', 'image/png', 1,
               1, 'checksum', $1, 'reviewer', now() - interval '15 days', now())`,
      [importId, organizationId]
    );
  });

  afterAll(async () => {
    if (commitConnection) {
      await commitConnection.query('ROLLBACK').catch(() => undefined);
      await commitConnection
        .query('DELETE FROM organizations WHERE id = $1', [organizationId])
        .catch(() => undefined);
    }
    await Promise.all([
      commitConnection?.end().catch(() => undefined),
      sweepConnection?.end().catch(() => undefined),
    ]);
  });

  it('preserves a row committed after stale preselection while waiting on FOR UPDATE', async () => {
    const table = {
      findMany: vi.fn(async (args: { where: { status: { in: string[] } } }) => {
        const decided = args.where.status.in.includes('COMMITTED');
        const result = await sweepConnection.query(
          `SELECT id, "organizationId", "storageObjectName"
             FROM restaurant_menu_imports
            WHERE "createdAt" < now() - interval '14 days'
              AND status = ANY($1::"RestaurantMenuImportStatus"[])
              AND "organizationId" = $2
              AND id = $3`,
          [args.where.status.in, organizationId, importId]
        );
        return decided ? result.rows.filter((row) => row.storageObjectName) : result.rows;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string; organizationId: string } }) => {
        const result = await sweepConnection.query(
          `SELECT "organizationId", status, "storageObjectName", "createdAt"
             FROM restaurant_menu_imports
            WHERE id = $1 AND "organizationId" = $2`,
          [where.id, where.organizationId]
        );
        return result.rows[0] ?? null;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string; organizationId: string } }) => {
        await sweepConnection.query(
          'DELETE FROM restaurant_menu_imports WHERE id = $1 AND "organizationId" = $2',
          [where.id, where.organizationId]
        );
      }),
    };
    const db = {
      restaurantMenuImport: table,
      $queryRaw: async (_strings: TemplateStringsArray, id: string, scopedOrganizationId: string) =>
        sweepConnection.query(
          `SELECT id FROM restaurant_menu_imports
            WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
          [id, scopedOrganizationId]
        ),
      $transaction: async (work: (tx: ScopedDb) => Promise<unknown>) => {
        await sweepConnection.query('BEGIN');
        try {
          const result = await work(db as unknown as ScopedDb);
          await sweepConnection.query('COMMIT');
          return result;
        } catch (error) {
          await sweepConnection.query('ROLLBACK');
          throw error;
        }
      },
    };

    await commitConnection.query('BEGIN');
    await commitConnection.query(
      'SELECT id FROM restaurant_menu_imports WHERE id = $1 FOR UPDATE',
      [importId]
    );
    await commitConnection.query(
      `UPDATE restaurant_menu_imports
          SET status = 'COMMITTED', "committedAt" = now(), "committedById" = 'reviewer'
        WHERE id = $1`,
      [importId]
    );

    // Never touch real storage: the default runtime would delete uploaded objects.
    const runtime = {
      resolveAdapter: vi.fn(() => {
        throw new Error('extraction is not expected during retention');
      }),
      putSource: vi.fn(async () => undefined),
      readSource: vi.fn(async () => Buffer.alloc(0)),
      deleteSource: vi.fn(async () => undefined),
    } satisfies MenuImportRuntime;

    const purge = purgeStaleMenuImports(db as unknown as ScopedDb, { runtime });
    await expect
      .poll(async () => {
        const waiting = await commitConnection.query(
          `SELECT wait_event_type FROM pg_stat_activity
            WHERE application_name = $1 AND wait_event_type = 'Lock'`,
          [`menu-purge-sweep-${suffix}`]
        );
        return waiting.rowCount;
      })
      .toBe(1);

    await commitConnection.query('COMMIT');

    await expect(purge).resolves.toEqual({ purgedDrafts: 0, deletedSources: 0 });
    const persisted = await commitConnection.query(
      'SELECT status FROM restaurant_menu_imports WHERE id = $1',
      [importId]
    );
    expect(persisted.rows).toEqual([{ status: 'COMMITTED' }]);
    expect(table.delete).not.toHaveBeenCalled();
    expect(runtime.deleteSource).not.toHaveBeenCalled();
  });
});
