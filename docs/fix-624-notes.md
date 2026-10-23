# Fix #624 QA notes

## Code evidence

- `src/lib/pharmacy/whatsapp/inbound.ts:104-130` sends customer orders through the existing storefront service with `staff: false`. It retains the tenant, selected branch, and linked-customer actor scope, but no longer requires the linked customer to hold the staff-only `pharmacy:orders` capability.
- `src/lib/pharmacy/whatsapp/inbound.ts:216-237` reads an outbound row inside the tenant-scoped database context. It treats only `SENT` as complete; any other existing state reuses the claimed row for another provider attempt rather than creating another dedupe row.
- `src/lib/pharmacy/whatsapp/inbound.ts:301-325` resumes a previously committed order by its tenant, customer, and order identifiers. A `SENT` confirmation makes the webhook a duplicate, while a missing, `PENDING`, or `FAILED` confirmation proceeds to confirmation without placing the order again.
- `src/lib/pharmacy/whatsapp/inbound.test.ts:213-225` exercises the ordinary customer path without an authorization mock that defaults to allow.
- `src/lib/pharmacy/whatsapp/inbound.test.ts:277-290` verifies that a `SENT` confirmation is never resent and that the order is not placed twice.
- `src/lib/pharmacy/whatsapp/inbound.test.ts:309-340` covers retries for both `PENDING` and `FAILED` confirmations and verifies that the already committed order is not replaced.
- `src/lib/pharmacy/whatsapp/provider.ts:240-249` remains the default mock sender implementation used by this flow; its responses are explicitly not accepted by a live provider. No live-send enablement was added.

## Scope and skipped checks

- No schema or migration change was needed.
- Per the task constraints, dependencies were not installed, the test suite was not run, and no database-backed checks were attempted (Bun 1.2.14 / unavailable database / npm 403 constraints).
- The requested `git fetch origin main` could not run because this checkout has no `origin` remote. The locally available `08a247c1` commit was merged directly with `git merge --no-edit 08a247c1`, preserving all of that merge's launch fixes and migrations.
