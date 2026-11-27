import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.M8_TEST_RUNTIME_DATABASE_URL;
it.skipIf(!url)(
  'defaults designs off, forces isolation and refuses another business’s branding',
  async () => {
    assertDisposableRlsDatabase(url!);
    const db = new Client({ connectionString: url });
    await db.connect();
    try {
      await db.query('BEGIN');
      expect(
        (await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
          .rows
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const a = randomUUID(),
        b = randomUUID();
      await db.query("SELECT set_config('app.current_organization_id',$1,true)", [a]);
      const create = (org: string) =>
        db.query(
          `INSERT INTO restaurant_wallet_tenant_config (id,"organizationId","programDisplayName","googleClassSuffix","updatedAt") VALUES ($1,$2,'Example rewards',$1,now()) RETURNING enabled`,
          [randomUUID(), org]
        );
      expect((await create(a)).rows).toEqual([{ enabled: false }]);
      expect(
        (
          await db.query(
            "SELECT relforcerowsecurity FROM pg_class WHERE oid='restaurant_wallet_tenant_config'::regclass"
          )
        ).rows
      ).toEqual([{ relforcerowsecurity: true }]);
      await db.query("SELECT set_config('app.current_organization_id',$1,true)", [b]);
      expect(
        (await db.query('UPDATE restaurant_wallet_tenant_config SET enabled=true RETURNING id'))
          .rows
      ).toEqual([]);
      await expect(create(a)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  }
);
