# Migration rules (QA-12, DEV-813)

- Never rename or re-stamp a migration that already exists: it may already be applied.
- A new migration's timestamp must be later than every existing migration and unique.
- Wrap the file in `BEGIN; ... COMMIT;` and make it safe to re-run (`IF NOT EXISTS`,
  `DROP POLICY IF EXISTS` before `CREATE POLICY`; guarded `DO` blocks for anything else).
- Enable (and force) row-level security on any new tenant table.

## How the test enforces it
`tests/migration-timestamp-order.test.ts`:
- `tests/fixtures/legacy-migration-names.txt` freezes the pre-rule migrations. Do not edit it.
- `tests/fixtures/new-migration-order.txt` is an append-only ledger: add your new migration's
  directory name at the END. Each entry must be strictly later than the newest legacy migration
  and every entry above it, so a later-merged migration stamped earlier fails. When two branches
  both append, the second must re-stamp its own new migration after merging.
- Wrapping in BEGIN/COMMIT is checked. Re-run safety is a static heuristic
  (IF NOT EXISTS on CREATE TABLE/INDEX/SEQUENCE and ADD COLUMN, DROP POLICY IF EXISTS
  before CREATE POLICY); it does not replace review of data-changing statements.
