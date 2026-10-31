// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve('prisma/migrations/20261029000388_meeting_time_order/migration.sql'),
  'utf8'
);

describe('meeting time-order migration', () => {
  it('repairs legacy invalid rows before installing the constraint', () => {
    expect(sql.indexOf('UPDATE "meetings"')).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf('UPDATE "meetings"')).toBeLessThan(sql.indexOf('ADD CONSTRAINT'));
    expect(sql).toContain('WHERE "endTime" <= "startTime"');
  });

  it('installs without validating under the strong lock, then validates separately', () => {
    expect(sql).toMatch(/ADD CONSTRAINT[\s\S]*CHECK \("endTime" > "startTime"\) NOT VALID;/);
    expect(sql).toContain('VALIDATE CONSTRAINT "meetings_time_order_check"');
    expect(sql.indexOf('COMMIT;')).toBeGreaterThan(sql.indexOf('ADD CONSTRAINT'));
    expect(sql.indexOf('COMMIT;')).toBeLessThan(sql.indexOf('VALIDATE CONSTRAINT'));
  });

  it('scopes the cross-tenant repair to a platform transaction', () => {
    const scope = sql.indexOf("SELECT set_config('app.is_platform_admin', 'true', true);");
    expect(sql.indexOf('BEGIN;')).toBeGreaterThanOrEqual(0);
    expect(scope).toBeGreaterThan(sql.indexOf('BEGIN;'));
    expect(scope).toBeLessThan(sql.indexOf('UPDATE "meetings"'));
  });
});
