import 'dotenv/config';
import pg from 'pg';

const value = process.env.RESTAURANT_E2E_DATABASE_URL;
if (!value) throw new Error('RESTAURANT_E2E_DATABASE_URL is required.');

const parsed = new URL(value);
const forbidden = /(?:preview|staging|production|prod|dev)/i;
if (forbidden.test(`${parsed.hostname}${parsed.pathname}`)) {
  throw new Error('Refusing a preview, development, staging, or production database URL.');
}

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
  if (!/(?:test|e2e|tmp|disposable)/i.test(role.database)) {
    throw new Error('Database name must explicitly identify a disposable test database.');
  }
  console.log('Restaurant E2E database preflight passed.');
} finally {
  await pool.end();
}
