# Migration rules (QA-12, DEV-813)

- Never rename or re-stamp a migration that already exists: it may already be applied.
- A new migration's timestamp must be later than every existing migration and unique.
- Wrap the file in `BEGIN; ... COMMIT;` and make it safe to re-run (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`).
- Enable (and force) row-level security on any new tenant table.

`tests/migration-timestamp-order.test.ts` enforces order, uniqueness and wrapping for every
migration not listed in `tests/fixtures/legacy-migration-names.txt` (the frozen pre-rule set).
Do not edit that fixture to admit a new migration.
