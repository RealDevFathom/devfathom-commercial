#!/bin/sh
# Builds DATABASE_URL from Secrets Manager fields injected by ECS, then execs the
# real command. When DATABASE_URL is already set (local dev, Azure Container Apps)
# this script does not touch it.
set -eu

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  DATABASE_URL=$(node -e 'const user=encodeURIComponent(process.env.DB_USERNAME||""); const password=encodeURIComponent(process.env.DB_PASSWORD||""); const host=process.env.DB_HOST; const port=process.env.DB_PORT||"5432"; const name=process.env.DB_NAME||"devfathom"; if(!user||!password||!host){console.error("DB_USERNAME, DB_PASSWORD, and DB_HOST are required to build DATABASE_URL"); process.exit(1);} const cert=process.env.NODE_EXTRA_CA_CERTS||"/etc/ssl/rds-global-bundle.pem"; process.stdout.write(`postgresql://${user}:${password}@${host}:${port}/${name}?sslmode=verify-full&sslrootcert=${cert}`);')
  export DATABASE_URL
fi

if [ "${PREPARE_EVOLUTION_DATABASE:-}" = "true" ]; then
  node <<'NODE'
const { Client } = require('pg');

(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to prepare the evolution database.');
  }
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['evolution']);
    if (existing.rowCount === 0) {
      await admin.query('CREATE DATABASE evolution');
    }
  } finally {
    await admin.end();
  }
})().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`Failed to ensure the evolution database exists: ${message}`);
  process.exit(1);
});
NODE
fi

exec "$@"
