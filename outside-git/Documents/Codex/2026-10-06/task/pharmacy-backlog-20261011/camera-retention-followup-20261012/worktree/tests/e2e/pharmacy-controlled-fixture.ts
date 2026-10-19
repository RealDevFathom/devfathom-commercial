import { Client } from 'pg';
import { hash } from 'bcryptjs';
import { PHARMACY_E2E as fixture } from './pharmacy-counter-fixture';
import { resolvePharmacyE2eDatabaseUrl } from '../../scripts/pharmacy-e2e-environment';

export const pharmacistId = 'user_controlled_e2e_pharmacist';
export const staffId = 'staff_controlled_e2e_pharmacist';
export const pharmacistPin = '739215';
export async function controlledClient() {
  const url = resolvePharmacyE2eDatabaseUrl();
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || Number(parsed.port) < 55600 || Number(parsed.port) > 55699)
    throw new Error('Disposable loopback lane required');
  const db = new Client({ connectionString: url });
  await db.connect();
  await db.query("SELECT set_config('app.current_organization_id',$1,false)", [
    fixture.organizationId,
  ]);
  return db;
}
export async function prepareControlledFixture() {
  const db = await controlledClient();
  try {
    await db.query(`UPDATE pharmacy_medicines SET controlled=true WHERE id=$1`, [
      fixture.medicines.rx.id,
    ]);
    await db.query(
      `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,role,department,title,status,"updatedAt") SELECT $1,"organizationId","organizationRoleId",'Independent pharmacist','controlled-pharmacist@example.test',role,department,title,status,now() FROM users WHERE id=$2 ON CONFLICT(id) DO NOTHING`,
      [pharmacistId, fixture.adminId]
    );
    // Dispensing is an explicit capability even for administrators. Give only
    // the independent synthetic pharmacist this permission; never the cashier.
    await db.query(
      `INSERT INTO user_permission_overrides
        (id,"organizationId","userId",capability,effect,reason,"updatedAt")
       VALUES ('permission_controlled_e2e_dispense',$1,$2,'pharmacy:dispense','ALLOW','Synthetic independent pharmacist fixture',now())
       ON CONFLICT("userId",capability) DO NOTHING`,
      [fixture.organizationId, pharmacistId]
    );
    await db.query(
      `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName",status,"updatedAt") VALUES ($1,$2,$3,'Independent pharmacist','ACTIVE',now()) ON CONFLICT(id) DO NOTHING`,
      [staffId, fixture.organizationId, pharmacistId]
    );
    await db.query(
      `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ('credential_controlled_e2e',$1,$2,'PIN',$3,now()) ON CONFLICT(id) DO NOTHING`,
      [fixture.organizationId, staffId, await hash(pharmacistPin, 12)]
    );
  } finally {
    await db.end();
  }
}
