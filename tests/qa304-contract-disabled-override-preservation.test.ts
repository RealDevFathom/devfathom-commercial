// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source guard only; the companion .db.test executes the actual SQL against
// synthetic rows. A free-text reason is not trusted contract-sync provenance.
const sql = readFileSync(
  'prisma/migrations/20261021190000_qa304_contract_disabled_override_cleanup/migration.sql',
  'utf8'
).replace(/--[^\n]*/g, '');

describe('QA-304 ambiguous override preservation', () => {
  it('CTO-P1 leaves the legacy cleanup inert rather than guessing manual-denial provenance', () => {
    expect(sql).not.toMatch(
      /\b(?:DELETE|UPDATE|INSERT|MERGE|TRUNCATE|DROP|ALTER|CREATE|CALL|EXECUTE|PERFORM)\b/i
    );
    expect(sql).toMatch(/\bBEGIN\s+NULL\s*;\s*END\b/i);
  });
});
