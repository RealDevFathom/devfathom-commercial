import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('prisma/prepare-runtime-role.ts'), 'utf8');

describe('runtime role preparation', () => {
  it('generates restricted role SQL without privileged attributes and retains its post-condition', () => {
    const roleSql = source.match(/await client\.query\(`([\s\S]*?)`\);/)?.[1];

    expect(roleSql).toBeDefined();
    expect(roleSql).toContain('CREATE ROLE ${ROLE_NAME};');
    expect(roleSql).toContain('ALTER ROLE ${ROLE_NAME} LOGIN NOCREATEDB NOCREATEROLE NOINHERIT;');
    expect(roleSql).not.toMatch(/\b(?:NO)?SUPERUSER\b|\b(?:NO)?BYPASSRLS\b/);

    expect(source).toContain(
      'SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit'
    );
    expect(source).toMatch(/role\.rolsuper\s*\|\|\s*role\.rolbypassrls/);
  });
});
