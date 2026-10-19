#!/bin/zsh
# Provision one fresh gate database on the f2c59457 cluster: drop, recreate,
# prepare-extensions, migrate, grant, base seed.
# Usage: 01-provision-db.sh <dbname>
set -eu
DB="$1"
GATE=/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se/_gate-evidence/134f17fa/wha-1132
WT=/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se
PGH=127.0.0.1
PGP=55593

cd "$WT"
unset RESTAURANT_INTEGRATED_E2E RESTAURANT_E2E_DATABASE_URL PLAYWRIGHT_BASE_URL AGENCY_E2E AGENCY_E2E_DATABASE_URL 2>/dev/null || true

echo "=== [$DB] drop + recreate ==="
psql -h $PGH -p $PGP -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);"
psql -h $PGH -p $PGP -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE $DB OWNER gate_owner;"
psql -h $PGH -p $PGP -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "REVOKE ALL ON DATABASE $DB FROM PUBLIC;" \
  -c "GRANT CONNECT, TEMPORARY ON DATABASE $DB TO gate_runtime;"

echo "=== [$DB] prepare-extensions ==="
EXTENSION_ADMIN_DATABASE_URL="postgresql://postgres@$PGH:$PGP/$DB" \
  bunx tsx prisma/prepare-extensions.ts

echo "=== [$DB] migrate deploy ==="
DATABASE_URL="postgresql://gate_owner@$PGH:$PGP/$DB" \
  bunx prisma migrate deploy

echo "=== [$DB] runtime grants for gate_runtime ==="
psql -h $PGH -p $PGP -U gate_owner -d "$DB" -v ON_ERROR_STOP=1 \
  -c "GRANT USAGE ON SCHEMA public TO gate_runtime;" \
  -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gate_runtime;" \
  -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gate_runtime;" \
  -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gate_runtime;"

echo "=== [$DB] base seed ==="
source "/Users/Saad/devfathom-gates/b59f39a8/browser/.runsecrets"
DATABASE_URL="postgresql://gate_owner@$PGH:$PGP/$DB" bunx prisma db seed

echo "=== [$DB] migration count ==="
psql -h $PGH -p $PGP -U gate_owner -d "$DB" -At \
  -c "select count(*) from _prisma_migrations where finished_at is not null;"
echo "=== [$DB] PROVISION_OK ==="
