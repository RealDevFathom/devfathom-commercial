# WHA-1354 isolated database review environment

Tested source: 411306de8d88b8eea574caa93750a972afa028d7.
Private new database: wha1354_disposable_b032106891.
Shared disposable cluster: PostgreSQL16.15, 127.0.0.1:52027.
Existing WHA1350 database was not used. Do not stop this shared cluster.

connections.env contains restricted owner/runtime URLs; keep0600, never print/commit.
identity.json and evidence.json contain verified cluster/role/RLS/migration evidence.
receipt-db-tests.json: 4 passed, 0 failed, 0 skipped; 2 tenants, 3 Restaurant branches.
All105 current migrations match local checksums, 0 unsuccessful.
Owner/runtime both NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
runtime owns no application tables. Both branch tables have ENABLE/FORCE RLS.

From the assigned checkout, source this directory's connections.env privately.
Reproduction commands:

```sh
node node_modules/vitest/vitest.mjs run src/lib/receipts/restaurant-settings.db.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile="$WHA1354_ENV_DIR/receipt-db-tests.json"
node "$WHA1354_ENV_DIR/evidence.cjs"
```

Do not rerun provision.cjs: it would create another database.
Do not change another worker's environment or generated client.
No API/Pharmacy adapter, browser, build or hardware acceptance claimed.

Cleanup owner: WHA1354, after independent review. Using the original authorized
cluster admin through its private environment, first verify data_directory still
matches identity.json and connect to postgres maintenance database only. Drop
ONLY wha1354_disposable_b032106891, then wha1354_runtime_b032106891 and
wha1354_owner_b032106891 after confirming no remaining dependencies. Do not force
terminate other users or touch any other database/role. Finally remove ONLY this
.wha1354-verification-NSdov4 directory. Preserve until review is complete.
