import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.M8_TEST_RUNTIME_DATABASE_URL;
const ownerUrl = process.env.M8_TEST_OWNER_DATABASE_URL;

it.skipIf(!url || !ownerUrl)(
  'isolates pharmacy carriers by business and revokes both with the original card',
  async () => {
    assertDisposableRlsDatabase(url!);
    assertDisposableRlsDatabase(ownerUrl!);
    const id = randomUUID();
    const a = 'a-' + id,
      b = 'b-' + id;
    const owner = new Client({ connectionString: ownerUrl });
    const db = new Client({ connectionString: url });
    await owner.connect();
    await db.connect();
    try {
      await owner.query('BEGIN');
      await owner.query("SET LOCAL app.is_platform_admin='true'");
      for (const org of [a, b]) {
        await owner.query(
          `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt")
        VALUES ($1,$1,'Fixture','Fixture','ACTIVE','SHARED',now(),now())`,
          [org]
        );
        await owner.query(
          `INSERT INTO pharmacy_patients (id,"organizationId","displayName","updatedAt") VALUES ($1,$1,'Example',now())`,
          [org]
        );
        await owner.query(
          `INSERT INTO pharmacy_customers (id,"organizationId","patientId","displayName","updatedAt") VALUES ($1,$1,$1,'Example',now())`,
          [org]
        );
        await owner.query(
          `INSERT INTO pharmacy_loyalty_cards (id,"organizationId","customerId","codeHash","issuedById","updatedAt") VALUES ($1,$1,$1,repeat('1',64),'owner',now())`,
          [org]
        );
      }
      await owner.query('COMMIT');
      await db.query('BEGIN');
      expect(
        (await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'))
          .rows
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await db.query("SELECT set_config('app.current_organization_id',$1,true)", [a]);
      const insert = (card: string, platform: string) =>
        db.query(
          `INSERT INTO restaurant_wallet_passes
      (id,"pharmacyCardId",platform,"serialNumber","updatedAt") VALUES ($1,$2,$3,$1,now())`,
          [randomUUID(), card, platform]
        );
      for (const platform of ['APPLE', 'GOOGLE']) await insert(a, platform);
      await db.query('SAVEPOINT foreign_card');
      await expect(insert(b, 'APPLE')).rejects.toMatchObject({ code: '23503' });
      await db.query('ROLLBACK TO foreign_card');
      await db.query("SELECT set_config('app.current_organization_id',$1,true)", [b]);
      expect((await db.query('SELECT id FROM restaurant_wallet_passes')).rows).toEqual([]);
      await db.query("SELECT set_config('app.current_organization_id',$1,true)", [a]);
      await db.query(
        `UPDATE pharmacy_loyalty_cards SET "revokedAt"=now(),"revokedById"='owner',"revokedReason"='Replaced' WHERE id=$1`,
        [a]
      );
      expect((await db.query('SELECT status FROM restaurant_wallet_passes')).rows).toEqual([
        { status: 'REVOKED' },
        { status: 'REVOKED' },
      ]);
      expect((await db.query('SELECT reason FROM restaurant_wallet_pass_updates')).rows).toEqual([
        { reason: 'REVOKE' },
        { reason: 'REVOKE' },
      ]);
    } finally {
      await db.query('ROLLBACK');
      await db.end();
      await owner.end();
    }
  }
);
