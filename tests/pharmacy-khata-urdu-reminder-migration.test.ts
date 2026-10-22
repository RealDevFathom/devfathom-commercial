import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL(
    '../prisma/migrations/20261023025300_khata_urdu_reminder/migration.sql',
    import.meta.url
  ),
  'utf8'
);

describe('khata Urdu reminder migration', () => {
  it('defaults existing customers to English and restricts the preference to supported languages', () => {
    expect(sql).toContain('ADD COLUMN "preferredLanguage" TEXT NOT NULL DEFAULT \'en\'');
    expect(sql).toContain('CHECK ("preferredLanguage" IN (\'en\', \'ur\'))');
  });
});
