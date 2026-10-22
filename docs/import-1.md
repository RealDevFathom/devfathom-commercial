# Pharmacy import 1/5 — core

## Design

This change deliberately extends `PharmacyMigrationSource`, `PharmacyMigrationBatch`,
`PharmacyMigrationRow`, and `PharmacyMigrationException`; it does not introduce a
second import stack. A source remains immutable evidence identified by SHA-256. A
batch is the audited attempt by one user, and rows remain staging.

### Organization and branch scope

Every source, batch, row, exception and manifest row belongs to one organization and
one branch. The PH-MIG tables are forced-RLS on both: `pharmacy_import_branch_allowed`
compares a row with `app.current_organization_id` (set by the tenant client) and
`app.current_branch_id`. Only `enterImportBranch` sets the branch binding, after the
capability and branch checks below, and only for its own transaction, so a statement
without it sees and writes nothing. Branch-qualified foreign keys tie a batch to its
source, a row to its batch, an exception to its batch and row, and a manifest row to
its batch, all in the same branch.

### Lifecycle

The batch state machine is `UPLOADED → PARSING → PREVIEW → COMMITTING → COMMITTED
→ ROLLED_BACK`, with `FAILED` exits, a retry from `FAILED` to `PARSING`, and a
re-profile from `PREVIEW` to `PARSING`. A trigger refuses every other edge. Preview
only profiles into staging and exception buckets. It never writes a live entity.
The audit timestamps are tied to the state they evidence: `PREVIEW` and later need
`profiledAt`, `COMMITTED` and `ROLLED_BACK` need `committedAt` (and nothing else may
have it), `ROLLED_BACK` needs `rolledBackAt`, and a new `FAILED` batch needs a
`failureReason`.

### Authorization

Every callable mutation is a tRPC `capabilityProcedure('pharmacy:data-import')`:
`importCore.upload`, `importCore.signOffException`, `importCore.commit` and
`importCore.rollback` (plus the `importCore.batches` read). That path is central
`can()` with the common audit middleware and the module licence check.

The services those procedures call (`importSourceFile`, `recordSource`,
`persistProfile`, `signOffException`, `openExceptionCounts`, `commitImportBatch`,
`rollbackImportBatch`) authorize themselves too. Each opens its transaction through
`enterImportBranch`, which asks central `can()` for `pharmacy:data-import` (persisted
roles and user overrides), checks that the branch is active in the organization and
that the actor is assigned to it (`ADMIN` reaches every active branch), and only then
binds the branch. The raw inserts and lock helpers are private to their modules, so
no exported write skips the check.

The capability is granted to pharmacy owner (through `pharmacy:*`) and manager only.
An explicit user `DENY`, exact or wildcard, beats a role or owner `ALLOW`. A role
`DENY` over a user `ALLOW` is decided in `src/lib/abac/index.ts`, which this change
does not touch. That case is fixed centrally on `fix/abac-deny-precedence`
(6b120a50), and its test is marked `it.fails` until that lands.

### Commit manifest and idempotency

`PharmacyMigrationBatchEntity` is the commit manifest and the rollback allow-list.

- `CREATED` names a supplier the import created.
- `STOCK_MOVEMENT` names the `OPENING` ledger posting it made.
- `STOCK_REVERSAL` names the exact compensating posting a rollback made.

`applicationKey` is the retry barrier. It is SHA-256 over the JSON array
`["pharmacy-import/v1", organization, branch, source content hash, source row key,
entity type, operation]`. JSON encoding makes it unambiguous for any source key, and
no generated id is part of it. A partial unique index makes it unique among the
branch's unreleased manifest rows.

Each live write is preceded, in the same transaction, by the insert of its manifest
row (`ON CONFLICT ... DO NOTHING`). A concurrent commit of the same source content
waits on that index entry and then skips the row. Re-uploading the same bytes in a
branch reuses the source, so a second preview batch of the same file cannot apply a
row twice either. A rollback releases its rows (`releasedAt`), which frees the same
file to be imported again.

The database holds the manifest to its claims, whatever path writes it:

