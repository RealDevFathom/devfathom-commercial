// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const adminUrl = process.env.SUPERUSER_URL ?? '';
const databaseName = `prepare_extensions_${randomUUID().replaceAll('-', '')}`;
const preparation = readFileSync('prisma/prepare-extensions.sql', 'utf8');

function databaseUrl(database: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

(adminUrl ? describe : describe.skip)('extension preparation on a fresh database', () => {
  const admin = new pg.Client({ connectionString: adminUrl });

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
  });

  it('installs pg_trgm before resolving its functions and remains idempotent', async () => {
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(databaseName)}`);

    const fresh = new pg.Client({ connectionString: databaseUrl(databaseName) });
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
