import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function read(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

// Regression guard for #126: the documented fresh-database setup must run
// `prisma/prepare-extensions.ts` before `prisma migrate deploy`, or the
// btree_gist ACL migration fails closed on an untouched database. The ACL
// migration itself is deliberately NOT weakened; the contract is that the docs
// tell the operator to harden the extensions first.
describe('documented local setup hardens extensions before migrate', () => {
  for (const doc of ['README.md', join('docs', 'LOCAL_SETUP.md')]) {
    it(`${doc} runs prepare-extensions before prisma migrate deploy`, () => {
      const source = read(doc);
      const prepareIndex = source.indexOf('prepare-extensions.ts');
      const migrateIndex = source.indexOf('prisma migrate deploy');

      expect(prepareIndex, 'prepare-extensions.ts must be documented').toBeGreaterThan(-1);
      expect(migrateIndex, 'prisma migrate deploy must be documented').toBeGreaterThan(-1);
      expect(prepareIndex).toBeLessThan(migrateIndex);
    });
  }

  it('LOCAL_SETUP documents the EXTENSION_ADMIN_DATABASE_URL the step reads', () => {
    expect(read(join('docs', 'LOCAL_SETUP.md'))).toContain('EXTENSION_ADMIN_DATABASE_URL');
  });
});
