#!/bin/zsh
set -u

WT='/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1212-gate-candidate-134f17fa-automated-part-1-wha-1125-contract-fresh-pg16-owner-runtime-roles-migrate-deploy-as-own'
RUN_SCRATCH="${PAPERCLIP_RUN_SCRATCH_DIR:?PAPERCLIP_RUN_SCRATCH_DIR is required}"
ROOT="$RUN_SCRATCH/devfathom-gates/134f17fa"
E="$ROOT/wha-1125"
FINAL="$WT/_gate-evidence/134f17fa/wha-1125"
PGDATA="$E/pg16"
PGSOCKET="$RUN_SCRATCH/pgsocket-55594"
PORT=55594
DB='devfathom_gate_134f17fa'
EXITS="$E/exit-codes.txt"
COMMANDS="$E/commands.txt"
SECRETS_FILE="$(mktemp "$RUN_SCRATCH/wha-1212-secrets.XXXXXX")"
BOOTSTRAP_SQL="$(mktemp "$RUN_SCRATCH/wha-1212-bootstrap.XXXXXX.sql")"

umask 077
mkdir -p "$E"
cp "$0" "$E/phase1-gate.sh"
: > "$EXITS"
: > "$COMMANDS"
mkdir -p "$PGSOCKET"
cd "$WT" || exit 1

record() { print -r -- "$1=$2" >> "$EXITS"; }
command_record() { print -r -- "$1" >> "$COMMANDS"; }
run_step() {
  local name="$1"
  shift
  command_record "$name (exact invocation in phase1-gate.sh; credential-bearing arguments omitted here)"
  "$@" > "$E/$name.stdout.log" 2> "$E/$name.stderr.log"
  local code=$?
  record "$name" "$code"
  return $code
}
copy_evidence() {
  mkdir -p "$FINAL"
  rsync -a --exclude pg16 --exclude socket "$E/" "$FINAL/"
}
stop_cluster() {
  if test -f "$PGDATA/postmaster.pid"; then
    pg_ctl -D "$PGDATA" stop -m fast > "$E/pg-stop.stdout.log" 2> "$E/pg-stop.stderr.log"
    record pg-stop "$?"
  fi
}
write_summary() {
  local all_green=1
  while IFS='=' read -r name code; do
    case "$name:$code" in
      docker-info:*|image-gate:NOT-RUN) continue ;;
    esac
    [[ "$code" == '0' ]] || all_green=0
  done < "$EXITS"
  if (( all_green )); then
    print -r -- 'GREEN' > "$E/part1-status.txt"
  else
    print -r -- 'NOT_GREEN' > "$E/part1-status.txt"
    if ! test -s "$E/first-failure.txt"; then
      awk -F= '$2 != "0" && $1 != "docker-info" && !($1 == "image-gate" && $2 == "NOT-RUN") {print "First non-green check: "$0; exit}' "$EXITS" > "$E/first-failure.txt"
    fi
  fi
  {
    print -r -- 'WHA-1212 PART 1 AUTOMATED GATE'
    print -r -- "HEAD=$(git rev-parse HEAD 2>/dev/null || print -r -- unavailable)"
    print -r -- "MIGRATION_COUNT=${MIGRATIONS:-unavailable}"
    print -r -- "PART1_STATUS=$(cat "$E/part1-status.txt")"
    print -r -- 'ROLE_FIELDS=rolname|rolsuper|rolbypassrls|rolcreatedb|rolcreaterole|rolinherit|rolcanlogin'
    cat "$E/role-proof.stdout.log" 2>/dev/null || print -r -- 'unavailable'
    print -r -- 'VITEST_COUNTS'
    cat "$E/vitest-counts.txt" 2>/dev/null || print -r -- 'unavailable'
    print -r -- 'EXIT_CODES'
    cat "$EXITS"
    print -r -- 'FIRST_FAILURE'
    cat "$E/first-failure.txt" 2>/dev/null || print -r -- 'none'
  } > "$E/final-summary.txt"
}
finalize() {
  local original_code=$?
  git rev-parse HEAD > "$E/final-head.txt" 2> "$E/final-head.stderr.log"
  record final-head "$?"
  git status --porcelain=v1 > "$E/final-porcelain.log" 2> "$E/final-porcelain.stderr.log"
  record final-porcelain "$?"
  stop_cluster
  rm -f "$SECRETS_FILE" "$BOOTSTRAP_SQL"
  write_summary
  copy_evidence
  return $original_code
}
trap 'finalize' EXIT

