import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261115090000_invoice_payment_income_transaction/migration.sql',
  'utf8'
);

describe('invoice payment income migration (DEV-166)', () => {
  it('runs as one idempotent transaction', () => {
    expect(
      migration
        .trimStart()
        .split('\n')
        .find((line) => !line.startsWith('--'))
    ).toBe('BEGIN;');
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "paymentId"');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "transactions_paymentId_key"');
    expect(migration).toContain('ON CONFLICT ("paymentId") DO NOTHING');
    expect(migration).not.toMatch(/ON CONFLICT\s+DO NOTHING/i);
  });

  it('removes revenue with its payment and keeps the link inside one tenant', () => {
    expect(migration).toMatch(/REFERENCES "payments"\("id"\)\s+ON DELETE CASCADE/);
    expect(migration).toContain(
      'FOREIGN KEY ("organizationId", "paymentId") REFERENCES "payments" ("organizationId", "id")'
    );
  });

  it('backfills existing payments across tenants without double counting', () => {
    expect(migration).toContain(`set_config('app.is_platform_admin', 'true', true)`);
    expect(migration).toContain(`i."status" <> 'CANCELLED'`);
    expect(migration).toContain('linked."paymentId" = p."id"');
    expect(migration).toContain('manual."paymentId" IS NULL');
    expect(migration).toContain('manual."organizationId" = p."organizationId"');
  });
});
