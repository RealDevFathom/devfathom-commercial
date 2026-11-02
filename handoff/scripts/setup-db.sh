#!/bin/bash
# Recreate the local gate-equivalent Postgres 16 used by the machine checks (mirrors .github/workflows/qa.yml).
# Throwaway cluster on 127.0.0.1:55432; never point this at a shared database.
set -eu
S=${HANDOFF_STATE:?set HANDOFF_STATE}; REPO=${REPO:-$(git rev-parse --show-toplevel)}
PGB=/usr/lib/postgresql/16/bin; D=/var/lib/postgresql/gate
mkdir -p $D && chown postgres:postgres $D
echo 'gate-postgres-ci-only' > /var/lib/postgresql/pw.txt && chown postgres /var/lib/postgresql/pw.txt
[ -f $D/PG_VERSION ] || su postgres -c "$PGB/initdb -D $D -U postgres --auth=md5 --pwfile=/var/lib/postgresql/pw.txt"
su postgres -c "$PGB/pg_ctl -D $D -o '-p 55432 -k /tmp -c max_connections=300 -c fsync=off -c synchronous_commit=off -c full_page_writes=off' -l /var/lib/postgresql/gate.log start" || true
sleep 2
python3 -I - "$REPO/.github/workflows/qa.yml" "$S/gate.env" <<'PY'
import yaml, shlex, sys
env = yaml.safe_load(open(sys.argv[1]))["jobs"]["automated-gate"]["env"]
open(sys.argv[2], "w").write("".join(f"export {k}={shlex.quote(str(v))}\n" for k, v in env.items()))
PY
source $S/gate.env; export PGPASSWORD=gate-postgres-ci-only
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE ROLE gate_owner LOGIN PASSWORD 'gate-owner-ci-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE NOINHERIT;
CREATE ROLE gate_runtime LOGIN PASSWORD 'gate-runtime-ci-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE DATABASE devfathom_gate_test OWNER gate_owner;
REVOKE ALL ON DATABASE devfathom_gate_test FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE devfathom_gate_test TO gate_runtime;
CREATE DATABASE devfathom_gate_shadow_test OWNER gate_owner;
SQL
cd "$REPO"
DATABASE_URL="$OWNER_URL" MIGRATION_DATABASE_URL="$OWNER_URL" EXTENSION_ADMIN_DATABASE_URL="$OWNER_URL" bun prisma/prepare-extensions.ts
DATABASE_URL="$OWNER_URL" MIGRATION_DATABASE_URL="$OWNER_URL" bunx prisma migrate deploy
psql "$OWNER_URL" -q -c 'GRANT USAGE ON SCHEMA public TO gate_runtime;' -c 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gate_runtime;' -c 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gate_runtime;' -c 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gate_runtime;' -c 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO gate_runtime;'
DATABASE_URL="$OWNER_URL" MIGRATION_DATABASE_URL="$OWNER_URL" bunx prisma db seed
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -q -c "CREATE DATABASE devfathom_gate_template TEMPLATE devfathom_gate_test OWNER gate_owner"
mkdir -p $S/baseline
NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit 2>/dev/null | grep -E 'error TS[0-9]+' | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u > $S/baseline/typecheck.errors || true
echo "gate DB ready; baseline typecheck errors: $(wc -l < $S/baseline/typecheck.errors)"
