import 'dotenv/config';
import pg from 'pg';

import { resolvePharmacyE2eDatabaseUrl } from './pharmacy-e2e-environment.js';

async function main() {
  const databaseUrl = resolvePharmacyE2eDatabaseUrl();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      database: string;
    }>(`SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, current_database() AS database
     FROM pg_roles r WHERE r.rolname = current_user`);
    const role = result.rows[0];
    // NOSUPERUSER/NOBYPASSRLS is what makes an RLS-ordering defect surface here
    // rather than in production: a superuser silently passes every policy.
    if (!role?.rolcanlogin || role.rolsuper || role.rolbypassrls) {
      throw new Error('Pharmacy E2E runtime role must be LOGIN NOSUPERUSER NOBYPASSRLS.');
    }
    if (role.database !== decodeURIComponent(new URL(databaseUrl).pathname.slice(1))) {
      throw new Error('Connected database does not match the canonical disposable target.');
    }
    console.log('Pharmacy counter E2E database preflight passed.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
