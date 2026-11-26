BEGIN;
SET LOCAL lock_timeout = '5s';
-- DEV-1054: a failed pack check stays with the bill and the medicine, not with the line that
-- failed. A new line for that medicine starts blocked while the bill holds a failed PACK_CHECK
-- event for the medicine with no later successful one, whether the failed line is still on the
-- bill or already moved to its void record. Only a successful check on the new line clears it.
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
CREATE OR REPLACE TRIGGER pharmacy_recheck_readded_pack BEFORE INSERT ON pharmacy_sale_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_recheck_readded_pack();
COMMIT;
