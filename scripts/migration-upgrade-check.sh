#!/usr/bin/env bash
# Upgrade test for the consolidation merge: build main's schema on a scratch Postgres,
# then apply only the migrations this branch adds, then assert RLS and grants still hold.
# Usage: PGHOST=/tmp PGPORT=55432 PGUSER=postgres scripts/migration-upgrade-check.sh <base-ref>
set -euo pipefail
BASE=${1:-origin/main}; DB=upgrade_check_$$
psql -qX -d postgres -c "CREATE DATABASE $DB" >/dev/null
trap 'psql -qX -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null' EXIT
psql -qX -d $DB -c "DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='devfathom_app') THEN CREATE ROLE devfathom_app LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END\$\$" >/dev/null
# One transaction per file; files that add an enum value and use it (not valid inside one
# transaction) fall back to statement-at-a-time on a clean retry.
apply(){ local f; f=$(mktemp); cat > $f; psql -qX -1 -v ON_ERROR_STOP=1 -d $DB -f $f >/dev/null 2>$f.err || { grep -q 'New enum values must be committed' $f.err && psql -qX -v ON_ERROR_STOP=1 -d $DB -f $f >/dev/null || { cat $f.err >&2; rm -f $f $f.err; return 1; }; }; rm -f $f $f.err; }
snap(){ psql -AtX -d $DB -c "
 SELECT 'rls|'||c.relname||'|'||c.relrowsecurity||'|'||c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
 UNION ALL SELECT 'pol|'||tablename||'|'||policyname FROM pg_policies WHERE schemaname='public'
 UNION ALL SELECT 'grant|'||table_name||'|'||privilege_type FROM information_schema.role_table_grants WHERE grantee='devfathom_app'
 UNION ALL SELECT 'role|'||rolname||'|'||rolsuper||'|'||rolbypassrls FROM pg_roles WHERE rolname='devfathom_app' ORDER BY 1"; }
# Same preflight as deploy: extension prep (prisma/prepare-extensions.sql) and the runtime-role grants
# from prisma/prepare-runtime-role.ts (default privileges so later tables are granted too).
git show "$BASE:prisma/prepare-extensions.sql" | apply
psql -qX -v ON_ERROR_STOP=1 -d $DB -c "GRANT CONNECT ON DATABASE $DB TO devfathom_app; GRANT USAGE ON SCHEMA public TO devfathom_app;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO devfathom_app;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO devfathom_app;" >/dev/null
base_migs=$(git ls-tree --name-only "$BASE" prisma/migrations/ | grep -v migration_lock | sort)
for m in $base_migs; do git show "$BASE:$m/migration.sql" | apply || { echo "FAIL applying base $m"; exit 1; }; done
snap > /tmp/upgrade-before.txt
new=$(comm -13 <(echo "$base_migs") <(ls -d prisma/migrations/*/ | sed 's#/$##' | sort))
echo "base migrations: $(echo "$base_migs" | wc -l); new: $(echo $new)"
for m in $new; do apply < "$m/migration.sql" || { echo "FAIL applying new $m"; exit 1; }; echo "applied $m"; done
snap > /tmp/upgrade-after.txt
lost=$(comm -23 /tmp/upgrade-before.txt /tmp/upgrade-after.txt || true)
norls=$(grep '^rls|' /tmp/upgrade-after.txt | awk -F'|' '$3=="false"{print $2}' | grep -v '^_prisma_migrations$' || true)
role=$(grep '^role|' /tmp/upgrade-after.txt)
trgm=$(psql -AtX -d $DB -c "SELECT bool_and(has_function_privilege('devfathom_app', p, 'EXECUTE')) FROM unnest(ARRAY['public.similarity(text,text)','public.word_similarity(text,text)']::regprocedure[]) p")
echo "lost RLS/policy/grant entries: ${lost:-none}"; echo "tables without RLS: ${norls:-none}"; echo "runtime role: $role"; echo "pg_trgm EXECUTE for app: $trgm"
[ -z "$lost" ] && [ "$role" = "role|devfathom_app|false|false" ] && [ "$trgm" = t ] && echo "UPGRADE CHECK PASS" || { echo "UPGRADE CHECK FAIL"; exit 1; }
