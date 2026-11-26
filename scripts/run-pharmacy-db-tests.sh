#!/usr/bin/env bash
# Runs every tracked pharmacy *.db.test.ts file, one file at a time, against a
# migrated disposable PostgreSQL database plus two newly provisioned isolated databases.
# Setup and roles: docs/LOCAL_SETUP.md,
# "Running all pharmacy database suites". Local use only; not part of CI.
#
#   PHARMACY_DB_TEST_RUNTIME_URL    NOSUPERUSER NOBYPASSRLS NOCREATEROLE runtime (read/write grants)
#   PHARMACY_DB_TEST_OWNER_URL      NOSUPERUSER NOBYPASSRLS CREATEROLE role that owns the
#                                   database and ran the migrations
#   PHARMACY_DB_TEST_SUPERUSER_URL  superuser for isolated database creation and existing
#                                   suites' fixture setup/cleanup, never their runtime
#   PHARMACY_DB_TEST_COHORT_URL     SELECT-only role for repeat-purchasing.db.test.ts;
#                                   repeat-purchasing.fixture.sql must already be loaded
#
# All four must point at the same local database, whose name contains test, e2e, tmp or
# disposable as a separate word (for example devfathom_pharmacy_test). Extra arguments go
# to vitest, e.g. --reporter=verbose.
#
# The only intentionally gated pharmacy database cases are the DEV-293 upgrade
# cases in src/lib/pharmacy/goods-receipt.db.test.ts. They require both pre- and
# post-migration states and a handoff fixture from scripts/qa/controlled-supplier-return-upgrade.sh.
#
# Other PostgreSQL checks stay in their existing lanes, outside this *.db.test.ts runner:
# - tests/pharmacy-medicine-rls.test.ts: the standalone RLS lane delegates the exact
#   pg_trgm search function to its throwaway test role (see docs/LOCAL_SETUP.md).
# - tests/pharmacy-price-intelligence.integration.test.ts: the reserved lane needs a
#   seeded database, the wha1606_runtime role and its reserved port range.
# - src/lib/pharmacy/accounts/fiscal-exceptions.reader.test.ts: combined unit and
#   opt-in PostgreSQL coverage, run as a file with TEST_DATABASE_URL.
# - src/app/(app)/pharmacy/accounts/journal-evidence-export/page.db.test.tsx:
#   a TSX route integration suite, run as a file with TEST_DATABASE_URL.
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

# Do not clone the shared database: these suites need fresh fixtures, without any
# rows from other suites. Never reuse or reset an existing database.
isolated_suffix="$(openssl rand -hex 8)"
receipt_database="wha1364_receipt_test_${isolated_suffix}"
returns_database="pharmacy_returns_disposable_${isolated_suffix}"
receipt_file=src/lib/pharmacy/receipt-identity.db.test.ts
returns_file=src/lib/pharmacy/settlement.returns.db.test.ts

database_url() {
  bun -e 'const url = new URL(process.argv[1]); url.pathname = "/" + process.argv[2]; console.log(url.href);' "$1" "$2"
}

database_role() {
  bun -e '
import pg from "pg";
const [url, kind] = process.argv.slice(1);
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const { rows: [role] } = await client.query(
    "SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user"
  );
  if (!role || role.rolsuper || role.rolbypassrls || role.rolcreatedb ||
      role.rolcreaterole !== (kind === "owner")) {
    throw new Error(`Use the restricted ${kind} role documented in docs/LOCAL_SETUP.md.`);
  }
  console.log(role.rolname);
} finally {
  await client.end();
}
' "$1" "$2"
}

owner_role="$(database_role "$owner" owner)"
runtime_role="$(database_role "$runtime" runtime)"

isolated_database_sql() {
  bun -e '
import pg from "pg";
const [url, phase, name, ownerRole, runtimeRole] = process.argv.slice(1);
const database = pg.escapeIdentifier(name);
const owner = pg.escapeIdentifier(ownerRole);
const runtime = pg.escapeIdentifier(runtimeRole);
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  if (phase === "create") {
    await client.query(`CREATE DATABASE ${database} OWNER ${owner} TEMPLATE template0`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO ${runtime}`);
  } else {
    await client.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`);
  }
} finally {
  await client.end();
}
' "$1" "$2" "$3" "$owner_role" "$runtime_role"
}

setup_isolated_database() {
  local name="$1" isolated_owner
  isolated_owner="$(database_url "$owner" "$name")"
  echo "Provisioning isolated pharmacy test database $name" >&2
  isolated_database_sql "$PHARMACY_DB_TEST_SUPERUSER_URL" create "$name"
  EXTENSION_ADMIN_DATABASE_URL="$isolated_owner" bun prisma/prepare-extensions.ts
  DATABASE_URL="$isolated_owner" MIGRATION_DATABASE_URL="$isolated_owner" bunx prisma migrate deploy
  isolated_database_sql "$isolated_owner" grant "$name"
}

setup_isolated_database "$receipt_database"
setup_isolated_database "$returns_database"
receipt_runtime="$(database_url "$runtime" "$receipt_database")"
returns_runtime="$(database_url "$runtime" "$returns_database")"

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
isolated_files=("$receipt_file" "$returns_file")
mapfile -t files < <(git ls-files '*.db.test.ts' | grep -i pharmacy | grep -vxF -f <(printf '%s\n' "${admin_files[@]}" "${isolated_files[@]}") | sort)

status=0
# Keep the same isolated databases for both passes to catch cross-run fixture leaks.
for pass in 1 2; do
  echo "Receipt identity pass $pass/2 on $receipt_database" >&2
  DATABASE_URL="$receipt_runtime" WHA1364_RECEIPT_TEST_DATABASE_URL="$receipt_runtime" \
    bunx vitest run --no-file-parallelism "$@" "$receipt_file" || status=$?
  echo "Settlement returns pass $pass/2 on $returns_database" >&2
  DATABASE_URL="$returns_runtime" PHARMACY_E2E=1 PHARMACY_E2E_DATABASE_URL="$returns_runtime" \
    bunx vitest run --no-file-parallelism "$@" "$returns_file" || status=$?
done
echo "Running $((${#files[@]} + ${#admin_files[@]})) pharmacy database suites against $host port $port, database $database" >&2
bunx vitest run --no-file-parallelism "$@" "${files[@]}" || status=$?
DATABASE_URL="$owner" bunx vitest run --no-file-parallelism "$@" "${admin_files[@]}" || status=$?
exit "$status"
