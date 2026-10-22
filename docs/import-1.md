# Pharmacy import 1/5 — core

## Design

This change deliberately extends `PharmacyMigrationSource`, `PharmacyMigrationBatch`,
`PharmacyMigrationRow`, and `PharmacyMigrationException`; it does not introduce a
second import stack. A source remains immutable evidence identified by SHA-256. A
batch is the audited attempt by one user, and rows remain tenant-scoped staging.

The batch state machine is `UPLOADED → PARSING → PREVIEW → COMMITTING → COMMITTED
→ ROLLED_BACK`, with `FAILED` exits and a retry from `FAILED` to `PARSING`. Preview
only profiles into staging and exception buckets. It never writes a live entity.

`PharmacyMigrationBatchEntity` is the commit manifest. Every entity created by a
commit is recorded as `CREATED`; every append-only stock-ledger posting is recorded
as `STOCK_MOVEMENT`. The unique batch/source-row/entity-operation key and the
`contentHash + sourceKey` application key make retries idempotent. Rollback may
delete only manifested `CREATED` entities after reference checks, and must post an
exact compensating movement for each manifested stock movement. It must not edit
or delete an existing entity. Any new reference blocks the whole rollback with a
reason rather than partially rolling it back.

CSV and XLSX are parsed on the server. Limits are 20 MiB, 50,000 data rows, and
200 columns. XLSX formula cells are rejected rather than evaluated. CSV export
cells beginning with spreadsheet metacharacters are apostrophe-prefixed. Files at
or above 2 MiB are classified for the existing durable scheduler rather than
being parsed in a request.

Customer matching uses Pakistani E.164 mobile normalization. Product matching is
barcode-first, then normalized name + generic + strength with whitespace, case,
and common unit aliases normalized. Money continues to use integer minor units.

Authorization uses the central `can()` path via `pharmacy:data-import`. The
capability is granted to pharmacy owner (through `pharmacy:*`) and manager only;
the existing evaluator checks explicit DENY before ALLOW. Capability procedures
also retain the common tRPC audit middleware. The new manifest table has the same
organization default and forced-RLS policy as adjacent tenant tables.

## Decisions

- Source bytes are not stored in PostgreSQL. The upload adapter will retain an
  object-storage key until parsing finishes; the immutable database evidence is
  its content hash, size, name, and actor.
- One workbook import reads its first worksheet. Multi-sheet selection belongs
  in mapping/review, not implicit core behavior.
- A formula is invalid even when XLSX includes a cached result. Trusting that
  result would silently import executable spreadsheet logic as evidence.
- Rollback is all-or-nothing when any created entity gained a later reference.

## Follow-ups

Pieces 2–5 should add the object-storage upload adapter and registered scheduler
handler, mapping UI, transactional live-model commit adapters, and the rollback
reference check/reversal transaction. Those adapters must populate the manifest
in the same transaction as live writes and use the existing `OPENING` stock kind.
Database integration coverage should exercise forced-RLS cross-tenant attempts,
owner/manager grants and explicit denies, preview no-write, retry races, rollback
reference blocking, and exact stock reversal.
