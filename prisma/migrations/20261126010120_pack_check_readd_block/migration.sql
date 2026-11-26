BEGIN;
SET LOCAL lock_timeout = '5s';
-- DEV-1054: a failed pack check stays with the bill and the medicine, not with the line that
-- failed. A new line for that medicine starts blocked while the bill holds a failed PACK_CHECK
-- event for the medicine with no later successful one, whether the failed line is still on the
-- bill or already moved to its void record. Only a successful check on the new line clears it.
--
-- "Later" is the order of ("occurredAt", id). pharmacy_record_pack_check below stamps
-- "occurredAt" while the bill is locked and never at or before the bill's previous check, so
-- that order is the order the checks ran in, whatever order their transactions began in. A
-- successful check counts only when it is strictly later than the failed one. Two checks with
-- the same "occurredAt" (possible only for rows written before that trigger existed) are
-- ordered by event id, and a successful check that is not strictly later (a tie) keeps the block.
--
-- Only the function is replaced. The BEFORE INSERT trigger on pharmacy_sale_lines from
-- 20261121231900_counter_line_pack_check keeps calling it by name, so it is not re-created
-- (that would lock a busy table for nothing).
CREATE OR REPLACE FUNCTION pharmacy_recheck_readded_pack() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pharmacy_sale_events failed
      JOIN public.pharmacy_sale_lines failed_line ON failed_line.id = failed.payload->>'saleLineId'
        AND failed_line."organizationId" = NEW."organizationId"
        AND failed_line."branchId" = NEW."branchId"
    WHERE failed."organizationId" = NEW."organizationId" AND failed."branchId" = NEW."branchId"
      AND failed."saleId" = NEW."saleId" AND failed.kind::text = 'PACK_CHECK'
      AND failed.payload->>'matched' IS DISTINCT FROM 'true'
      AND failed_line."medicineId" = NEW."medicineId"
      AND NOT EXISTS (
        SELECT 1 FROM public.pharmacy_sale_events passed
          JOIN public.pharmacy_sale_lines passed_line
            ON passed_line.id = passed.payload->>'saleLineId'
            AND passed_line."organizationId" = NEW."organizationId"
            AND passed_line."branchId" = NEW."branchId"
        WHERE passed."organizationId" = NEW."organizationId"
          AND passed."branchId" = NEW."branchId"
          AND passed."saleId" = NEW."saleId" AND passed.kind::text = 'PACK_CHECK'
          AND passed.payload->>'matched' = 'true'
          AND passed_line."medicineId" = NEW."medicineId"
          AND (passed."occurredAt", passed.id) > (failed."occurredAt", failed.id)
      )
  ) THEN NEW."packCheckBlocked" := true; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pharmacy_recheck_readded_pack() FROM PUBLIC;

-- Every PACK_CHECK event, whoever writes it: lock the bill and stamp the event with the time it
-- is written under that lock (not the transaction's start and not a caller's clock), at least
-- one millisecond (the column's precision) after the bill's previous check.
CREATE OR REPLACE FUNCTION pharmacy_record_pack_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  previous timestamp;
BEGIN
  PERFORM 1 FROM public.pharmacy_sales WHERE id = NEW."saleId"
    AND "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId" FOR UPDATE;
  SELECT max("occurredAt") INTO previous FROM public.pharmacy_sale_events
    WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId"
      AND "saleId" = NEW."saleId" AND kind::text = 'PACK_CHECK';
  NEW."occurredAt" := GREATEST(
    clock_timestamp() AT TIME ZONE 'UTC', previous + interval '1 millisecond');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pharmacy_record_pack_check() FROM PUBLIC;

-- A failed check blocks EVERY line of that medicine on that bill, including lines that were on
-- the bill before the check, so removing the checked line leaves nothing payable. It runs on the
-- event insert itself, so no caller that records a failed check can skip it. A successful check
-- clears nothing here: it clears only its own line, in the procedure that verified the pack.
CREATE OR REPLACE FUNCTION pharmacy_block_medicine_on_failed_pack_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.pharmacy_sale_lines open_line SET "packCheckBlocked" = true
    FROM public.pharmacy_sale_lines checked
    WHERE checked.id = NEW.payload->>'saleLineId'
      AND checked."organizationId" = NEW."organizationId" AND checked."branchId" = NEW."branchId"
      AND open_line."organizationId" = NEW."organizationId"
      AND open_line."branchId" = NEW."branchId" AND open_line."saleId" = NEW."saleId"
      AND open_line."medicineId" = checked."medicineId"
      AND NOT open_line."packCheckBlocked";
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION pharmacy_block_medicine_on_failed_pack_check() FROM PUBLIC;

-- Each trigger is created once: a re-run leaves an existing trigger (and the table) alone.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'pharmacy_record_pack_check'
      AND tgrelid = 'public.pharmacy_sale_events'::regclass AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER pharmacy_record_pack_check BEFORE INSERT ON public.pharmacy_sale_events
      FOR EACH ROW WHEN (NEW.kind::text = 'PACK_CHECK')
      EXECUTE FUNCTION pharmacy_record_pack_check();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'pharmacy_block_medicine_on_failed_pack_check'
      AND tgrelid = 'public.pharmacy_sale_events'::regclass AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER pharmacy_block_medicine_on_failed_pack_check
      AFTER INSERT ON public.pharmacy_sale_events FOR EACH ROW
      WHEN (NEW.kind::text = 'PACK_CHECK' AND NEW.payload->>'matched' IS DISTINCT FROM 'true')
      EXECUTE FUNCTION pharmacy_block_medicine_on_failed_pack_check();
  END IF;
END $$;
COMMIT;
