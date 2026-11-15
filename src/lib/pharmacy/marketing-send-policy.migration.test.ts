import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = 'prisma/migrations';
const migrations = readdirSync(root)
  .filter((name) => /^\d{14}_/.test(name))
  .sort()
  .map((name) => ({ name, sql: readFileSync(`${root}/${name}/migration.sql`, 'utf8') }));

/** The reason list in force after every migration applies, in order. */
function effectiveDeliveryReasons() {
  let reasons: string[] = [];
  for (const { sql } of migrations) {
    const inline = sql.match(
      /CREATE TABLE pharmacy_campaign_delivery_events[\s\S]*?reason TEXT CHECK \(reason IN \(([^)]*)\)\)/
    );
    if (inline) reasons = [...inline[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
    for (const added of sql.matchAll(
      /ADD CONSTRAINT "pharmacy_campaign_delivery_events_reason_check"\s+CHECK \(reason IN \(([^)]*)\)\)/g
    ))
      reasons = [...added[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
  }
  return reasons;
}

describe('marketing send policy migration (DEV-24)', () => {
  const policy = migrations.find((m) => m.name.endsWith('_pharmacy_marketing_send_policy'))!;

  it('allows every suppression reason dispatch can persist', () => {
    const reasons = effectiveDeliveryReasons();
    for (const reason of [
      'MARKETING_PAUSED',
      'WINDOW_CLOSED',
      'FREQUENCY_CAP',
      'OPTED_OUT',
      'NO_CONSENT',
      'INACTIVE',
      'UNDER_18',
    ])
      expect(reasons).toContain(reason);
  });

  it('extends the reason list as a superset of the original', () => {
    const original = [
      'DEFINITE_REJECTION',
      'TRANSPORT_UNKNOWN',
      'ADAPTER_FAULT',
      'OPTED_OUT',
      'NO_CONSENT',
      'INACTIVE',
      'FREQUENCY_CAP',
      'WINDOW_CLOSED',
      'PROVIDER_FAILURE',
    ];
    expect(effectiveDeliveryReasons()).toEqual(expect.arrayContaining(original));
  });

  it('is transactional, idempotent and row-level secured', () => {
    const sql = policy.sql;
    expect(
      sql
        .trimStart()
        .split('\n')
        .find((line) => !line.startsWith('--'))
    ).toBe('BEGIN;');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_marketing_send_policies"');
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS "pharmacy_campaign_delivery_events_reason_check"'
    );
    expect(sql).toContain(
      'ALTER TABLE "pharmacy_marketing_send_policies" ENABLE ROW LEVEL SECURITY'
    );
    expect(sql).toContain(
      'ALTER TABLE "pharmacy_marketing_send_policies" FORCE ROW LEVEL SECURITY'
    );
  });
});
