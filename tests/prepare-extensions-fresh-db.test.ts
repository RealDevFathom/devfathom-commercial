// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDisposableExtensionDatabase } from './prepare-extensions-database-guard';

const optedIn = process.env.PREPARE_EXTENSIONS_FRESH_DB_TEST === '1';
const adminUrl = process.env.SUPERUSER_URL ?? '';
const databaseName = `prepare_extensions_test_${randomUUID().replaceAll('-', '')}`;
const preparation = readFileSync('prisma/prepare-extensions.sql', 'utf8');

(optedIn ? describe : describe.skip)('extension preparation on a fresh database', () => {
  let admin: pg.Client | undefined;
  let guardedUrl: URL;

  beforeAll(async () => {
    // Fail closed before constructing any client or opening any connection.
    guardedUrl = assertDisposableExtensionDatabase(adminUrl);
    admin = new pg.Client({ connectionString: guardedUrl.toString() });
    await admin.connect();
  });

  afterAll(async () => {
    // Retain synthetic database/state; connection closure is not teardown.
    await admin?.end();
  });

  it('installs pg_trgm before resolving its functions and remains idempotent', async () => {
    if (!admin) throw new Error('Extension preparation preflight did not complete');
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(databaseName)}`);

    const freshUrl = new URL(guardedUrl);
    freshUrl.pathname = `/${databaseName}`;
    const fresh = new pg.Client({ connectionString: freshUrl.toString() });
    await fresh.connect();
    try {
      await fresh.query(preparation);
      await fresh.query(preparation);

      const extensions = await fresh.query<{ extname: string }>(
        `SELECT extname FROM pg_catalog.pg_extension
          WHERE extname IN ('btree_gist', 'pg_trgm')
          ORDER BY extname`
      );
      expect(extensions.rows).toEqual([{ extname: 'btree_gist' }, { extname: 'pg_trgm' }]);
    } finally {
      await fresh.end();
    }
  });
});
