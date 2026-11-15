// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * DEV-608 — the hand-run repair for same-branch moves stranded IN_TRANSIT before
 * the fix (docs/operations/dev-608-stranded-transfer-repair/*.sql).
 *
 * This static contract always runs. The scripts' behaviour against a real
 * ledger is proved in src/lib/pharmacy/stock-ledger.db.test.ts ("DEV-608 —
 * stranded same-branch transfer repair"), which needs TEST_DATABASE_URL.
 */
const DIR = 'docs/operations/dev-608-stranded-transfer-repair';
const dryRun = readFileSync(`${DIR}/dry-run.sql`, 'utf8');
const repair = readFileSync(`${DIR}/repair.sql`, 'utf8');

const CANDIDATES = /-- candidates:begin\n[\s\S]*?\n-- candidates:end/g;

describe('DEV-608 stranded transfer repair contract', () => {
  it('lives outside prisma/migrations, so nothing applies it automatically', () => {
    expect(existsSync('docs/operations/dev-608-stranded-transfer-repair.md')).toBe(true);
    expect(existsSync('prisma/migrations/dev-608-stranded-transfer-repair')).toBe(false);
    for (const sql of [dryRun, repair]) expect(sql).toContain('NOT A PRISMA MIGRATION');
  });

  it('has a read-only dry run that reports the rows and their counts and changes nothing', () => {
    expect(dryRun).toMatch(/^BEGIN READ ONLY;$/m);
    expect(dryRun).toMatch(/^ROLLBACK;$/m);
    expect(dryRun).not.toMatch(/^COMMIT;$/m);
    expect(dryRun).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
    expect(dryRun).toContain('"willRepair"');
    expect(dryRun).toContain('"pairsToRepair"');
  });

  it('selects exactly the same pairs in the dry run and the repair', () => {
    const blocks = [...dryRun.matchAll(CANDIDATES), ...repair.matchAll(CANDIDATES)].map(
      (match) => match[0]
    );
    expect(blocks).toHaveLength(3);
    expect(new Set(blocks).size).toBe(1);
  });

  it('only targets the legs the pre-fix same-branch transfer posted', () => {
    const [candidates] = repair.match(CANDIDATES)!;
    expect(candidates).toContain(`leg_in."kind" = 'TRANSFER_IN'`);
    expect(candidates).toContain(`leg_in."disposition" = 'IN_TRANSIT'`);
    expect(candidates).toContain(`leg_in."idempotencyKey" LIKE '%:in'`);
    expect(candidates).toContain(`left(leg_in."idempotencyKey", -3) || ':out'`);
    // Already reversed pairs are never candidates again (idempotent re-run).
    expect(candidates).toContain('reversal."reversesMovementId" IN (leg_in."id", leg_out."id")');
  });

  it('repairs only through linked reversals in one checked, all-or-nothing transaction', () => {
    expect(repair).toMatch(/^BEGIN;$/m);
    expect(repair).toMatch(/^COMMIT;$/m);
    const flag = repair.indexOf("SELECT set_config('app.is_platform_admin', 'true', true);");
    expect(flag).toBeGreaterThan(repair.indexOf('BEGIN;'));
    expect(flag).toBeLessThan(repair.indexOf('COMMIT;'));
    // Append-only ledger: no movement or balance is rewritten or removed.
    expect(repair).not.toMatch(/\bUPDATE\s+"?pharmacy_/i);
    expect(repair).not.toMatch(/\bDELETE\b/i);
    expect(repair).toContain('INSERT INTO "pharmacy_stock_movements"');
    expect(repair).toContain('\'ADJUSTMENT\', leg."disposition"');
    expect(repair).toContain('"reversesMovementId"');
    expect(repair).toContain('WHERE "heldBack" IS NULL');
    expect(repair).toContain('IF posted <> pairs * 2 THEN');
  });
});
