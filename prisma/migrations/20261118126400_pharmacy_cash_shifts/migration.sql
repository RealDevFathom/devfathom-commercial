-- DEV-958B (phase 2 of DEV-958): cash shifts on a pharmacy drawer.
BEGIN;

-- Within one business day a branch that runs shifts opens several shifts, one after another, on a
-- counter's drawer. A cashier opens a shift with a counted opening float and closes it with a
-- counted closing amount; the shift report is frozen at the close. The day close then closes the
-- business day, and only once every shift of that day at the branch is closed.
--
-- A branch runs shifts only when "cashShiftsEnabled" is true. It is false for every branch (phase 3
-- lets the owner choose), and a drawer copies the flag when it opens ("cashShifts"), so a branch that
-- does not run shifts records what it records today: no shift rows and no shift on any tender, refund
-- or drawer movement. Two plain facts are now kept on every branch: the counter a refund was paid at
-- ("deviceId") and the time an offline sale was sold ("soldAt"); neither changes any figure.
--
-- The database decides which shift a tender, refund or drawer movement belongs to, under a share
-- lock on that shift row, so no instant is in two shifts or none and a shift close cannot race a
-- payment. A closed shift is never changed; corrections are new, audited entries in an open shift.
--
-- Additive and idempotent: columns are ADD COLUMN IF NOT EXISTS with defaults (no existing row
-- changes meaning, nothing recorded is rewritten), the type and table are created only when absent,
-- constraints are added only when absent, functions are CREATE OR REPLACE and their triggers are
-- dropped and re-created. No row is read or written here.

ALTER TABLE "pharmacy_branches" ADD COLUMN IF NOT EXISTS "cashShiftsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pharmacy_branches" ADD COLUMN IF NOT EXISTS "cashShiftVarianceToleranceMinor" INTEGER NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pharmacy_branches_cash_shift_tolerance_check'
       AND conrelid = '"pharmacy_branches"'::regclass
  ) THEN
    ALTER TABLE "pharmacy_branches"
      ADD CONSTRAINT "pharmacy_branches_cash_shift_tolerance_check"
      CHECK ("cashShiftVarianceToleranceMinor" >= 0);
  END IF;
END $$;

ALTER TABLE "pharmacy_drawer_sessions" ADD COLUMN IF NOT EXISTS "cashShifts" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PharmacyCashShiftStatus') THEN
    CREATE TYPE "PharmacyCashShiftStatus" AS ENUM ('OPEN', 'CLOSED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "pharmacy_cash_shifts" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "drawerSessionId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "businessDate" DATE NOT NULL,
  "sequence" INTEGER NOT NULL,
  "status" "PharmacyCashShiftStatus" NOT NULL DEFAULT 'OPEN',
  "cashierId" TEXT NOT NULL,
  "openedByActorId" TEXT NOT NULL,
  "openingFloatMinor" INTEGER NOT NULL,
  "openingDifferenceMinor" INTEGER NOT NULL DEFAULT 0,
  "openingNote" TEXT,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedByActorId" TEXT,
  "closedAt" TIMESTAMP(3),
  "countedCashMinor" INTEGER,
  "expectedCashMinor" INTEGER,
  "varianceMinor" INTEGER,
  "varianceNote" TEXT,
  "varianceApprovedById" TEXT,
  "varianceApprovalPolicy" TEXT,
  "report" JSONB,
  CONSTRAINT "pharmacy_cash_shifts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_cash_shifts_drawer_fkey" FOREIGN KEY ("organizationId", "drawerSessionId")
    REFERENCES "pharmacy_drawer_sessions"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_cash_shifts_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_cash_shifts_opening_check" CHECK (
    "sequence" >= 1 AND "openingFloatMinor" >= 0
    AND ("sequence" > 1 OR "openingDifferenceMinor" = 0)
    AND ("openingDifferenceMinor" = 0 OR length(btrim(COALESCE("openingNote", ''))) > 0)
  ),
  CONSTRAINT "pharmacy_cash_shifts_close_check" CHECK (
    ("status" = 'OPEN' AND "closedAt" IS NULL AND "closedByActorId" IS NULL
      AND "countedCashMinor" IS NULL AND "expectedCashMinor" IS NULL AND "varianceMinor" IS NULL
      AND "report" IS NULL)
    OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "closedByActorId" IS NOT NULL
      AND "countedCashMinor" >= 0 AND "expectedCashMinor" IS NOT NULL
      AND "varianceMinor" = "countedCashMinor" - "expectedCashMinor" AND "report" IS NOT NULL
      AND ("varianceMinor" = 0 OR length(btrim(COALESCE("varianceNote", ''))) > 0))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_cash_shifts_organizationId_id_key"
  ON "pharmacy_cash_shifts"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_cash_shifts_drawer_sequence_key"
  ON "pharmacy_cash_shifts"("organizationId", "drawerSessionId", "sequence");
