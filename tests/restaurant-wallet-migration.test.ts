import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('prisma/migrations/20260829090000_restaurant_wallet_passes/migration.sql'),
  'utf8'
);

const TABLES = [
  'restaurant_wallet_passes',
  'restaurant_wallet_pass_registrations',
  'restaurant_wallet_pass_updates',
  'restaurant_wallet_tenant_config',
  'restaurant_wallet_enrollment_links',
  'restaurant_wallet_enrollment_attempts',
] as const;

describe('wallet L1 migration contract', () => {
  it('adds WALLET first and documents the irreversible enum rollback', () => {
    expect(
      migration.indexOf(`ALTER TYPE "CustomerIdentifierKind" ADD VALUE 'WALLET'`)
    ).toBeLessThan(migration.indexOf('CREATE TABLE'));
    expect(migration).toContain('cannot\n-- be removed from a PostgreSQL enum in place');
    expect(migration).not.toMatch(/INSERT\s+INTO[\s\S]*WALLET/i);
  });

  it.each(TABLES)('%s is org-scoped with enabled and forced RLS', (table) => {
    const create = migration.match(new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`));
    expect(create?.[1]).toContain(
      `"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true)`
    );
    expect(migration).toContain(`'${table}'`);
  });

  it('pins all partial uniqueness invariants', () => {
    expect(migration).toMatch(
      /active_wallet_key[\s\S]*WHERE "wallet_identifier_kind_text"\("kind"\) = 'WALLET'/
    );
    expect(migration).toMatch(/active_customer_platform_key[\s\S]*WHERE "status" = 'ACTIVE'/);
    expect(migration).toMatch(/pending_pass_key[\s\S]*WHERE "status" = 'PENDING'/);
    expect(migration).toMatch(/active_branch_key[\s\S]*WHERE "active" = true/);
  });
});
