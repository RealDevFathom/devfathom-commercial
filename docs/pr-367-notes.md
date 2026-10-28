# PR #367 review notes

## Scope reviewed

Reviewed the branch change that wires pharmacy daily-close creation to the shared finance journal.
The review covered transaction ordering, tenant and branch scoping, idempotency, cash-variance money
handling, and the existing counter-evidence integration.

## Findings and changes

- The production change correctly invokes `postDailyCloseEntry` after the immutable close is created
  and before counter evidence is requested. Production callers run the operation inside their
  existing database transaction, so a journal or evidence failure rolls the close back with its
  dependent writes.
- The finance adapter already reads the close within the authorized organization, rejects a close
  from another branch, uses a close-specific idempotency key, and posts only the absolute integer
  cash variance as balanced cash and cash-over/short legs. No tenant-isolation, authorization
  precedence, pharmacy-capability, or money-invariant change was needed.
- The existing daily-close counter-evidence unit test exercised the real finance adapter with a
  deliberately minimal database double. Once the new integration was added, that fixture could fail
  before reaching the behavior the test owns. The test now isolates the finance boundary and asserts
  that finance posting occurs before evidence creation.
- Added a regression case proving that a finance-posting failure prevents any evidence request. This
  preserves atomic ordering and makes the intended rollback boundary explicit.

## Validation

Per the task constraint, dependencies were not installed and tests were not run. Review was limited
to static inspection of the branch diff and the affected settlement, finance-posting, transaction,
and evidence code paths.