git rev-parse HEAD > "$E/head.stdout.log" 2> "$E/head.stderr.log"
record head "$?"
if [[ "$(cat "$E/head.stdout.log")" != '134f17fa15dc6cb3733f1368dcff54b1faf47a7d' ]]; then
  record exact-head 1
  print -r -- 'HEAD mismatch before gate.' > "$E/first-failure.txt"
  exit 1
fi
record exact-head 0
git branch --show-current > "$E/branch.stdout.log" 2> "$E/branch.stderr.log"
record branch "$?"
git status --porcelain=v1 > "$E/initial-porcelain.log" 2> "$E/initial-porcelain.stderr.log"
record initial-porcelain "$?"
{
  sw_vers
  uname -a
  bun --version
  node --version
  az version --output json
} > "$E/environment-metadata.stdout.log" 2> "$E/environment-metadata.stderr.log"
record environment-metadata "$?"
pg_config --version > "$E/postgres-version.stdout.log" 2> "$E/postgres-version.stderr.log"
record postgres-version "$?"
if ! grep -Eq 'PostgreSQL 16([. ]|$)' "$E/postgres-version.stdout.log"; then
  record postgres-major-16 1
  print -r -- 'PostgreSQL 16 is required.' > "$E/first-failure.txt"
  exit 1
fi
record postgres-major-16 0
if lsof -nP -iTCP:$PORT -sTCP:LISTEN > "$E/port-free.stdout.log" 2> "$E/port-free.stderr.log"; then
  record port-free 1
  print -r -- "Port $PORT occupied; refusing to touch listener." > "$E/first-failure.txt"
  exit 1
fi
record port-free 0
if test -e "$PGDATA"; then
  record fresh-pgdata 1
  print -r -- 'Existing PGDATA; refusing destructive reuse.' > "$E/first-failure.txt"
  exit 1
fi
record fresh-pgdata 0

OWNER_PASSWORD="$(openssl rand -hex 24)"
RUNTIME_PASSWORD="$(openssl rand -hex 24)"
AUTH_SECRET_VALUE="$(openssl rand -base64 48 | tr -d '\n')"
PLATFORM_KEY_VALUE="$(openssl rand -base64 32 | tr -d '\n')"
CAMERA_KEY_VALUE="$(openssl rand -base64 32 | tr -d '\n')"
SEED_PASSWORD_VALUE="$(openssl rand -base64 24 | tr -d '\n')"
ADMIN_PASSWORD_VALUE="$(openssl rand -base64 24 | tr -d '\n')"
OPERATOR_PASSWORD_VALUE="$(openssl rand -base64 24 | tr -d '\n')"
OWNER="postgresql://gate_owner:${OWNER_PASSWORD}@127.0.0.1:${PORT}/${DB}"
RUNTIME="postgresql://gate_runtime:${RUNTIME_PASSWORD}@127.0.0.1:${PORT}/${DB}"
{
  print -r -- "OWNER_PASSWORD=$OWNER_PASSWORD"
  print -r -- "RUNTIME_PASSWORD=$RUNTIME_PASSWORD"
  print -r -- "AUTH_SECRET_VALUE=$AUTH_SECRET_VALUE"
  print -r -- "PLATFORM_KEY_VALUE=$PLATFORM_KEY_VALUE"
  print -r -- "CAMERA_KEY_VALUE=$CAMERA_KEY_VALUE"
  print -r -- "SEED_PASSWORD_VALUE=$SEED_PASSWORD_VALUE"
  print -r -- "ADMIN_PASSWORD_VALUE=$ADMIN_PASSWORD_VALUE"
  print -r -- "OPERATOR_PASSWORD_VALUE=$OPERATOR_PASSWORD_VALUE"
} > "$SECRETS_FILE"