CREATE INDEX IF NOT EXISTS "pharmacy_cash_shifts_organizationId_branchId_businessDate_idx"
  ON "pharmacy_cash_shifts"("organizationId", "branchId", "businessDate");
-- One open shift per drawer.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_one_open_cash_shift_per_drawer"
  ON "pharmacy_cash_shifts"("organizationId", "drawerSessionId") WHERE "status" = 'OPEN';

ALTER TABLE "pharmacy_cash_shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_cash_shifts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_cash_shifts";
CREATE POLICY tenant_isolation ON "pharmacy_cash_shifts"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

-- Which shift each money row belongs to. "lateArrivalShiftId" names the closed shift an offline
-- sale was sold in when it reaches the server after that shift closed: the late entry belongs to no
-- open shift, is shown on that day's close, and never changes the closed shift.
ALTER TABLE "pharmacy_tenders" ADD COLUMN IF NOT EXISTS "shiftId" TEXT;
ALTER TABLE "pharmacy_tenders" ADD COLUMN IF NOT EXISTS "lateArrivalShiftId" TEXT;
-- The instant an offline sale was sold (the signed command's time); empty for online payments.
ALTER TABLE "pharmacy_tenders" ADD COLUMN IF NOT EXISTS "soldAt" TIMESTAMP(3);
ALTER TABLE "pharmacy_refunds" ADD COLUMN IF NOT EXISTS "shiftId" TEXT;
ALTER TABLE "pharmacy_refunds" ADD COLUMN IF NOT EXISTS "lateArrivalShiftId" TEXT;
-- The counter the refund was paid at, so a non-cash refund finds that counter's shift.
ALTER TABLE "pharmacy_refunds" ADD COLUMN IF NOT EXISTS "deviceId" TEXT;
ALTER TABLE "pharmacy_drawer_movements" ADD COLUMN IF NOT EXISTS "shiftId" TEXT;
ALTER TABLE "pharmacy_drawer_movements" ADD COLUMN IF NOT EXISTS "lateArrivalShiftId" TEXT;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_tenders', 'pharmacy_refunds', 'pharmacy_drawer_movements'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_shift_fkey') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("organizationId", "shiftId") REFERENCES "pharmacy_cash_shifts"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT',
        t, t || '_shift_fkey');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_late_shift_fkey') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("organizationId", "lateArrivalShiftId") REFERENCES "pharmacy_cash_shifts"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT',
        t, t || '_late_shift_fkey');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_one_shift_check') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK ("shiftId" IS NULL OR "lateArrivalShiftId" IS NULL)',
        t, t || '_one_shift_check');
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS "pharmacy_tenders_organizationId_shiftId_idx"
  ON "pharmacy_tenders"("organizationId", "shiftId");
CREATE INDEX IF NOT EXISTS "pharmacy_refunds_organizationId_shiftId_idx"
  ON "pharmacy_refunds"("organizationId", "shiftId");
CREATE INDEX IF NOT EXISTS "pharmacy_drawer_movements_organizationId_shiftId_idx"
  ON "pharmacy_drawer_movements"("organizationId", "shiftId");

