#!/bin/bash
# Wraps the upstream Evolution image so the database URI is composed at runtime
# from ECS-injected secret fields. The upstream deploy script prints DATABASE_URL;
# that line is removed so the password does not land in CloudWatch.
set -euo pipefail
cd /evolution

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  DATABASE_URL="$(node -e 'const user=encodeURIComponent(process.env.DB_USERNAME||""); const password=encodeURIComponent(process.env.DB_PASSWORD||""); const host=process.env.DB_HOST; const port=process.env.DB_PORT||"5432"; if(!user||!password||!host){console.error("DB_USERNAME, DB_PASSWORD, and DB_HOST are required"); process.exit(1);} const cert=process.env.RDS_CA_BUNDLE||"/etc/ssl/rds-global-bundle.pem"; process.stdout.write(`postgresql://${user}:${password}@${host}:${port}/evolution?sslmode=verify-full&sslrootcert=${cert}`);')"
  export DATABASE_URL
  export DATABASE_CONNECTION_URI="${DATABASE_CONNECTION_URI:-$DATABASE_URL}"
fi

export CACHE_REDIS_URI="${CACHE_REDIS_URI:-redis://127.0.0.1:6379}"

if [ -f ./Docker/scripts/deploy_database.sh ]; then
  sed -i '/Database URL:/d' ./Docker/scripts/deploy_database.sh
fi

exec bash -c '. ./Docker/scripts/deploy_database.sh && npm run start:prod'
