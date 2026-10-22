import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261023000445_pharmacy_pg_trgm_runtime_execute/migration.sql',
  'utf8'
);

describe('issue 445 pg_trgm runtime grant', () => {
  it('grants only the catalogue search function to the application role', () => {
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.similarity_op(text, text) TO devfathom_app;'
    );
    expect(sql).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+ALL\s+FUNCTIONS/i);
    expect(sql).not.toMatch(/\bTO\s+PUBLIC\b/i);
    expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });
});
