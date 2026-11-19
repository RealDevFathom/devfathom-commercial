#!/usr/bin/env bash
# Runs every pharmacy *.db.test.ts file, one file at a time, against ONE migrated
# disposable PostgreSQL database. Setup and roles: docs/LOCAL_SETUP.md,
# "Running all pharmacy database suites". Local use only; not part of CI.
#
#   PHARMACY_DB_TEST_RUNTIME_URL    NOSUPERUSER NOBYPASSRLS NOCREATEROLE runtime (read/write grants)
#   PHARMACY_DB_TEST_OWNER_URL      NOSUPERUSER NOBYPASSRLS CREATEROLE role that owns the
#                                   database and ran the migrations
#   PHARMACY_DB_TEST_SUPERUSER_URL  superuser; only the SOP suites' cleanup uses it
#   PHARMACY_DB_TEST_COHORT_URL     SELECT-only role for repeat-purchasing.db.test.ts;
#                                   repeat-purchasing.fixture.sql must already be loaded
#
# All four must point at the same local database, whose name contains test, e2e, tmp or
# disposable as a separate word (for example devfathom_pharmacy_test). Extra arguments go
# to vitest, e.g. --reporter=verbose.
set -euo pipefail

cd "$(dirname "$0")/.."

urls=(PHARMACY_DB_TEST_RUNTIME_URL PHARMACY_DB_TEST_OWNER_URL PHARMACY_DB_TEST_SUPERUSER_URL
  PHARMACY_DB_TEST_COHORT_URL)
for name in "${urls[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required; see docs/LOCAL_SETUP.md (Running all pharmacy database suites)." >&2
    exit 2
  fi
done

target() { # prints host:port/database of a postgres URL, without credentials
  bun -e 'const u = new URL(process.argv[1]); console.log(`${u.hostname}:${u.port || 5432}/${decodeURIComponent(u.pathname.slice(1))}`)' "$1"
}
runtime_target="$(target "$PHARMACY_DB_TEST_RUNTIME_URL")"
for name in "${urls[@]}"; do
  if [ "$(target "${!name}")" != "$runtime_target" ]; then
    echo "$name must point at the same database as PHARMACY_DB_TEST_RUNTIME_URL." >&2
    exit 2
  fi
done
case "${runtime_target%%:*}" in
  localhost | 127.0.0.1 | ::1 | '[::1]') ;;
  *)
    echo "Refusing a non-local database host: ${runtime_target%%:*}" >&2
    exit 2
    ;;
esac
database="${runtime_target#*/}"
if ! [[ "$database" =~ (^|[_-])(test|e2e|tmp|disposable)([_-]|$) ]]; then
  echo "Database '$database' is not marked disposable (test, e2e, tmp or disposable)." >&2
  exit 2
fi

runtime="$PHARMACY_DB_TEST_RUNTIME_URL"
owner="$PHARMACY_DB_TEST_OWNER_URL"

# Restricted runtime connections.
export TEST_DATABASE_URL="$runtime" DATABASE_URL="$runtime"
export M8_TEST_RUNTIME_DATABASE_URL="$runtime" PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL="$runtime"
export PHARMACY_ORDERING_TEST_RUNTIME_DATABASE_URL="$runtime" WHA1316_RUNTIME_DATABASE_URL="$runtime"
export WHA1198_TEST_RUNTIME_DATABASE_URL="$runtime" WHA1325_RUNTIME_DATABASE_URL="$runtime"
export WHA1339_TEST_RUNTIME_DATABASE_URL="$runtime" WHA1372_TEST_DATABASE_URL="$runtime"
export BALANCE_SHEET_TEST_DATABASE_URL="$runtime"
# Database owner: seeds parent rows, creates throwaway roles and schemas, cleans up.
export PHARMACY_TEST_OWNER_DATABASE_URL="$owner" OWNER_DATABASE_URL="$owner"
export M8_TEST_OWNER_DATABASE_URL="$owner" FIX469_OWNER_DATABASE_URL="$owner"
export WHA1316_OWNER_DATABASE_URL="$owner" PHARMACY_SOP_TEST_OWNER_DATABASE_URL="$owner"
export PHARMACY_ORDERING_TEST_OWNER_DATABASE_URL="$owner" CONTROLLED_TEST_DATABASE_URL="$owner"
export PHARMACY_SOP_TEST_SUPERUSER_DATABASE_URL="$PHARMACY_DB_TEST_SUPERUSER_URL"
# Repeat purchasing reads through its own SELECT-only role.
export PHARMACY_REPEAT_PURCHASING_TEST_DATABASE_URL="$PHARMACY_DB_TEST_COHORT_URL"
# Local placeholders only; never a real key.
export PLATFORM_ENCRYPTION_KEY="${PLATFORM_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
export AUTH_SECRET="${AUTH_SECRET:-local-placeholder-not-a-real-secret-0123456789}"

# These two read DATABASE_URL as an administrator that creates their throwaway role.
admin_files=(
  src/lib/pharmacy/whatsapp/khata-reminder-rollout.db.test.ts
  src/lib/pharmacy/whatsapp/message-log.db.test.ts
)
mapfile -t files < <(git ls-files '*.db.test.ts' | grep -i pharmacy | grep -vxF -f <(printf '%s\n' "${admin_files[@]}") | sort)
echo "Running $((${#files[@]} + ${#admin_files[@]})) pharmacy database suites against $runtime_target" >&2

status=0
bunx vitest run --no-file-parallelism "$@" "${files[@]}" || status=$?
DATABASE_URL="$owner" bunx vitest run --no-file-parallelism "$@" "${admin_files[@]}" || status=$?
exit "$status"