-- A drawer runs shifts when its branch did at the moment it opened; that never changes for the drawer.
-- A shift drawer is not closed while one of its shifts is open.
CREATE OR REPLACE FUNCTION pharmacy_drawer_cash_shift_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."cashShifts" := COALESCE((
      SELECT b."cashShiftsEnabled" FROM "pharmacy_branches" b
       WHERE b."organizationId" = NEW."organizationId" AND b."id" = NEW."branchId"
    ), false);
    RETURN NEW;
  END IF;
  IF NEW."cashShifts" IS DISTINCT FROM OLD."cashShifts" THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_MODE_FIXED: a drawer keeps the shift mode it opened with'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' AND OLD."cashShifts" AND EXISTS (
    SELECT 1 FROM "pharmacy_cash_shifts" s
     WHERE s."organizationId" = OLD."organizationId" AND s."drawerSessionId" = OLD."id"
       AND s."status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_OPEN: close the open shift before the drawer'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_drawer_cash_shift_guard ON "pharmacy_drawer_sessions";
CREATE TRIGGER pharmacy_drawer_cash_shift_guard
  BEFORE INSERT OR UPDATE ON "pharmacy_drawer_sessions"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_drawer_cash_shift_guard();

-- A shift's expected cash, worked out the same way as the application (cash-shifts.ts): its counted
-- opening float, plus cash sales and paid-in, less cash refunds and paid-out, in the shift.
CREATE OR REPLACE FUNCTION pharmacy_cash_shift_expected(org text, shift text, opening integer)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT opening::bigint + COALESCE(SUM(CASE
    WHEN m."kind" IN ('CASH_SALE', 'PAID_IN') THEN m."amountMinor"::bigint
    WHEN m."kind" IN ('CASH_REFUND', 'PAID_OUT') THEN -m."amountMinor"::bigint
    ELSE 0 END), 0)
  FROM "pharmacy_drawer_movements" m
  WHERE m."organizationId" = org AND m."shiftId" = shift
$$;

-- A shift opens only on an open shift drawer of the same branch, counter and business day, as the
-- next in sequence after a closed one, with its difference from the last closing count recorded.
-- An open shift changes only by closing, with the expected cash the database works out; a closed
-- shift never changes and no shift is deleted.
CREATE OR REPLACE FUNCTION pharmacy_cash_shift_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  drawer record;
  previous record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_IMMUTABLE: a cash shift is never deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT d."branchId", d."deviceId", d."businessDate", d."status", d."cashShifts" INTO drawer
      FROM "pharmacy_drawer_sessions" d
     WHERE d."organizationId" = NEW."organizationId" AND d."id" = NEW."drawerSessionId"
     FOR SHARE;
    IF NOT FOUND OR drawer."status" <> 'OPEN' OR NOT drawer."cashShifts"
       OR drawer."branchId" <> NEW."branchId" OR drawer."deviceId" <> NEW."deviceId"
       OR drawer."businessDate" <> NEW."businessDate" THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_DRAWER_INVALID: a shift opens on an open shift drawer of its day'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_DRAWER_INVALID: a shift opens open' USING ERRCODE = '23514';
    END IF;
    SELECT s."sequence", s."status", s."countedCashMinor" INTO previous
      FROM "pharmacy_cash_shifts" s
     WHERE s."organizationId" = NEW."organizationId" AND s."drawerSessionId" = NEW."drawerSessionId"
     ORDER BY s."sequence" DESC LIMIT 1;
    IF NOT FOUND THEN
      IF NEW."sequence" <> 1 OR NEW."openingDifferenceMinor" <> 0 THEN
        RAISE EXCEPTION 'PHARMACY_SHIFT_SEQUENCE: the first shift is number 1' USING ERRCODE = '23514';
      END IF;
    ELSIF previous."status" <> 'CLOSED' OR NEW."sequence" <> previous."sequence" + 1
       OR NEW."openingDifferenceMinor" <> NEW."openingFloatMinor" - previous."countedCashMinor" THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_SEQUENCE: a shift follows a closed shift and records its handover difference'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_IMMUTABLE: a closed cash shift cannot change' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" <> 'CLOSED'
     OR (NEW."id", NEW."organizationId", NEW."branchId", NEW."drawerSessionId", NEW."deviceId",
         NEW."businessDate", NEW."sequence", NEW."cashierId", NEW."openedByActorId",
         NEW."openingFloatMinor", NEW."openingDifferenceMinor", NEW."openingNote", NEW."openedAt")
        IS DISTINCT FROM
        (OLD."id", OLD."organizationId", OLD."branchId", OLD."drawerSessionId", OLD."deviceId",
         OLD."businessDate", OLD."sequence", OLD."cashierId", OLD."openedByActorId",
         OLD."openingFloatMinor", OLD."openingDifferenceMinor", OLD."openingNote", OLD."openedAt") THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_IMMUTABLE: an open shift changes only by closing' USING ERRCODE = '55000';
  END IF;
  IF NEW."expectedCashMinor"::bigint
     <> pharmacy_cash_shift_expected(OLD."organizationId", OLD."id", OLD."openingFloatMinor") THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_EXPECTED_MISMATCH: the shift changed; count again'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_cash_shift_guard ON "pharmacy_cash_shifts";
CREATE TRIGGER pharmacy_cash_shift_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "pharmacy_cash_shifts"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_cash_shift_guard();

-- The shift a money row belongs to. Returns the open shift's id (or, for an offline sale whose
-- shift has closed since, the closed shift's id as a late arrival), under a share lock on that row.
--   * A drawer that does not run shifts: no shift. A row naming one is refused.
--   * No drawer (a non-cash payment at a counter without an open drawer): no shift, unless the
--     branch runs shifts, which takes no money outside a shift.
--   * A shift drawer: its open shift, which must be on the row's business day.
--   * An offline sale (sold_at set): the latest shift of the drawer opened at or before the sale;
--     still open, it is that shift; closed since, the sale is a late arrival on it.
-- The application may pass the attribution it read back from the tender to the tender's own cash
-- movement; it is accepted only when it is exactly what this rule allows.
CREATE OR REPLACE FUNCTION pharmacy_cash_shift_for(
  org text, branch text, drawer_id text, device text, business_date date, sold_at timestamp,
  given_shift text, given_late text, closing_amount integer,
  OUT shift_id text, OUT late_shift_id text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d_id text;
  d_shifts boolean;
  s_id text;
  s_status text;
  s_date date;
  s_counted integer;
  branch_runs_shifts boolean;
BEGIN
  shift_id := NULL;
  late_shift_id := NULL;
  IF drawer_id IS NOT NULL THEN
    SELECT d."id", d."cashShifts" INTO d_id, d_shifts FROM "pharmacy_drawer_sessions" d
     WHERE d."organizationId" = org AND d."id" = drawer_id;
  ELSIF device IS NOT NULL THEN
    SELECT d."id", d."cashShifts" INTO d_id, d_shifts FROM "pharmacy_drawer_sessions" d
     WHERE d."organizationId" = org AND d."branchId" = branch AND d."deviceId" = device
       AND d."status" = 'OPEN';
  END IF;
  IF d_id IS NULL OR NOT d_shifts THEN
    IF given_shift IS NOT NULL OR given_late IS NOT NULL THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: this drawer runs no shifts'
        USING ERRCODE = '23514';
    END IF;
    IF d_id IS NULL AND branch IS NOT NULL THEN
      SELECT b."cashShiftsEnabled" INTO branch_runs_shifts FROM "pharmacy_branches" b
       WHERE b."organizationId" = org AND b."id" = branch;
      IF COALESCE(branch_runs_shifts, false) THEN
        RAISE EXCEPTION 'PHARMACY_SHIFT_NOT_OPEN: open a shift on this counter first'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN;
  END IF;

  IF closing_amount IS NOT NULL THEN
    -- The drawer's closing count: after its last shift closed, and the same amount.
    IF EXISTS (SELECT 1 FROM "pharmacy_cash_shifts" s
                WHERE s."organizationId" = org AND s."drawerSessionId" = d_id
                  AND s."status" = 'OPEN') THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_OPEN: close the open shift before the drawer'
        USING ERRCODE = '55000';
    END IF;
    SELECT s."id", s."countedCashMinor" INTO s_id, s_counted FROM "pharmacy_cash_shifts" s
     WHERE s."organizationId" = org AND s."drawerSessionId" = d_id
     ORDER BY s."sequence" DESC LIMIT 1;
    IF s_id IS NOT NULL AND s_counted IS DISTINCT FROM closing_amount THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_COUNT_MISMATCH: the drawer closes on its last shift''s count'
        USING ERRCODE = '23514';
    END IF;
    IF given_shift IS NOT NULL OR given_late IS NOT NULL THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: a closing count belongs to no shift'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  IF given_late IS NOT NULL THEN
    SELECT s."id" INTO s_id FROM "pharmacy_cash_shifts" s
     WHERE s."organizationId" = org AND s."id" = given_late AND s."drawerSessionId" = d_id
       AND s."status" = 'CLOSED'
     FOR SHARE;
    IF s_id IS NULL OR given_shift IS NOT NULL THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: a late arrival names a closed shift of its drawer'
        USING ERRCODE = '23514';
    END IF;
    late_shift_id := s_id;
    RETURN;
  END IF;

  IF sold_at IS NOT NULL THEN
    SELECT s."id", s."status"::text INTO s_id, s_status FROM "pharmacy_cash_shifts" s
     WHERE s."organizationId" = org AND s."drawerSessionId" = d_id AND s."openedAt" <= sold_at
     ORDER BY s."sequence" DESC LIMIT 1
     FOR SHARE;
    IF s_id IS NOT NULL AND s_status = 'CLOSED' THEN
      IF given_shift IS NOT NULL THEN
        RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: that shift has closed'
          USING ERRCODE = '23514';
      END IF;
      late_shift_id := s_id;
      RETURN;
    END IF;
  END IF;

  s_id := NULL;
  SELECT s."id", s."businessDate" INTO s_id, s_date FROM "pharmacy_cash_shifts" s
   WHERE s."organizationId" = org AND s."drawerSessionId" = d_id AND s."status" = 'OPEN'
   FOR SHARE;
  IF s_id IS NULL THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_NOT_OPEN: open a shift on this counter first'
      USING ERRCODE = '55000';
  END IF;
  IF business_date IS NOT NULL AND s_date <> business_date THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_OTHER_DAY: the open shift is on another business day'
      USING ERRCODE = '23514';
  END IF;
  IF given_shift IS NOT NULL AND given_shift <> s_id THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: not the open shift of this drawer'
      USING ERRCODE = '23514';
  END IF;
  shift_id := s_id;
END $$;

-- The guards hold for every writer, whatever its table grants: the functions run as their owner,
-- with a fixed search path. Row-level security is forced on the tables they read, so they still see
-- only the writing session's organization. Only the guards call the helpers.
REVOKE ALL ON FUNCTION pharmacy_cash_shift_for(text, text, text, text, date, timestamp, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION pharmacy_cash_shift_expected(text, text, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION pharmacy_tender_cash_shift() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  attributed record;
BEGIN
  SELECT * INTO attributed FROM pharmacy_cash_shift_for(
    NEW."organizationId", NEW."branchId", NEW."drawerSessionId", NEW."deviceId", NEW."businessDate",
    NEW."soldAt", NEW."shiftId", NEW."lateArrivalShiftId", NULL);
  NEW."shiftId" := attributed.shift_id;
  NEW."lateArrivalShiftId" := attributed.late_shift_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_refund_cash_shift() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  attributed record;
BEGIN
  SELECT * INTO attributed FROM pharmacy_cash_shift_for(
    NEW."organizationId", NEW."branchId", NEW."drawerSessionId", NEW."deviceId", NEW."businessDate",
    NULL, NEW."shiftId", NEW."lateArrivalShiftId", NULL);
  NEW."shiftId" := attributed.shift_id;
  NEW."lateArrivalShiftId" := attributed.late_shift_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_drawer_movement_cash_shift() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  attributed record;
BEGIN
  SELECT * INTO attributed FROM pharmacy_cash_shift_for(
    NEW."organizationId", NULL, NEW."drawerSessionId", NULL, NULL, NULL,
    NEW."shiftId", NEW."lateArrivalShiftId",
    CASE WHEN NEW."kind" = 'CLOSING_COUNT' THEN NEW."amountMinor" END);
  NEW."shiftId" := attributed.shift_id;
  NEW."lateArrivalShiftId" := attributed.late_shift_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_tender_cash_shift ON "pharmacy_tenders";
CREATE TRIGGER pharmacy_tender_cash_shift
  BEFORE INSERT ON "pharmacy_tenders"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_tender_cash_shift();
DROP TRIGGER IF EXISTS pharmacy_refund_cash_shift ON "pharmacy_refunds";
CREATE TRIGGER pharmacy_refund_cash_shift
  BEFORE INSERT ON "pharmacy_refunds"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_refund_cash_shift();
DROP TRIGGER IF EXISTS pharmacy_drawer_movement_cash_shift ON "pharmacy_drawer_movements";
CREATE TRIGGER pharmacy_drawer_movement_cash_shift
  BEFORE INSERT ON "pharmacy_drawer_movements"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_drawer_movement_cash_shift();

-- The day close closes the business day only once every shift of that day at the branch is closed.
CREATE OR REPLACE FUNCTION pharmacy_daily_close_cash_shift_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "pharmacy_cash_shifts" s
     WHERE s."organizationId" = NEW."organizationId" AND s."branchId" = NEW."branchId"
       AND s."businessDate" = NEW."businessDate" AND s."status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_OPEN: close every shift of the day before the day'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_daily_close_cash_shift_guard ON "pharmacy_daily_closes";
CREATE TRIGGER pharmacy_daily_close_cash_shift_guard
  BEFORE INSERT ON "pharmacy_daily_closes"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_daily_close_cash_shift_guard();

COMMIT;
