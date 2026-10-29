import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

describe('pg_trgm migration grant', () => {
  it('delegates through the actual extension owner to the configured migration role', () => {
    const runner = read('prisma', 'prepare-extensions.ts');
    const preparation = read('prisma', 'prepare-extensions.sql');

    expect(runner).toContain("set_config('devfathom.migration_role', $1, true)");
    expect(preparation).toContain("target_extension = 'pg_trgm'");
    expect(preparation).toContain("member.identity = 'similarity_op(text,text)'::regprocedure");
    expect(preparation).toContain('TO %I WITH GRANT OPTION');
    expect(preparation).not.toContain('TO devfathom_app');
  });

  it('fails migration instead of accepting a warning when delegation did not happen', () => {
    const migration = read(
      'prisma',
      'migrations',
      '20261029000368_pg_trgm_migration_grant_guard',
      'migration.sql'
    );

    expect(migration).toContain('acl.is_grantable');
    expect(migration).toContain('Run prisma/prepare-extensions.ts');
    expect(migration).not.toMatch(/^\s*GRANT\s+EXECUTE/im);
    expect(migration).not.toContain('devfathom_app');
  });
});
