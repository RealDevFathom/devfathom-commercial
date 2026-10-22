import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261023000260_repair_default_department_conflict_target/migration.sql'
  ),
  'utf8'
);

describe('issue #260 default-department repair migration', () => {
  it('only ignores the intended tenant department-key conflict', () => {
    expect(migration).toContain('ON CONFLICT ("organizationId", "key") DO NOTHING');
    expect(migration).not.toMatch(/ON CONFLICT\s+DO NOTHING/);
  });

  it('does not hide a different key colliding on the tenant department name', () => {
    expect(migration).not.toContain('ON CONFLICT ("organizationId", "name") DO NOTHING');
    expect(migration).toContain('A different key using the same name must remain a visible');
  });

  it('crosses FORCE RLS only for the migration transaction', () => {
    expect(migration).toMatch(
      /BEGIN;\s+SET LOCAL app\.is_platform_admin = 'true';[\s\S]+ON CONFLICT \("organizationId", "key"\) DO NOTHING;\s+COMMIT;/
    );
    expect(migration).not.toContain('SET app.is_platform_admin');
  });
});
