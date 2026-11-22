// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('bounds lock acquisition from the start of the controlled supplier-return migration', () => {
  const sql = readFileSync(
    'prisma/migrations/20261121160000_controlled_supplier_dispatch/migration.sql',
    'utf8'
  );
  expect(sql.trimStart()).toMatch(/^BEGIN;\s*SET LOCAL lock_timeout = '10s';/);
});
