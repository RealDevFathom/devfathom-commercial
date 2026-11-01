BEGIN;

-- Backfill every tenant even when the migration owner is subject to forced RLS.
SELECT set_config('app.is_platform_admin', 'true', true);

-- Keep the raw missing punch and the immutable correction. The one-open-break
-- arbiter must follow effective closure, including an appended BREAK_END.
ALTER TABLE "restaurant_shift_breaks"
  ADD COLUMN "closedByAdjustment" BOOLEAN NOT NULL DEFAULT false;

UPDATE "restaurant_shift_breaks" b
SET "closedByAdjustment" = true
WHERE EXISTS (
  SELECT 1 FROM "restaurant_time_adjustments" a
  WHERE a."organizationId" = b."organizationId" AND a."shiftId" = b."shiftId"
    AND a."breakId" = b."id" AND a."kind" = 'BREAK_END'
);

-- Always derive the projection from history, including on direct SQL writes.
CREATE FUNCTION derive_restaurant_break_correction_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."closedByAdjustment" := EXISTS (
    SELECT 1 FROM public."restaurant_time_adjustments" a
    WHERE a."organizationId" = NEW."organizationId" AND a."shiftId" = NEW."shiftId"
      AND a."breakId" = NEW."id" AND a."kind" = 'BREAK_END'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER restaurant_break_correction_state_guard
BEFORE INSERT OR UPDATE ON "restaurant_shift_breaks"
FOR EACH ROW EXECUTE FUNCTION derive_restaurant_break_correction_state();

CREATE FUNCTION project_restaurant_break_end_adjustment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'BREAK_END' THEN
    UPDATE public."restaurant_shift_breaks" SET "closedByAdjustment" = true
    WHERE "organizationId" = NEW."organizationId" AND "shiftId" = NEW."shiftId"
      AND "id" = NEW."breakId";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER restaurant_break_end_adjustment_projection
AFTER INSERT ON "restaurant_time_adjustments"
FOR EACH ROW EXECUTE FUNCTION project_restaurant_break_end_adjustment();

DROP INDEX "restaurant_shift_breaks_one_open_idx";
CREATE UNIQUE INDEX "restaurant_shift_breaks_one_open_idx"
ON "restaurant_shift_breaks" ("organizationId", "shiftId")
WHERE "endedAt" IS NULL AND NOT "closedByAdjustment";

COMMIT;
