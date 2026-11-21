#!/usr/bin/env bash
# Run against a new, empty dev293_upgrade_* database on local PostgreSQL 16.
# Configure the restricted owner/runtime roles and default grants per LOCAL_SETUP.
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?restricted owner URL required}"
: "${TEST_DATABASE_URL:?restricted runtime URL required}"
export DATABASE_URL="$TEST_DATABASE_URL"
root=$(git rev-parse --show-toplevel)
cd "$root"
node --input-type=module <<'JS'
import pg from 'pg';
const urls = [process.env.MIGRATION_DATABASE_URL, process.env.TEST_DATABASE_URL].map(s => new URL(s));
const [owner, runtime] = urls;
if (urls.some(url => !['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) ||
    owner.host !== runtime.host || owner.pathname !== runtime.pathname || owner.username === runtime.username ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(owner.hostname) || !/^\/dev293_upgrade_[a-z0-9_]+$/.test(owner.pathname)) {
  throw new Error('Use separate restricted roles on the same disposable local dev293_upgrade_* database.');
}
for (const url of urls) {
  const db = new pg.Client({connectionString: url.toString()});
  await db.connect();
  try {
    const {rows: [r]} = await db.query(`SELECT rolsuper, rolbypassrls,
      current_setting('server_version_num')::int / 10000 AS version,
      EXISTS(SELECT FROM pg_tables WHERE schemaname='public') AS populated
      FROM pg_roles WHERE rolname=current_user`);
    if (r.rolsuper || r.rolbypassrls || r.version !== 16 || r.populated) throw new Error('Expected an empty, restricted PostgreSQL 16 database.');
  } finally { await db.end(); }
}
JS

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/develop"
# Freeze the real application and schema which dispatched stock without a register entry.
git archive 514ac9d29274250ab927c453d30fcedf2990bd7b | tar -x -C "$work/develop"
ln -s "$root/node_modules" "$work/develop/node_modules"
suite=src/lib/pharmacy/goods-receipt.db.test.ts
cp "$suite" "$work/develop/$suite"
export DEV293_UPGRADE_FIXTURE="$work/fixture.json"
(
  cd "$work/develop"
  EXTENSION_ADMIN_DATABASE_URL="$MIGRATION_DATABASE_URL" bun prisma/prepare-extensions.ts
  bunx prisma migrate deploy
  bunx prisma generate
  bunx vitest run "$suite" -t 'prepares the develop supplier dispatch fixture'
)
bunx prisma migrate deploy
bunx prisma generate
bunx vitest run "$suite" -t 'reconciles a witnessed late entry after a develop dispatch'
