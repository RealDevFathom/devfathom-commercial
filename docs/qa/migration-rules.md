# Migration rules (QA-12, DEV-813)

- Never rename or re-stamp a migration that already exists: it may already be applied.
- A new migration's timestamp must be later than every existing migration and unique.
- Wrap the file in `BEGIN; ... COMMIT;` and make it safe to re-run (`IF NOT EXISTS`,
  `DROP POLICY IF EXISTS` before `CREATE POLICY`; guarded `DO` blocks for anything else).
- Enable (and force) row-level security on any new tenant table.

## Adding a migration
1. Create `prisma/migrations/<14-digit timestamp>_<name>/migration.sql`, stamped later than the
   newest migration on `origin/develop`.
2. Append the directory name at the END of `tests/fixtures/new-migration-order.txt`.
   Never sort, never insert in the middle, never edit `tests/fixtures/legacy-migration-names.txt`.
3. If another migration landed first, re-stamp your new migration after it (it is not yet applied
   anywhere) and keep it last in the ledger.

## How the test enforces it
`tests/migration-timestamp-order.test.ts`:
- `legacy-migration-names.txt` freezes the pre-rule migrations.
- `new-migration-order.txt` is an append-only ledger. Each entry must be strictly later than the
  newest legacy migration and every entry above it. The ledger on `origin/develop` (read with
  `git show`; an empty ledger when it does not exist there or git is unavailable) must be an
  unchanged prefix of the current ledger, so a middle insertion, reorder or removal fails.
- Wrapping in BEGIN/COMMIT is checked. Re-run safety is a static heuristic
  (IF NOT EXISTS on CREATE TABLE/INDEX/SEQUENCE and ADD COLUMN, DROP POLICY IF EXISTS
  before CREATE POLICY); it does not replace review of data-changing statements.

## One-time freeze when this rule lands
Other pull requests keep landing migrations, so the frozen list goes stale until this change
lands. At the moment it lands, run once on the merged tree:

    bun scripts/qa/freeze-migration-list.ts

It regenerates the legacy list from `prisma/migrations` and empties the ledger. Run it exactly
once, at landing, and never again afterwards. It refuses to run if the ledger already has
entries.
