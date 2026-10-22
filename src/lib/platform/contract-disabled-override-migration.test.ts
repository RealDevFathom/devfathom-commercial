import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20261021190000_qa304_contract_disabled_override_cleanup/migration.sql'
  ),
  'utf8'
);

describe('QA-304 contract-disabled override cleanup', () => {
  it('preserves indistinguishable organization-level DISABLED overrides', () => {
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+organization_modules\b/i);
    expect(migration).toContain('intentionally preserve every organization-level override');
  });
});
