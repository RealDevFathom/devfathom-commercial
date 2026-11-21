-- DEV-1004: indexes for two lookups that read a key inside a sale event's payload (DEV-977B, DEV-958B).
--
-- 1. A bill-line change or removal looks up the record its request key already made (a retried
--    request applies once): the CREATED event whose payload names that "lineChangeKey".
-- 2. A cash shift's report counts the lines taken off bills during the shift: the VOIDED events
--    whose payload names that "shiftId".
--
-- Both were filters on the JSON payload, which no index covered, so each read every sale event of
-- the branch. The application now writes each lookup as the expression indexed here
-- (src/lib/pharmacy/sales.ts lineChangeRecord, src/lib/pharmacy/cash-shifts.ts readShiftFigures).
-- Each index is partial: only events that carry the key are indexed, which is a small share of
-- the table. No row, policy or permission changes. Idempotent.
BEGIN;

-- Building an index locks the table against writes until it is built. Give up rather than queue
-- behind a long transaction (and hold every later sale behind this one): rerun it in a quiet window.
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS "pharmacy_sale_events_line_change_key_idx"
  ON "pharmacy_sale_events" ("organizationId", "branchId", ("payload"->>'lineChangeKey'))
  WHERE "kind" = 'CREATED' AND ("payload"->>'lineChangeKey') IS NOT NULL;

CREATE INDEX IF NOT EXISTS "pharmacy_sale_events_void_shift_idx"
  ON "pharmacy_sale_events" ("organizationId", "branchId", ("payload"->>'shiftId'))
  WHERE "kind" = 'VOIDED' AND ("payload"->>'shiftId') IS NOT NULL;

COMMIT;