- A shape check admits exactly the operations above.
- `stockMovementId` is a foreign key to the ledger. It is deferred, so the manifest
  row can be the first write.
- A deferred constraint trigger checks the ledger when the transaction commits.
  `STOCK_MOVEMENT` must name an `OPENING` posting of the same branch with the same
  signed quantity. `STOCK_REVERSAL` must name the posting that reverses its
  original's posting, with the exact opposite quantity.
- `reversesEntryId` and `reversedById` are composite foreign keys on (organization,
  branch, batch, id), so a link can never leave its batch or branch. Each link is
  one-to-one (partial unique indexes).
- Identity is immutable, including the branch. A rollback may only set `reversedById`
  and `releasedAt`, once each. Manifest rows are never deleted.

### Live-model adapters

Two adapters exist.

- `SUPPLIER` creates a supplier. A supplier that already exists by name is matched
  and not manifested, so a rollback can never delete it. Two imports naming the same
  new supplier serialize on a transaction advisory lock, and the second matches the
  first's supplier.
- `OPENING_STOCK` creates an inventory lot and posts one `OPENING` movement into an
  active store, rack, fridge or safe location of the branch. The pack must belong to
  the batch's medicine. Controlled medicines, recalled or quarantined batches, and
  cold-chain medicines into a location that is not cold-chain are refused.

### Commit and rollback

Commit lock order: the batch row (`FOR UPDATE`); then the supplier names the request
may create, as advisory locks in name order; then one unique-index entry per manifest
row, in source-row order; then the new live rows. Commit refuses while a blocking
exception is open.

Rollback lock order: the batch row; then every manifest row of the batch, by id;
then the created suppliers, by id; then the original movements, by id; then their
stock balances, by (lot, location, disposition). With those locks held it rechecks
everything it relies on. Any blocker refuses the whole rollback with one sentence per
entry (`ROLLBACK_BLOCKED`): a created supplier gained a reference, or imported stock
was used.

Otherwise, in the same transaction, it writes for each posting an `ADJUSTMENT` with
`reversesMovementId` and the exact negated units, packs and loose units. It writes
the `STOCK_REVERSAL` manifest row, links both ways, deletes the created suppliers,
releases their rows, and moves the batch to `ROLLED_BACK`. A second worker waits on
the batch row and then finds it already rolled back. The lot stays, as ledger
history.

### Parsing and matching

CSV and XLSX are parsed on the server. Limits are 20 MiB, 50,000 data rows, and
200 columns. XLSX formula cells are rejected rather than evaluated.

Before a workbook reader sees an XLSX archive, it is checked:

- Macros, path traversal, encrypted entries, ZIP64 and multi-disk archives, duplicate
  entry names and compression other than stored/deflate are refused.
- Entry count, size and compression-ratio limits apply.
- Every entry is inflated, bounded by its declared size, and must match the size and
  CRC-32 its directory declares. A directory cannot understate a bomb past the limits,
  and a truncated or corrupt archive is refused.

CSV export cells beginning with spreadsheet metacharacters are apostrophe-prefixed.
Files at or above 2 MiB are classified for the existing durable scheduler rather
than being parsed in a request (`ASYNC_REQUIRED`).

Customer matching uses Pakistani E.164 mobile normalization. Product matching is
barcode-first, then normalized name + generic + strength with whitespace, case,
and common unit aliases normalized. Money continues to use integer minor units.

## Existing evidence

Rows written before this change have no truthful branch or actor. The migration does
not guess them and does not rewrite them. Each PH-MIG table gains `legacy`, added
with `DEFAULT true` and then switched to `DEFAULT false`. Every existing row therefore
reads `legacy = true` without an `UPDATE`, and the read-only triggers stay armed.

A legacy row behaves as follows:

- It keeps a `NULL` branch, so the branch policies never show it.
- It cannot change state, so it cannot be committed or rolled back.
- No new batch can hang off it, because the branch-qualified source key needs a
  branch.
- Nothing after the deploy can create another legacy row.

Old statuses map without loss: `PROFILING` becomes `PARSING`, `PROFILED` becomes
`PREVIEW`, and `FAILED` stays `FAILED`.