if ! run_step initdb initdb -D "$PGDATA" -U postgres -A trust --no-locale -E UTF8; then
  { print -r -- 'initdb failed'; sed -n '1,80p' "$E/initdb.stderr.log"; } > "$E/first-failure.txt"
  exit 1
fi
run_step pg-start pg_ctl -D "$PGDATA" -l "$E/postgres.log" -o "-p $PORT -k $PGSOCKET -c listen_addresses=127.0.0.1" start || exit 1
command_record 'database-bootstrap: psql postgres (passwords omitted) creating gate_owner, exact unprivileged gate_runtime, and fresh database'
{
  print -r -- "CREATE ROLE gate_owner LOGIN PASSWORD '$OWNER_PASSWORD' NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE INHERIT;"
  print -r -- "CREATE ROLE gate_runtime LOGIN PASSWORD '$RUNTIME_PASSWORD' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;"
  print -r -- "CREATE DATABASE $DB OWNER gate_owner;"
  print -r -- "REVOKE ALL ON DATABASE $DB FROM PUBLIC;"
  print -r -- "GRANT CONNECT, TEMPORARY ON DATABASE $DB TO gate_runtime;"
} > "$BOOTSTRAP_SQL"
psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$BOOTSTRAP_SQL" \
  > "$E/database-bootstrap.stdout.log" 2> "$E/database-bootstrap.stderr.log"
BOOTSTRAP_CODE=$?
record database-bootstrap "$BOOTSTRAP_CODE"
if (( BOOTSTRAP_CODE != 0 )); then
  sed -n '1,80p' "$E/database-bootstrap.stderr.log" > "$E/first-failure.txt"
  exit 1
fi
run_step role-proof psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -At -v ON_ERROR_STOP=1 \
  -c "select rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,rolcanlogin from pg_roles where rolname in ('gate_owner','gate_runtime') order by rolname;" \
  -c "select datname,pg_get_userbyid(datdba) from pg_database where datname='$DB';" || exit 1

rg -o --no-filename '[A-Z][A-Z0-9_]*DATABASE_URL' src tests scripts prisma --glob '*.{ts,tsx,js,mjs,cjs}' | sort -u > "$E/database-url-env-discovered.txt"
record database-url-discovery "$?"
{
  print -r -- 'DATABASE_URL=runtime'
  print -r -- 'TEST_DATABASE_URL=runtime'
  print -r -- 'RESTAURANT_E2E_DATABASE_URL=runtime'
  while IFS= read -r name; do
    case "$name" in
      *OWNER_DATABASE_URL|OWNER_DATABASE_URL|EXTENSION_ADMIN_DATABASE_URL|PLAYWRIGHT_DATABASE_ADMIN_URL) kind=owner ;;
      *) kind=runtime ;;
    esac
    print -r -- "$name=$kind"
  done < "$E/database-url-env-discovered.txt"
} | sort -u > "$E/database-url-env-names.txt"

