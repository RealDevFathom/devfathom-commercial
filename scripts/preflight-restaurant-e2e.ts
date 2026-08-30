import 'dotenv/config';
import pg from 'pg';
import { resolveRestaurantE2eDatabaseUrl } from './restaurant-e2e-database.js';

async function main() {
  const value = resolveRestaurantE2eDatabaseUrl();

  const pool = new pg.Pool({ connectionString: value, max: 1 });
  try {
    const result = await pool.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      database: string;
    }>(`SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, current_database() AS database
     FROM pg_roles r WHERE r.rolname = current_user`);
    const role = result.rows[0];
    if (!role?.rolcanlogin || role.rolsuper || role.rolbypassrls) {
      throw new Error('Runtime role must be LOGIN NOSUPERUSER NOBYPASSRLS.');
    }
    if (role.database !== decodeURIComponent(new URL(value).pathname.slice(1)))
      throw new Error('Connected database does not match the canonical disposable target.');
    console.log('Restaurant E2E database preflight passed.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