### Remediation runbook

A platform operator assigns one legacy source to a branch. Do this only when the
handover evidence says which branch the file came from; never infer it. Work inside a
platform transaction (`app.is_platform_admin = 'true'`, for example through
`withPlatformDb`).

1. List what is waiting:

   ```sql
   SELECT id, "organizationId", "fileName", "capturedAt"
     FROM pharmacy_migration_sources
    WHERE legacy AND "branchId" IS NULL;
   ```

2. Assign one source:

   ```sql
   SELECT pharmacy_migration_remediate_legacy_source(
     '<organization id>', '<source id>', '<branch id>',
     '<operator or ticket>', '<reason, at least 10 characters>');
   ```

The function refuses non-platform callers, a branch outside the organization, and a
source that is not unremediated legacy evidence (so a second call fails). It moves
the source and its legacy batches, rows and exceptions to the branch once. It records
the decision with counts in `pharmacy_migration_legacy_remediations`, which is
append-only and platform-only.

Remediated evidence stays legacy: that branch can now review it, but it is still
read-only and frozen. To commit it, re-upload the same file in that branch. The
upload matches the remediated source by its hash and profiles a new, non-legacy
batch, and only that batch can commit.

## Deploying

`20261023140000_pharmacy_import_core` runs in one explicit transaction with
`SET LOCAL lock_timeout = '5s'` and `statement_timeout = '300s'`. If a lock is not
granted in 5 s, the whole migration rolls back untouched. Prisma then records it as
failed. Run `prisma migrate resolve --rolled-back 20261023140000_pharmacy_import_core`
and deploy again; nothing was half-applied.

Locks, all held until the migration commits:

| Table                                                            | Lock                      | Why                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pharmacy_migration_batches`                                     | ACCESS EXCLUSIVE, rewrite | Status enum swap. One row per upload attempt.                                                                                         |
| `pharmacy_migration_sources`, `_batches`, `_rows`, `_exceptions` | ACCESS EXCLUSIVE          | New columns are catalog-only (constant defaults, no rewrite). CHECK, UNIQUE and index builds scan once. `_rows` is the largest table. |
| `pharmacy_branches`, `users`, `pharmacy_stock_movements`         | SHARE ROW EXCLUSIVE       | Only referenced by new foreign keys. No row in them is read or rewritten, but writes to them wait until the migration commits.        |

Only the import workbench uses the PH-MIG tables. The counter, inventory and finance
paths never touch them, except for those referenced-table locks. Deploy when nobody
is importing. No wider maintenance window is needed.

Measured `started_at → finished_at` as recorded by `prisma migrate deploy` (PostgreSQL
16):

| Database                                                                                                                            | Migration time |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Fresh database, all migrations (two deploys)                                                                                        | 38–61 ms       |
| Upgrade from main: 2 sources, 3 batches, 3,000 rows, 600 exceptions (two deploys)                                                   | 54–58 ms       |
| Upgrade from main: 2 branches, 4 sources, 6 batches, 60,000 rows, 12,000 exceptions (`import-core.migration.db.test.ts`, four runs) | 266–314 ms     |

## Decisions

- Source bytes are not stored in PostgreSQL. The upload adapter will retain an
  object-storage key until parsing finishes; the immutable database evidence is
  its content hash, size, name, branch and actor.
- One workbook import reads its first worksheet. Multi-sheet selection belongs
  in mapping/review, not implicit core behavior.
- A formula is invalid even when XLSX includes a cached result. Trusting that
  result would silently import executable spreadsheet logic as evidence.
- Rollback is all-or-nothing when any created entity gained a later reference.
- Legacy evidence is never assigned a branch by inference. Only a recorded platform
  decision assigns it.

## Follow-ups

Pieces 2–5 still need:

- the object-storage upload adapter and the registered scheduler handler for files of
  2 MiB or more;
- the mapping UI, which produces the commit instructions this core accepts;
- adapters for further entity types (customers, products, khata balances);
- streaming XLSX parsing (the workbook reader still holds the first sheet in memory,
  bounded by the verified archive sizes);
- export call sites for the CSV hardening helper.