export DATABASE_URL="$RUNTIME"
export TEST_DATABASE_URL="$RUNTIME"
export RESTAURANT_E2E_DATABASE_URL="$RUNTIME"
export AGENCY_E2E_DATABASE_URL="$RUNTIME"
export APP_DATABASE_URL="$RUNTIME"
export CAMERA_TEST_DATABASE_URL="$RUNTIME"
export INVENTORY_DATABASE_URL="$RUNTIME"
export M8_TEST_RUNTIME_DATABASE_URL="$RUNTIME"
export MEETING_BACKFILL_DATABASE_URL="$RUNTIME"
export MENU_IMPORT_TEST_DATABASE_URL="$RUNTIME"
export RESTAURANT_ACTOR_RUNTIME_DATABASE_URL="$RUNTIME"
export RUNTIME_DATABASE_URL="$RUNTIME"
export WHA288_TEST_DATABASE_URL="$RUNTIME"
export WHA434_TEST_RUNTIME_DATABASE_URL="$RUNTIME"
export WHA910_TEST_RUNTIME_DATABASE_URL="$RUNTIME"
export DELIVERY_TEST_OWNER_DATABASE_URL="$OWNER"
export EXTENSION_ADMIN_DATABASE_URL="$OWNER"
export M8_TEST_OWNER_DATABASE_URL="$OWNER"
export OWNER_DATABASE_URL="$OWNER"
export PHARMACY_TEST_OWNER_DATABASE_URL="$OWNER"
export RESTAURANT_ACTOR_OWNER_DATABASE_URL="$OWNER"
export WHA1168_TEST_OWNER_DATABASE_URL="$OWNER"
export WHA1198_TEST_OWNER_DATABASE_URL="$OWNER"
export WHA1198_TEST_RUNTIME_DATABASE_URL="$RUNTIME"
export WHA434_TEST_OWNER_DATABASE_URL="$OWNER"
export WHA566_OWNER_DATABASE_URL="$OWNER"
export WHA874_TEST_OWNER_DATABASE_URL="$OWNER"
export WHA910_TEST_OWNER_DATABASE_URL="$OWNER"
export RESTAURANT_E2E_RESTORATION_DB=1
export RESTAURANT_ACTOR_ADMIN_EMAIL='admin@restaurant-e2e.test'
export RESTAURANT_ACTOR_ADMIN_PASSWORD="$ADMIN_PASSWORD_VALUE"
export RESTAURANT_ACTOR_OPERATOR_EMAIL='operator@restaurant-e2e.test'
export RESTAURANT_ACTOR_OPERATOR_PASSWORD="$OPERATOR_PASSWORD_VALUE"
export AUTH_SECRET="$AUTH_SECRET_VALUE"
export AUTH_TRUST_HOST=true
export AUTH_URL='http://localhost:3000'
export NEXT_PUBLIC_APP_URL='http://localhost:3000'
export PLATFORM_BASE_DOMAIN='localhost'
export PLATFORM_ENCRYPTION_KEY="$PLATFORM_KEY_VALUE"
export CAMERA_CREDENTIAL_KEY="$CAMERA_KEY_VALUE"
export DEFAULT_ORGANIZATION_ID='org_devfathom'
export SEED_PASSWORD="$SEED_PASSWORD_VALUE"
unset PLAYWRIGHT_BASE_URL
{
  print -r -- 'All database URL values omitted; classifications are in database-url-env-names.txt.'
  print -r -- 'RESTAURANT_E2E_RESTORATION_DB=1'
  print -r -- 'RESTAURANT_ACTOR_ADMIN_EMAIL=admin@restaurant-e2e.test'
  print -r -- 'RESTAURANT_ACTOR_ADMIN_PASSWORD=[REDACTED]'
  print -r -- 'RESTAURANT_ACTOR_OPERATOR_EMAIL=operator@restaurant-e2e.test'
  print -r -- 'RESTAURANT_ACTOR_OPERATOR_PASSWORD=[REDACTED]'
  print -r -- 'AUTH_SECRET=[REDACTED]'
  print -r -- 'AUTH_TRUST_HOST=true'
  print -r -- 'PLATFORM_ENCRYPTION_KEY=[REDACTED]'
  print -r -- 'PLAYWRIGHT_BASE_URL=[UNSET]'
} > "$E/environment-redacted.txt"

