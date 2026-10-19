#!/bin/bash
set -euo pipefail
cd /Users/Saad/Developer/paperclip-worktrees/devfathom/ph-qa-specs
export PAPERCLIP_RUN_SCRATCH_DIR="$PWD/.qa-run"
export PGDATA="$PAPERCLIP_RUN_SCRATCH_DIR/pg-counter"
port=55689
if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null; then echo 'Port occupied: stop'; exit 1; fi
initdb -D "$PGDATA" -U qa_bootstrap --auth=trust --locale=C > .qa-run/evidence/counter-initdb.log
pg_ctl -D "$PGDATA" -l "$PAPERCLIP_RUN_SCRATCH_DIR/counter-postgres.log" -o "-h 127.0.0.1 -p $port -k $PAPERCLIP_RUN_SCRATCH_DIR" start
psql -h 127.0.0.1 -p "$port" -U qa_bootstrap -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE qa_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
CREATE ROLE qa_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE pharmacy_counter_e2e OWNER qa_owner;
SQL
export EXTENSION_ADMIN_DATABASE_URL="postgresql://qa_bootstrap@127.0.0.1:$port/pharmacy_counter_e2e"
export DATABASE_URL="postgresql://qa_owner@127.0.0.1:$port/pharmacy_counter_e2e"
bunx tsx prisma/prepare-extensions.ts
bunx prisma migrate deploy
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO qa_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qa_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qa_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO qa_runtime;
SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcanlogin FROM pg_roles WHERE rolname IN ('qa_owner','qa_runtime');
SQL
