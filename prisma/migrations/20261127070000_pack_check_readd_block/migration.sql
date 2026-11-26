BEGIN;
SET LOCAL lock_timeout = '5s';
-- DEV-1054: a failed pack check stays with the bill and the medicine, not with the line that
-- failed. A new line for that medicine starts blocked while the bill holds a failed PACK_CHECK
-- event for the medicine with no later successful one, whether the failed line is still on the
-- bill or already moved to its void record. Only a successful check on the new line clears it.
-- "Later" is a strictly greater "occurredAt", which the event trigger below stamps while the
-- bill is locked. Two checks stamped in the same millisecond tie, and a tie keeps the block.
-- The existing BEFORE INSERT trigger on pharmacy_sale_lines keeps calling this function.
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
          AND passed."occurredAt" > failed."occurredAt"
      )
  ) THEN NEW."packCheckBlocked" := true; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pharmacy_recheck_readded_pack() FROM PUBLIC;

-- Every PACK_CHECK event, whoever writes it: lock the bill, stamp the event with the time it is
-- written under that lock (not the transaction's start and not a caller's clock), and on a
-- failed check block every line of that medicine still on the bill, not only the checked line.
-- A successful check clears only its own line, in the procedure that records it.
CREATE OR REPLACE FUNCTION pharmacy_record_pack_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  checked_medicine text;
BEGIN
  PERFORM 1 FROM public.pharmacy_sales WHERE id = NEW."saleId"
    AND "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId" FOR UPDATE;
  NEW."occurredAt" := clock_timestamp();
  IF NEW.payload->>'matched' IS DISTINCT FROM 'true' THEN
    SELECT "medicineId" INTO checked_medicine FROM public.pharmacy_sale_lines
      WHERE id = NEW.payload->>'saleLineId'
        AND "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId";
    UPDATE public.pharmacy_sale_lines SET "packCheckBlocked" = true
      WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId"
        AND "saleId" = NEW."saleId" AND "medicineId" = checked_medicine
        AND NOT "packCheckBlocked";
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pharmacy_record_pack_check() FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'pharmacy_record_pack_check'
      AND tgrelid = 'public.pharmacy_sale_events'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER pharmacy_record_pack_check BEFORE INSERT ON public.pharmacy_sale_events
      FOR EACH ROW WHEN (NEW.kind::text = 'PACK_CHECK')
      EXECUTE FUNCTION pharmacy_record_pack_check();
  END IF;
END $$;
COMMIT;