DATABASE_URL="$OWNER" EXTENSION_ADMIN_DATABASE_URL="$OWNER" run_step prepare-extensions bun prisma/prepare-extensions.ts
PREP_CODE=$?
if (( PREP_CODE != 0 )); then
  { print -r -- 'prepare-extensions failed'; sed -n '1,100p' "$E/prepare-extensions.stderr.log"; } > "$E/first-failure.txt"
  exit 1
fi
DATABASE_URL="$OWNER" run_step migrate-deploy bunx prisma migrate deploy
MIGRATE_CODE=$?
if (( MIGRATE_CODE != 0 )); then
  { print -r -- 'prisma migrate deploy failed'; rg -n -m 1 'Error|failed|migration' "$E/migrate-deploy.stdout.log" "$E/migrate-deploy.stderr.log" || true; } > "$E/first-failure.txt"
  exit 1
fi
run_step prisma-generate bunx prisma generate || exit 1
run_step migration-count psql "$OWNER" -At -v ON_ERROR_STOP=1 -c 'select count(*) from _prisma_migrations where finished_at is not null;'
MIGRATION_CODE=$?
MIGRATIONS="$(tr -d '[:space:]' < "$E/migration-count.stdout.log")"
if (( MIGRATION_CODE != 0 )) || [[ -z "$MIGRATIONS" ]]; then
  print -r -- "Migration count unavailable after successful deploy." > "$E/first-failure.txt"
  exit 1
fi
run_step runtime-grants psql "$OWNER" -v ON_ERROR_STOP=1 \
  -c 'GRANT USAGE ON SCHEMA public TO gate_runtime;' \
  -c 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gate_runtime;' \
  -c 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gate_runtime;' \
  -c 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gate_runtime;' \
  -c 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO gate_runtime;' || exit 1
DATABASE_URL="$OWNER" run_step seed bunx prisma db seed
SEED_CODE=$?
if (( SEED_CODE != 0 )); then
  { print -r -- 'seed failed'; sed -n '1,100p' "$E/seed.stderr.log"; } > "$E/first-failure.txt"
  exit 1
fi

export DATABASE_URL="$RUNTIME"
run_step vitest bunx vitest run --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile="$E/vitest.json"
VITEST_CODE=$?
node - "$E/vitest.json" "$E/vitest-counts.txt" "$E/vitest-first-failures.txt" <<'NODE'
const fs = require('fs');
const [input, countsOut, failuresOut] = process.argv.slice(2);
const x = JSON.parse(fs.readFileSync(input, 'utf8'));
const keys = ['numTotalTestSuites','numPassedTestSuites','numFailedTestSuites','numPendingTestSuites','numTotalTests','numPassedTests','numFailedTests','numPendingTests'];
fs.writeFileSync(countsOut, keys.map(k => `${k}=${x[k]}`).join('\n') + '\n');
const requiredZero = ['numFailedTestSuites','numPendingTestSuites','numFailedTests','numPendingTests'];
if (!requiredZero.every(k => Object.hasOwn(x, k) && typeof x[k] === 'number' && x[k] === 0)) process.exitCode = 2;
const failures = [];
for (const suite of x.testResults || []) for (const a of suite.assertionResults || []) {
  if (a.status === 'failed') failures.push(`${[...(a.ancestorTitles || []), a.title].join(' > ')}\n${(a.failureMessages || []).join('\n')}`);
}
fs.writeFileSync(failuresOut, failures.slice(0, 5).join('\n\n---\n\n'));
NODE
VITEST_PARSE_CODE=$?
record vitest-counts "$VITEST_PARSE_CODE"
if (( VITEST_CODE != 0 || VITEST_PARSE_CODE != 0 )); then
  { print -r -- 'Vitest failed or reported failed/pending tests.'; cat "$E/vitest-counts.txt" 2>/dev/null; sed -n '1,160p' "$E/vitest-first-failures.txt" 2>/dev/null; } > "$E/first-failure.txt"
  exit 1
fi

