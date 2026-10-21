import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20260905020000_pharmacy_expiry_return_advisor/migration.sql',
  'utf8'
);

describe('AI-02 expiry advisor migration', () => {
  it('records a nullable, positive supplier relationship return window', () => {
    expect(migration).toContain('ADD COLUMN "expiryReturnWindowDays" INTEGER');
    expect(migration).toContain('"expiryReturnWindowDays" IS NULL');
    expect(migration).toContain('"expiryReturnWindowDays" > 0');
  });

  it('does not add an anonymous procedure or a stock-moving trigger', () => {
    expect(migration).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(migration).not.toMatch(/CREATE\s+TRIGGER/i);
  });
});
