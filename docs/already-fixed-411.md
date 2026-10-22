# GitHub issue #411 is already fixed

Issue #411 reports that agency meetings accept an end time that is before or
equal to the start time. The current code already rejects both cases, so no
implementation change is required:

- `src/lib/meetings/validation.ts:3-7,19-33` defines the shared strict
  `endTime > startTime` predicate and applies it to meeting creation input.
- `src/lib/meetings/validation.ts:35-50` rejects an invalid update when both
  endpoints are supplied.
- `src/server/routers/meetings.ts:374-394` merges either endpoint from a partial
  update with the stored endpoint and rejects an invalid resulting range before
  any attendee or meeting write.
- `src/app/(app)/meetings/meetings-content.tsx:209-220,301-305,374-380` prevents
  invalid create submissions, displays the validation error, and disables the
  Schedule button.
- `prisma/migrations/20261022010000_meetings_time_order_check/migration.sql:1-13`
  repairs legacy invalid ranges and adds a database check constraint enforcing
  `endTime > startTime` for every write path.
- `src/server/routers/meetings-time-range.test.ts:17-77` covers valid creation,
  equal and backwards creation ranges, complete invalid updates, and invalid
  partial updates.
- `src/app/(app)/meetings/meetings-content.test.tsx:115-134` covers the visible
  error, disabled action, and absence of a create call for an equal time range.

This evidence was verified by static inspection of the current tree only, in
accordance with the issue instructions; no dependencies were installed and no
tests were run.
