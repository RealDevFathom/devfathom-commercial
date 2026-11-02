# Pharmacy record retention (DEV-96)

The database resolves retention from the branch profile and jurisdiction rule set
effective when the record was created (prescriptions use `capturedAt`). It rejects
missing, placeholder, provisional, malformed or nonpositive policies. This change
does not supply legal durations or turn provisional seed data into confirmed law.

`recordRetentionByClass` uses the existing provenance envelope:

```text
{
  "provisional": false,
  "values": {
    "PRESCRIPTION": <positive integer days>,
    "CONTROLLED_REGISTER": <positive integer days>,
    "FISCAL": <positive integer days>,
    "AUDIT": <positive integer days>
  }
}
```

Prescription rules also require confirmed, nonempty
`prescriptionRetentionDays.values`, with positive integer day counts. Since the
stored prescription has no reliable retention classification, the longest count
applies. The tenant's effective `PharmacyRetentionClass` can lengthen the
jurisdiction minimum; it cannot replace missing jurisdiction policy or shorten it.

`CONTROLLED_REGISTER` resolves register entry IDs; `FISCAL` resolves sale IDs,
matching the existing legal-hold targets. Fiscal document and append-only guards
remain in place. Expiry establishes eligibility under this policy, not permission
to bypass other record-owner restrictions.

Prescriptions and audit records have no branch column. Their policy is the maximum
across every tenant pharmacy branch existing at the record timestamp, requiring
valid policy for each branch. A branch-specific request for either class fails
closed. Branch-owned records require the supplied branch to match. Scope and
creation timestamps cannot be rewritten to evade retention. Pharmacy branch
removal and organization scope changes are restricted while branchless evidence
remains.

## Deletion and concurrency

`pharmacy_record_retention_status` returns a database deadline, database check time
and a blocker for expected policy, hold or scope failures. Unexpected SQL errors
propagate. Deletion is eligible at the exact deadline, never before it. SQL delete
triggers revalidate independently of application checks, including legal holds.
Covered tables reject `TRUNCATE`. Existing immutable guards are not removed.

A private singleton row serializes policy, hold and relevant scope changes with
checks/deletes. Updating it also rejects stale repeatable-read/serializable
snapshots. This conservative implementation serializes retention work across
tenants; keep purge transactions short. It does not authorize deletion through
session flags. Existing tenant row-level security continues to apply.

## Purge coordinator

`runPharmacyRetentionPurge(db, scope, owners, limit)` runs a bounded batch in the
tenant transaction. The default is 100 candidates and the hard maximum is 500
across all supplied owners, including skipped records. Each owner supplies a
bounded candidate page and deletes its complete aggregate through the provided
transaction. The coordinator locks before scanning, rechecks current policy/holds
before each delete, and skips blocked or unexpired records. A savepoint restores
the entire batch on owner failure even if an enclosing caller catches the error.

Owners are trusted internal code, not request data. They must honor tenant/branch
scope, use the supplied transaction for all writes, throw if aggregate deletion
fails, and perform no external I/O. An owner with pagination should persist its
cursor only within that transaction. The caller must authorize tenant-wide or
branch-wide access before invoking the coordinator.

This recovery adds the coordinator contract, not a scheduled destructive task or
generic cascade deletion. Record owners must supply their safe aggregate cleanup
before scheduling it. Existing append-only records can still refuse deletion
after expiry. No migration or purge was run against a shared database.

## Focused verification

Run the dependency-free application checks with:

```sh
node --test tests/pharmacy-retention.test.mjs
```

The test uses Node's built-in TypeScript transform on the actual source and omits
only the Next.js `server-only` marker, as the existing Vitest configuration does.
Database verification uses the separate disposable PostgreSQL retention fixture;
it must never target an application or shared database. The recovery report records
exact commands/results and distinguishes current evidence from historical checks.
