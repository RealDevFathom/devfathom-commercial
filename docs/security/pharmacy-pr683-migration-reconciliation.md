# PR #683 migration deployment and former names

Fresh databases use `prisma migrate deploy` with the checked-in `20261029100000` through
`20261029106000` migrations. Generate the Prisma client before application QA.

Some pre-release databases may have applied the former `20261028120000`,
`20261028121000`, `20261028122000`, `20261028123000`, or `20261028124000`
pharmacy migrations. These are historical names, not proof that the current SQL
has run: the bodies changed during review. Do **not** run deploy blindly on those
databases, delete `_prisma_migrations` rows, reset the database, rename historical
rows, or mark every new stamp applied on the strength of a name match.

Before upgrading such a database:

1. Take a restorable backup and retain the original migration SQL/checksums and
   deployment logs. Inventory `_prisma_migrations` using a read-only query for the
   `20261028%pharmacy%` and `20261029%pharmacy%` names, including failed/rolled-back rows.
2. Restore the backup into an isolated local database. Compare the deployed SQL
   bodies and actual schema with the current migration series: functions, triggers,
   constraints, forced RLS policies, owner grants, and `ownerManaged` provenance all
   matter. A schema-only diff cannot establish whether permission backfills ran.
3. Prepare an explicit, reviewed forward reconciliation script for that exact
   inventory. Reapply missing constraints/functions and idempotent backfills;
   preserve DENYs, clinical/audit evidence and manual branch assignments. The final
   `106000` migration installs the corrected owner lifecycle and PV guard and
   migrates system bootstrap administrators, but does not establish equivalence for
   the earlier purchase, controlled-witness, inventory and settlement guards.
4. Only after proving each corresponding current stamp's schema **and data effects**
   are present, use Prisma's supported `migrate resolve --applied <exact-name>`
   for that individual stamp. Retain the original historical rows as evidence.
   Resolve failed stamps according to the actual rolled-back or completed state;
   never use a blanket loop or destructive history surgery.
5. Run `migrate status`, `migrate deploy` and the changed pharmacy/support DB suites
   on the restored copy. Verify manual rows remain `ownerManaged=false`, new owner
   rows are managed, staffed self-approval fails and solo approval requires fresh
   transaction-bound PIN audit evidence. Apply the reviewed procedure to the target
   only after that rehearsal succeeds.

If the former owner-assignment migration already claimed a manual row as managed,
SQL cannot infer its original provenance. Recover that provenance from the backup
or assignment audit and explicitly restore `ownerManaged=false` for the identified
rows before any owner demotion. Never relabel all assignments speculatively.

The source corrections to `101000`, `102000` and `104000` repair clean deployment.
An already deployed checksum is evidence to investigate, not permission to rewrite
migration history. The additive `106000` migration provides the forward fixes for
the current PR stamps; the legacy-name reconciliation remains inventory-specific.
