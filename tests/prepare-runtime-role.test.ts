import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OWNER_SIMILARITY_GRANT,
  prepareRuntimeRole,
  type RuntimeRoleClient,
} from '../prisma/prepare-runtime-role';

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
  errors: { attributes?: unknown; password?: unknown; similarity?: unknown } = {},
  similarityExecutable = false
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
      if (sql.startsWith('GRANT EXECUTE ON FUNCTION public.similarity_op') && errors.similarity)
        throw errors.similarity;
      if (sql.includes('has_function_privilege'))
        return { rows: [{ allowed: similarityExecutable }] as Row[] };
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

  describe('medicine search similarity operator', () => {
    const denied = () =>
      Object.assign(new Error('permission denied for function similarity_op'), { code: '42501' });

    it('grants as the extension owner when DATABASE_URL may not grant it', async () => {
      const { client } = clientWithRoles(
        [correctRole, correctRole],
        { similarity: denied() },
        true
      );
      const admin = clientWithRoles([]);
      const open = vi.fn(async () => admin.client);
      const output = logger();
      await prepareRuntimeRole(client, undefined, output, open);
      expect(open).toHaveBeenCalledOnce();
      expect(admin.queries.map(({ sql }) => sql)).toEqual([
        'BEGIN',
        OWNER_SIMILARITY_GRANT,
        'COMMIT',
      ]);
      expect(OWNER_SIMILARITY_GRANT).toContain('SET LOCAL ROLE');
      expect(OWNER_SIMILARITY_GRANT).toContain(
        'GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO devfathom_app'
      );
      expect(output.log).toHaveBeenCalledWith(
        'medicine search similarity operator: granted (as extension owner)'
      );
    });

    it('fails with guidance when the runtime role still cannot execute it', async () => {
      const { client } = clientWithRoles([correctRole, correctRole], { similarity: denied() });
      await expect(prepareRuntimeRole(client, undefined, logger())).rejects.toThrow(
        'devfathom_app cannot execute public.similarity_op(text,text)'
      );
    });

    it('fails when the owner grant still leaves the runtime role without access', async () => {
      const { client } = clientWithRoles([correctRole, correctRole], { similarity: denied() });
      const admin = clientWithRoles([]);
      await expect(
        prepareRuntimeRole(client, undefined, logger(), async () => admin.client)
      ).rejects.toThrow('devfathom_app cannot execute public.similarity_op(text,text)');
    });

    it('accepts an existing grant made during extension preparation', async () => {
      const { client } = clientWithRoles(
        [correctRole, correctRole],
        { similarity: denied() },
        true
      );
      const output = logger();
      await prepareRuntimeRole(client, undefined, output);
      expect(output.log).toHaveBeenCalledWith(
        'medicine search similarity operator: skipped (already executable)'
      );
    });

    it('rethrows errors other than permission denied', async () => {
      const broken = Object.assign(new Error('function does not exist'), { code: '42883' });
      const { client } = clientWithRoles([correctRole, correctRole], { similarity: broken }, true);
      await expect(prepareRuntimeRole(client, undefined, logger())).rejects.toThrow(
        'function does not exist'
      );
    });

    it('extension preparation re-grants it to an existing runtime role as the owner', () => {
      const sql = readFileSync(join(process.cwd(), 'prisma', 'prepare-extensions.sql'), 'utf8');
      const revoke = sql.indexOf("EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC'");
      const grant = sql.indexOf(
        'GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO devfathom_app;'
      );
      const resetRole = sql.indexOf("EXECUTE format('SET LOCAL ROLE %I', configured_role);");
      expect(revoke).toBeGreaterThan(-1);
      expect(grant).toBeGreaterThan(revoke);
      expect(grant).toBeLessThan(resetRole);
      expect(sql).toContain("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'devfathom_app'");
    });
  });
});
