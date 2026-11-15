import 'dotenv/config';
import pg from 'pg';

import { agencyE2eEnvironment } from './agency-e2e-environment.js';

async function main() {
  const databaseUrl = agencyE2eEnvironment().DATABASE_URL!;
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
    if (!role?.rolcanlogin || role.rolsuper || role.rolbypassrls) {
      throw new Error('Agency E2E runtime role must be LOGIN NOSUPERUSER NOBYPASSRLS.');
    }
    if (role.database !== decodeURIComponent(new URL(databaseUrl).pathname.slice(1))) {
      throw new Error('Connected database does not match the canonical disposable target.');
    }
    console.log('Agency E2E database preflight passed.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
