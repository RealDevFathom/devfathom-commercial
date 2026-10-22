import { describe, expect, it, vi } from 'vitest';
import { prepareRuntimeRole, type RuntimeRoleClient } from '../prisma/prepare-runtime-role';

type Role = {
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
};
const correctRole: Role = {
  rolcanlogin: true,
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
};

function clientWithRoles(
  roles: Array<Role | undefined>,
  errors: { attributes?: unknown; password?: unknown } = {}
) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client: RuntimeRoleClient = {
    async query<Row>(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes('SELECT rolcanlogin'))
        return { rows: [roles.shift()].filter(Boolean) as Row[] };
      if (sql.startsWith('ALTER ROLE') && sql.includes('PASSWORD') && errors.password)
        throw errors.password;
      if (sql.startsWith('ALTER ROLE') && !sql.includes('PASSWORD') && errors.attributes)
        throw errors.attributes;
      if (sql.startsWith("SELECT format('ALTER ROLE"))
        return { rows: [{ sql: "ALTER ROLE devfathom_app PASSWORD 'redacted'" }] as Row[] };
      return { rows: [] };
    },
  };
  return { client, queries };
}
const logger = () => ({ log: vi.fn(), warn: vi.fn() });

describe('runtime role preparation', () => {
  it('creates a fresh restricted role, sets supplied password, and grants access', async () => {
    const { client, queries } = clientWithRoles([undefined, correctRole, correctRole]);
    const output = logger();
    await prepareRuntimeRole(client, 'secret-value', output);
    expect(queries.map(({ sql }) => sql)).toContain(
      'CREATE ROLE devfathom_app LOGIN NOCREATEDB NOCREATEROLE NOINHERIT'
    );
    expect(queries.some(({ sql }) => sql.startsWith('ALTER ROLE devfathom_app LOGIN'))).toBe(false);
    expect(queries.find(({ sql }) => sql.startsWith("SELECT format('ALTER ROLE"))?.values).toEqual([
      'secret-value',
    ]);
    expect(queries.map(({ sql }) => sql)).toContain(
      'GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO devfathom_app'
    );
    expect(queries.filter(({ sql }) => /^(GRANT|ALTER DEFAULT PRIVILEGES)/.test(sql))).toHaveLength(
      7
    );
    expect([...output.log.mock.calls, ...output.warn.mock.calls].flat().join('\n')).not.toContain(
      'secret-value'
    );
  });

  it('skips changes when existing posture is correct', async () => {
    const { client, queries } = clientWithRoles([correctRole, correctRole]);
    const output = logger();
    await prepareRuntimeRole(client, undefined, output);
    expect(queries.some(({ sql }) => /^(CREATE|ALTER) ROLE/.test(sql))).toBe(false);
    expect(output.log).toHaveBeenCalledWith('attributes: skipped (already correct)');
    expect(output.log).toHaveBeenCalledWith('password: skipped (APP_DATABASE_URL has no password)');
  });

  it('runs every grant when an existing correct role password alter is denied', async () => {
    const secret = 'staging-secret-value';
    const denied = Object.assign(new Error('permission denied'), { code: '42501' });
    const { client, queries } = clientWithRoles([correctRole, correctRole], { password: denied });
    const output = logger();

    await prepareRuntimeRole(client, secret, output);

    expect(queries.filter(({ sql }) => /^(GRANT|ALTER DEFAULT PRIVILEGES)/.test(sql))).toHaveLength(
      7
    );
    expect(output.warn).toHaveBeenCalledWith(
      'password: skipped (permission denied; final posture verified)'
    );
    expect([...output.log.mock.calls, ...output.warn.mock.calls].flat().join('\n')).not.toContain(
      secret
    );
  });

  it('continues grants after denied alter when final posture is correct', async () => {
    const incorrect = { ...correctRole, rolcanlogin: false };
    const denied = Object.assign(new Error('permission denied'), { code: '42501' });
    const { client, queries } = clientWithRoles([incorrect, correctRole], { attributes: denied });
    const output = logger();
    await prepareRuntimeRole(client, undefined, output);
    expect(queries.findIndex(({ sql }) => sql.startsWith('GRANT CONNECT'))).toBeGreaterThan(
      queries.findIndex(({ sql }) => sql.startsWith('ALTER ROLE'))
    );
    expect(output.warn).toHaveBeenCalledWith(
      'attributes: skipped (permission denied; final posture verified)'
    );
  });

  it('fails after grants when denied alter leaves posture wrong', async () => {
    const incorrect = { ...correctRole, rolcanlogin: false };
    const denied = Object.assign(new Error('permission denied'), { code: '42501' });
    const { client, queries } = clientWithRoles([incorrect, incorrect], { attributes: denied });
    await expect(prepareRuntimeRole(client, undefined, logger())).rejects.toThrow(
      'devfathom_app does not have the required restricted role attributes.'
    );
    expect(queries.some(({ sql }) => sql.startsWith('GRANT CONNECT'))).toBe(true);
  });

  it('never mutates privileged attributes', async () => {
    const privileged = { ...correctRole, rolsuper: true, rolbypassrls: true };
    const { client, queries } = clientWithRoles([privileged, privileged]);
    await expect(prepareRuntimeRole(client, undefined, logger())).rejects.toThrow();
    expect(queries.filter(({ sql }) => /^(CREATE|ALTER) ROLE/.test(sql))).toEqual([]);
  });
});