DATABASE_URL="$OWNER" run_step test-rls bun run test:rls || exit 1
run_step next-typegen bunx next typegen || exit 1
run_step lint bun run lint || exit 1
git diff --name-only -z b59f39a8..HEAD -- '*.ts' '*.tsx' '*.css' '*.md' '*.json' '*.mjs' > "$E/prettier-files.zlist"
record prettier-file-list "$?"
tr '\0' '\n' < "$E/prettier-files.zlist" > "$E/prettier-files.txt"
if test -s "$E/prettier-files.zlist"; then
  run_step prettier-check zsh -c "xargs -0 bunx prettier --check < '$E/prettier-files.zlist'" || exit 1
else
  : > "$E/prettier-check.stdout.log"
  : > "$E/prettier-check.stderr.log"
  record prettier-check 0
fi
export NODE_OPTIONS=--max-old-space-size=8192
run_step typecheck bun run typecheck || exit 1
run_step build bun run build || exit 1

export DEVFATHOM_REGISTRY_NAME='gatecompileonly'
export DEVFATHOM_STAGING_IMAGE='gatecompileonly.azurecr.io/devfathom:134f17fa'
export DEVFATHOM_PRODUCTION_IMAGE='gatecompileonly.azurecr.io/devfathom:134f17fa'
export DEVFATHOM_STAGING_POSTGRES_PASSWORD='gate-compile-only-postgres-password'
export DEVFATHOM_STAGING_AUTH_SECRET='gate-compile-only-auth-secret-000000'
export DEVFATHOM_STAGING_PLATFORM_ENCRYPTION_KEY='gate-compile-only-platform-key-00000'
export DEVFATHOM_STAGING_CAMERA_CREDENTIAL_KEY='gate-compile-only-camera-key-000000'
export DEVFATHOM_STAGING_CRON_SECRET='gate-compile-only-cron-secret-000000'
export DEVFATHOM_STAGING_SEED_PASSWORD='gate-compile-only-seed-password'
export DEVFATHOM_STAGING_ADMIN_PASSWORD='gate-compile-only-admin-password'
export DEVFATHOM_STAGING_PLATFORM_ADMIN_PASSWORD='gate-compile-only-platform-admin'
export DEVFATHOM_PRODUCTION_POSTGRES_PASSWORD='gate-compile-only-postgres-password'
export DEVFATHOM_PRODUCTION_AUTH_SECRET='gate-compile-only-auth-secret-000000'
export DEVFATHOM_PRODUCTION_PLATFORM_ENCRYPTION_KEY='gate-compile-only-platform-key-00000'
export DEVFATHOM_PRODUCTION_CAMERA_CREDENTIAL_KEY='gate-compile-only-camera-key-000000'
export DEVFATHOM_PRODUCTION_CRON_SECRET='gate-compile-only-cron-secret-000000'
export DEVFATHOM_PRODUCTION_ADMIN_PASSWORD='gate-compile-only-admin-password'
export DEVFATHOM_PRODUCTION_PLATFORM_ADMIN_PASSWORD='gate-compile-only-platform-admin'
export DEVFATHOM_MEETINGS_SSH_PUBLIC_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGF0ZWNvbXBpbGVvbmx5a2V5MDAwMDAwMDAw gate@local'
run_step bicep-environment az bicep build --file infra/environment.bicep --outfile "$E/environment.json" || exit 1
for param in infra/*.bicepparam; do
  name=${param:t:r}
  run_step "bicep-$name-params" az bicep build-params --file "$param" --outfile "$E/$name.parameters.json" || exit 1
done

run_step docker-info docker info
DOCKER_CODE=$?
if (( DOCKER_CODE == 0 )); then
  run_step image-gate docker build --progress=plain . || exit 1
else
  print -r -- 'NOT RUN: docker info failed; no retry performed.' > "$E/image-gate-NOT-RUN.txt"
  record image-gate NOT-RUN
fi

exit 0
