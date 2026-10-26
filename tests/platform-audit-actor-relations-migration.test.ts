import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261026120000_platform_audit_tenant_actor_index/migration.sql'
  ),
  'utf8'
);

describe('platform audit actor relation migration', () => {
  it('enforces both actor relations without discarding historical orphan identifiers', () => {
    expect(migration).toContain(
      'CONSTRAINT "platform_audit_logs_actorPlatformUserId_fkey"'
    );
    expect(migration).toContain('REFERENCES "platform_users"("id")');
    expect(migration).toContain('CONSTRAINT "platform_audit_logs_actorTenantUserId_fkey"');
    expect(migration).toContain('FOREIGN KEY ("organizationId", "actorTenantUserId")');
    expect(migration).toContain('REFERENCES "users"("organizationId", "id")');
    expect(migration).toContain(
      'CHECK ("actorTenantUserId" IS NULL OR "organizationId" IS NOT NULL) NOT VALID'
    );
    expect(migration.match(/ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID/g)).toHaveLength(2);
  });
});
