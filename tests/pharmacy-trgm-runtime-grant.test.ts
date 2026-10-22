import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20261023000428_pharmacy_trgm_runtime_grant/migration.sql'
  ),
  'utf8'
);

describe('pharmacy catalogue pg_trgm runtime grant', () => {
  it('grants only the operator implementation used by catalogue search', () => {
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.similarity_op(text, text) TO devfathom_app;'
    );
    expect(migration).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+ALL FUNCTIONS/i);
    expect(migration).not.toMatch(/\bTO\s+PUBLIC\b/i);
  });
});
