import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = 'prisma/migrations/20261021160000_outbound_effect_worker/migration.sql';
const migration = readFileSync(migrationPath, 'utf8');

describe('outbound effect worker migration', () => {
  it('uses a timestamp after the pharmacy register migrations', () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(existsSync('prisma/migrations/20261021140000_outbound_effect_worker')).toBe(false);
    expect(existsSync('prisma/migrations/20261021150000_outbound_effect_worker')).toBe(false);
  });

  it('schedules retries, strips webhook copies, and deletes leftover secrets', () => {
    expect(migration).toContain('ADD COLUMN "availableAt"');
    expect(migration).toContain(`'DEAD'`);
    expect(migration).toContain(`payload - 'secret' - 'url'`);
    expect(migration).toContain(`DELETE FROM "outbound_effects" WHERE status = 'FAILED'`);
    expect(migration).toContain(`DELETE FROM "rate_limit_buckets" WHERE key !~ '^[0-9a-f]{64}$'`);
  });
});
