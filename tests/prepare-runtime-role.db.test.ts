// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';

// An administrator URL for a DISPOSABLE local cluster. The script creates or alters the
// cluster-wide `devfathom_app` role and this test sets its password. The test snapshots the role
// first and restores it (or drops it if it did not exist) in `finally`, but a crash can still
// leave the role changed, so never point this at your normal development server.
const adminUrl = process.env.RUNTIME_ROLE_TEST_ADMIN_DATABASE_URL;

it.skipIf(!adminUrl)(
  'runs the runtime-role script against a differently named database with an encoded identifier',
  async () => {
    const connection = new URL(adminUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname))
      throw new Error(
        'Runtime-role integration tests require a disposable local PostgreSQL cluster.'
      );
    const admin = new pg.Client({ connectionString: connection.toString() });
    const databaseName = `runtime " staging ${randomBytes(6).toString('hex')}`;
    const databaseIdentifier = pg.escapeIdentifier(databaseName);
    const password = randomBytes(24).toString('hex');
    let databaseCreated = false;
    let owner: pg.Client | undefined;
    let runtime: pg.Client | undefined;
    await admin.connect();
    const roleSnapshot = (
      await admin.query(
        `SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
                r.rolinherit, a.rolpassword
           FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid
          WHERE r.rolname = 'devfathom_app'`
      )
    ).rows[0] as
      | {
          rolcanlogin: boolean;
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolinherit: boolean;
          rolpassword: string | null;
        }
      | undefined;
    try {
      await admin.query(`CREATE DATABASE ${databaseIdentifier}`);
      databaseCreated = true;
      connection.pathname = `/${encodeURIComponent(databaseName)}`;
      owner = new pg.Client({ connectionString: connection.toString() });
      await owner.connect();
      await owner.query(`REVOKE CONNECT ON DATABASE ${databaseIdentifier} FROM PUBLIC`);
      await owner.query('CREATE EXTENSION pg_trgm');
      await owner.query('REVOKE EXECUTE ON FUNCTION public.similarity_op(text,text) FROM PUBLIC');
      await owner.query('CREATE TABLE runtime_role_probe (id serial PRIMARY KEY, value text)');

      const app = new URL(connection);
      app.username = 'devfathom_app';
      app.password = password;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync(
          process.execPath,
          ['--import', 'tsx', 'prisma/prepare-runtime-role.ts'],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              DATABASE_URL: connection.toString(),
              APP_DATABASE_URL: app.toString(),
              EXTENSION_ADMIN_DATABASE_URL: '',
            },
            encoding: 'utf8',
            timeout: 20_000,
          }
        );
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('database connect: granted');
        expect(result.stdout).not.toContain(password);
      }

      await owner.query(
        'CREATE TABLE runtime_role_future_probe (id serial PRIMARY KEY, value text)'
      );
      runtime = new pg.Client({ connectionString: app.toString() });
      await runtime.connect();
      expect((await runtime.query('SELECT current_database() AS name')).rows).toEqual([
        { name: databaseName },
      ]);
      for (const table of ['runtime_role_probe', 'runtime_role_future_probe']) {
        expect(
          (await runtime.query(`INSERT INTO ${table} (value) VALUES ('ok') RETURNING id, value`))
            .rows
        ).toEqual([{ id: 1, value: 'ok' }]);
      }
      expect(
        (await runtime.query("SELECT public.similarity_op('medicine', 'medicine') AS matches")).rows
      ).toEqual([{ matches: true }]);
      expect(
        (
          await runtime.query(`SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
          rolinherit FROM pg_roles WHERE rolname = current_user`)
        ).rows
      ).toEqual([
        {
          rolcanlogin: true,
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
        },
      ]);
    } finally {
      await runtime?.end();
      await owner?.end();
      try {
        if (databaseCreated) await admin.query(`DROP DATABASE ${databaseIdentifier}`);
      } finally {
        // Leave the server as found: restore the previous role state, or remove a role we created.
        if (roleSnapshot) {
          const flag = (on: boolean, name: string) => (on ? name : `NO${name}`);
          const password =
            roleSnapshot.rolpassword === null ? 'NULL' : pg.escapeLiteral(roleSnapshot.rolpassword);
          await admin.query(
            `ALTER ROLE devfathom_app ${[
              flag(roleSnapshot.rolcanlogin, 'LOGIN'),
              flag(roleSnapshot.rolsuper, 'SUPERUSER'),
              flag(roleSnapshot.rolbypassrls, 'BYPASSRLS'),
              flag(roleSnapshot.rolcreatedb, 'CREATEDB'),
              flag(roleSnapshot.rolcreaterole, 'CREATEROLE'),
              flag(roleSnapshot.rolinherit, 'INHERIT'),
            ].join(' ')} PASSWORD ${password}`
          );
        } else {
          await admin.query('DROP ROLE IF EXISTS devfathom_app');
        }
        await admin.end();
      }
    }
  },
  60_000
);
