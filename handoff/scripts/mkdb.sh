#!/bin/bash
# Create a scratch test database for the checkout in <dir> on the local throwaway cluster (:55432).
# If the checkout contains every develop migration: clone the develop template, then apply the extra migrations.
# Otherwise (older branch): build from empty with the checkout's own migrations and seed.
# usage: mkdb.sh <db-name> <dir>   (db name must match devfathom_gate_lane_*_test)
set -u
S=${HANDOFF_STATE:-/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad}
DB=$1; DIR=$2
case "$DB" in devfathom_gate_lane_*_test) ;; *) echo "refusing db $DB"; exit 2;; esac
cd "$DIR" || exit 2
export PGPASSWORD=gate-postgres-ci-only
PG="psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q"
OWNER="postgresql://gate_owner:gate-owner-ci-only@127.0.0.1:55432/$DB"
$PG -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB'" >/dev/null 2>&1
$PG -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
missing=$(comm -23 <(git ls-tree --name-only origin/develop prisma/migrations/ | sort) <(ls -d prisma/migrations/*/ 2>/dev/null | sed 's#/$##' | sort) | grep -v migration_lock | wc -l)
if [ "$missing" -eq 0 ]; then
  MODE=template
  $PG -c "CREATE DATABASE $DB TEMPLATE devfathom_gate_template OWNER gate_owner" || exit 1
  $PG -c "GRANT CONNECT, TEMPORARY ON DATABASE $DB TO gate_runtime"
  DATABASE_URL="$OWNER" MIGRATION_DATABASE_URL="$OWNER" bunx prisma migrate deploy > /dev/null 2>&1; RC=$?
else
  MODE=fresh
  $PG -c "CREATE DATABASE $DB OWNER gate_owner" -c "REVOKE ALL ON DATABASE $DB FROM PUBLIC" -c "GRANT CONNECT, TEMPORARY ON DATABASE $DB TO gate_runtime" || exit 1
  [ -f prisma/prepare-extensions.ts ] && DATABASE_URL="$OWNER" MIGRATION_DATABASE_URL="$OWNER" EXTENSION_ADMIN_DATABASE_URL="$OWNER" bun prisma/prepare-extensions.ts >/dev/null 2>&1
  DATABASE_URL="$OWNER" MIGRATION_DATABASE_URL="$OWNER" bunx prisma migrate deploy > /dev/null 2>&1; RC=$?
  psql "$OWNER" -q -c 'GRANT USAGE ON SCHEMA public TO gate_runtime;' -c 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gate_runtime;' -c 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO gate_runtime;' >/dev/null 2>&1
  source $S/gate.env
  [ $RC -eq 0 ] && DATABASE_URL="$OWNER" MIGRATION_DATABASE_URL="$OWNER" SEED_PASSWORD="$SEED_PASSWORD" timeout 600 bunx prisma db seed > /dev/null 2>&1
fi
psql "$OWNER" -q -c 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gate_runtime;' -c 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gate_runtime;' >/dev/null 2>&1
echo "$MODE migrate=$RC"
exit $RC
