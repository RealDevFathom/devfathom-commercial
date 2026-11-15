import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20261115220400_pharmacy_province_nonempty_checks/migration.sql'
  ),
  'utf8'
);

describe('DEV-235 province non-empty migration', () => {
  it('runs in one transaction', () => {
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it('refuses a blank province on a new or re-provinced branch, idempotently', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION pharmacy_branch_province_nonempty() RETURNS trigger'
    );
    expect(migration).toContain(`IF btrim(coalesce(NEW."provinceCode", '')) = ''`);
    expect(migration).toContain("USING ERRCODE = '23514'");
    expect(migration).toContain(
      'DROP TRIGGER IF EXISTS "pharmacy_branches_province_nonempty" ON "pharmacy_branches";'
    );
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF "provinceCode" ON "pharmacy_branches"');
  });

  it('keeps unrelated updates to legacy blank-province branches working', () => {
    // 20260902160000 backfilled branches with provinceCode = ''. A CHECK would be
    // enforced on every later UPDATE of those rows, so the branch rule is a
    // trigger that only fires when the province is inserted or changed.
    expect(migration).toContain(
      `(TG_OP = 'INSERT' OR NEW."provinceCode" IS DISTINCT FROM OLD."provinceCode")`
    );
    expect(migration).not.toMatch(/ALTER TABLE "pharmacy_branches"/);
  });

  it('refuses a blank province on a regulatory profile, idempotently', () => {
    const constraint = 'pharmacy_branch_regulatory_profiles_province_nonempty';
    expect(migration).toContain(
      `ALTER TABLE "pharmacy_branch_regulatory_profiles"\n      ADD CONSTRAINT "${constraint}"\n      CHECK (btrim("provinceCode") <> '') NOT VALID;`
    );
    expect(migration).toContain(`WHERE conname = '${constraint}'`);
  });

  it('never rewrites or deletes existing rows (append-only regulatory history)', () => {
    expect(migration).not.toMatch(/\b(UPDATE|DELETE|INSERT)\s+(INTO\s+)?"/);
    expect(migration).not.toMatch(/VALIDATE CONSTRAINT/i);
  });
});
