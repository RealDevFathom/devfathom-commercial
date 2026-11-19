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

# Prints the host (IPv6 without brackets), port and database of a postgres URL, one per line,
# without credentials. Accepts only the postgres: and postgresql: schemes (node-postgres reads
# socket: as a unix socket path). Refuses a host, hostaddr, port, dbname, db or database query
# parameter, in any letter case, percent-encoded or repeated: node-postgres and libpq let one
# override the address's host, port or database, so the checks below would pass for one
# server while the suites connect to another.
target() {
  bun -e '
let u;
try {
  u = new URL(process.argv[1]);
} catch {
  console.error(`${process.argv[2]} is not a valid database URL.`);
  process.exit(2);
}
if (!["postgres:", "postgresql:"].includes(u.protocol)) {
  console.error(`${process.argv[2]} must use the postgres: or postgresql: scheme.`);
  process.exit(2);
}
const overriding = [...new Set([...u.searchParams.keys()].map((key) => key.toLowerCase()))]
  .filter((key) => ["host", "hostaddr", "port", "dbname", "db", "database"].includes(key));
if (overriding.length > 0) {
  console.error(`${process.argv[2]} carries a ${overriding.join(", ")} parameter; put the host, port and database in the address itself.`);
  process.exit(2);
}
const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
console.log([host, u.port || "5432", decodeURIComponent(u.pathname.slice(1))].join("\n"));
' "$1" "$2"
}
runtime_target="$(target "$PHARMACY_DB_TEST_RUNTIME_URL" PHARMACY_DB_TEST_RUNTIME_URL)" || exit 2
for name in "${urls[@]}"; do
  other_target="$(target "${!name}" "$name")" || exit 2
  if [ "$other_target" != "$runtime_target" ]; then
    echo "$name must point at the same database as PHARMACY_DB_TEST_RUNTIME_URL." >&2
    exit 2
  fi
done
{ read -r host; read -r port; read -r database; } <<<"$runtime_target"
case "$host" in
  localhost | 127.0.0.1 | ::1) ;;
  *)
    echo "Refusing a non-local database host: $host" >&2
    exit 2
    ;;
esac
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
echo "Running $((${#files[@]} + ${#admin_files[@]})) pharmacy database suites against $host port $port, database $database" >&2

status=0
bunx vitest run --no-file-parallelism "$@" "${files[@]}" || status=$?
DATABASE_URL="$owner" bunx vitest run --no-file-parallelism "$@" "${admin_files[@]}" || status=$?
exit "$status"
