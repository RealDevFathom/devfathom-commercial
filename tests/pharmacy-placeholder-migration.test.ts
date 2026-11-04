import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('#631 placeholder migration contract', () => {
  const placeholderMigration = read(
    'prisma/migrations/20261022233600_pharmacy_placeholder_rule_set/migration.sql'
  );
  const originalRulesMigration = read(
    'prisma/migrations/20260902130000_pharmacy_regulatory_profiles/migration.sql'
  );
  const restoredTriggerMigration = read(
    'prisma/migrations/20261022235900_restore_regulatory_delete_exceptions/migration.sql'
  );

  it('adds detectable placeholder flags without seeding any data', () => {
    expect(placeholderMigration).toContain(
      'ADD COLUMN "isPlaceholder" BOOLEAN NOT NULL DEFAULT false'
    );
    expect(placeholderMigration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(placeholderMigration).not.toContain('pk_pb_placeholder_v1');
  });

  it('leaves the original provisional rule-set seed unchanged', () => {
    expect(originalRulesMigration).toContain(
      "'pk_pb_provisional_v1', 'PK-PB', 1, '2026-09-02T00:00:00.000Z'"
    );
    expect(originalRulesMigration.match(/pk_pb_provisional_v1/g)).toHaveLength(1);
    expect(originalRulesMigration).toContain(
      '\'{"values":[],"provisional":true,"toConfirm":"PHARM-P0-COUNSEL-001 C-01..C-08"}\''
    );
  });

  it('never commits an intermediate weakened trigger (every migration in sequence)', () => {
    for (const m of [placeholderMigration, restoredTriggerMigration]) {
      expect(m).not.toContain('OLD."isPlaceholder" = true');
      if (m.includes('pharmacy_reject_regulatory_rewrite')) {
        expect(m).toContain("current_setting('app.purging_organization_id'");
        expect(m).toContain("AND current_setting('app.is_platform_admin', true) = 'true'");
        expect(m).toContain(
          'NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId")'
        );
      }
    }
  });

  it('allows deletes only for organization purge and orphan cleanup', () => {
    expect(restoredTriggerMigration).toContain("current_setting('app.purging_organization_id'");
    expect(restoredTriggerMigration).toContain(
      'NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId")'
    );
    expect(restoredTriggerMigration).not.toContain('OLD."isPlaceholder" = true');
    // Purge deletes additionally require the platform-admin session flag (main's guard).
    expect(restoredTriggerMigration).toMatch(
      /app\.purging_organization_id[\s\S]{0,160}AND current_setting\('app\.is_platform_admin', true\) = 'true'/
    );
    expect(restoredTriggerMigration).toContain(
      "TG_TABLE_NAME = 'pharmacy_branch_regulatory_profiles'"
    );
  });
});
