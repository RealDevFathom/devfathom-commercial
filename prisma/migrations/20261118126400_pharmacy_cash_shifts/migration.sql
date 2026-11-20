-- DEV-958B (phase 2 of DEV-958): cash shifts on a pharmacy drawer.
BEGIN;

-- The migration locks ten existing tables while it adds columns, constraints and triggers. Give up
-- rather than queue behind a long transaction (and hold every later writer behind this one): rerun
-- it in a quiet window.
SET LOCAL lock_timeout = '10s';

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

-- Before a provider is asked to move money (an integrated card or wallet charge or refund, and the
-- card-terminal preflight), the application asks whether this counter may take money now: on a
-- branch that runs shifts, its drawer's shift must be open on that business day. It raises exactly
-- what the insert would, and holds a share lock on the shift row until the transaction ends, so the
-- shift cannot close in between.
CREATE OR REPLACE FUNCTION pharmacy_require_cash_shift(org text, branch text, device text, business_date date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  attributed record;
BEGIN
  IF org IS DISTINCT FROM current_setting('app.current_organization_id', true) THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: another organization' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO attributed FROM pharmacy_cash_shift_for(
    org, branch, NULL, device, business_date, NULL, NULL, NULL, NULL);
  RETURN attributed.shift_id;
END $$;

-- Which receipt number an offline replay used, for which sale. A tender may carry a sale time (and
-- so land in the shift it was sold in, or on that shift as a late arrival) only when its sale has a
-- row here, written in the same transaction, for a number the transaction really consumed:
--   * a lease records the transaction that last moved its cursor forward. The database sets it on
--     every write; a cursor that does not move (a no-op update) records nothing;
--   * a consumption row is accepted only for the number just behind that cursor, inside the lease's
--     block, moved in this very transaction, by the lease's own counter and branch, for a sale of
--     that branch sold no earlier than the lease was issued. A number is consumed once, and a sale
--     once;
--   * the transaction is the top-level one (pg_current_xact_id), so a replay inside a savepoint
--     still matches;
--   * the replayed tender claims its sale's row, and that tender's cash movement claims it once.
-- The rows never change otherwise and are never deleted.
ALTER TABLE "pharmacy_receipt_number_leases" ADD COLUMN IF NOT EXISTS "lastAdvancedXact" BIGINT;

CREATE OR REPLACE FUNCTION pharmacy_receipt_lease_advanced_xact() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."lastAdvancedXact" := NULL;
    -- A lease is issued now, by the database's clock: a supplied time is ignored, so no lease
    -- can claim to predate a sale it never covered.
    NEW."issuedAt" := CURRENT_TIMESTAMP;
  ELSIF NEW."nextNumber" > OLD."nextNumber" THEN
    NEW."lastAdvancedXact" := pg_current_xact_id()::text::bigint;
  ELSE
    NEW."lastAdvancedXact" := OLD."lastAdvancedXact";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_receipt_lease_advanced_xact ON "pharmacy_receipt_number_leases";
CREATE TRIGGER pharmacy_receipt_lease_advanced_xact
  BEFORE INSERT OR UPDATE ON "pharmacy_receipt_number_leases"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_receipt_lease_advanced_xact();

-- A new lease is issued only for numbers the branch sequence handed out in the same transaction
-- (pharmacy_allocate_branch_receipt_numbers moves the sequence; the database records which numbers
-- it moved past, and in which transaction), and never over a number any sale of the branch already
-- carries. The lease guard of DEV-637 still checks the block lies below the sequence and overlaps
-- no other lease; this one runs after it.
ALTER TABLE "pharmacy_branch_receipt_sequences" ADD COLUMN IF NOT EXISTS "lastAllocatedFrom" INTEGER;
ALTER TABLE "pharmacy_branch_receipt_sequences" ADD COLUMN IF NOT EXISTS "lastAllocatedTo" INTEGER;
ALTER TABLE "pharmacy_branch_receipt_sequences" ADD COLUMN IF NOT EXISTS "lastAllocatedXact" BIGINT;

CREATE OR REPLACE FUNCTION pharmacy_branch_receipt_allocation_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A branch's first draw starts above everything it issued or leased; the guard below checks
    -- the numbers directly, so the start is left open.
    NEW."lastAllocatedFrom" := NULL;
    NEW."lastAllocatedTo" := NEW."nextNumber" - 1;
    NEW."lastAllocatedXact" := pg_current_xact_id()::text::bigint;
  ELSIF NEW."nextNumber" > OLD."nextNumber" THEN
    NEW."lastAllocatedFrom" := OLD."nextNumber";
    NEW."lastAllocatedTo" := NEW."nextNumber" - 1;
    NEW."lastAllocatedXact" := pg_current_xact_id()::text::bigint;
  ELSE
    NEW."lastAllocatedFrom" := OLD."lastAllocatedFrom";
    NEW."lastAllocatedTo" := OLD."lastAllocatedTo";
    NEW."lastAllocatedXact" := OLD."lastAllocatedXact";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_branch_receipt_allocation_stamp ON "pharmacy_branch_receipt_sequences";
CREATE TRIGGER pharmacy_branch_receipt_allocation_stamp
  BEFORE INSERT OR UPDATE ON "pharmacy_branch_receipt_sequences"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_branch_receipt_allocation_stamp();

CREATE OR REPLACE FUNCTION pharmacy_receipt_lease_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  sequence record;
BEGIN
  SELECT q."lastAllocatedFrom", q."lastAllocatedTo", q."lastAllocatedXact" INTO sequence
    FROM "pharmacy_branch_receipt_sequences" q
   WHERE q."organizationId" = NEW."organizationId" AND q."branchId" = NEW."branchId";
  IF NOT FOUND
     OR sequence."lastAllocatedXact" IS DISTINCT FROM pg_current_xact_id()::text::bigint
     OR NEW."blockEnd" > sequence."lastAllocatedTo"
     OR NEW."blockStart" < COALESCE(sequence."lastAllocatedFrom", NEW."blockStart") THEN
    RAISE EXCEPTION 'RECEIPT_LEASE_NOT_ALLOCATED: a lease covers only numbers this transaction drew from the branch sequence'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "pharmacy_sales" sale
     WHERE sale."organizationId" = NEW."organizationId" AND sale."branchId" = NEW."branchId"
       AND (sale."receiptNumber" BETWEEN NEW."blockStart" AND NEW."blockEnd"
            OR sale."offlineReceiptReference" BETWEEN NEW."blockStart" AND NEW."blockEnd")
  ) THEN
    RAISE EXCEPTION 'RECEIPT_LEASE_NUMBER_USED: a sale of the branch already carries a number of this block'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

-- Named to fire after the DEV-637 guard ("..._insert_guard"), whose refusals keep their words.
DROP TRIGGER IF EXISTS pharmacy_receipt_number_leases_same_transaction_guard ON "pharmacy_receipt_number_leases";
CREATE TRIGGER pharmacy_receipt_number_leases_same_transaction_guard
  BEFORE INSERT ON "pharmacy_receipt_number_leases"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_receipt_lease_allocation_guard();

CREATE TABLE IF NOT EXISTS "pharmacy_receipt_number_consumptions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "leaseId" TEXT NOT NULL,
  "receiptNumber" INTEGER NOT NULL,
  "saleId" TEXT NOT NULL,
  "soldAt" TIMESTAMP(3) NOT NULL,
  "consumedXact" BIGINT NOT NULL,
  "tenderId" TEXT,
  "cashMovementId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_receipt_number_consumptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_receipt_number_consumptions_lease_fkey" FOREIGN KEY ("organizationId", "leaseId")
    REFERENCES "pharmacy_receipt_number_leases"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_receipt_number_consumptions_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId")
    REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_receipt_number_consumptions_organizationId_id_key"
  ON "pharmacy_receipt_number_consumptions"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_receipt_number_consumptions_number_key"
  ON "pharmacy_receipt_number_consumptions"("organizationId", "leaseId", "receiptNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_receipt_number_consumptions_sale_key"
  ON "pharmacy_receipt_number_consumptions"("organizationId", "saleId");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_receipt_number_consumptions_tender_key"
  ON "pharmacy_receipt_number_consumptions"("organizationId", "tenderId");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_receipt_number_consumptions_movement_key"
  ON "pharmacy_receipt_number_consumptions"("organizationId", "cashMovementId");

ALTER TABLE "pharmacy_receipt_number_consumptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_receipt_number_consumptions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_receipt_number_consumptions";
CREATE POLICY tenant_isolation ON "pharmacy_receipt_number_consumptions"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

-- A used number's record never changes and is never deleted, except that the tender and movement
-- guards below claim it, once each. Those guards run as the table's owner (SECURITY DEFINER). This
-- guard runs as the caller (SECURITY INVOKER) and refuses any change made by another role: directly,
-- or from a trigger or function of the caller's own however deeply nested.
CREATE OR REPLACE FUNCTION pharmacy_receipt_number_consumption_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  owner_role name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = TG_RELID;
  IF TG_OP = 'DELETE'
     OR current_user IS DISTINCT FROM owner_role
     OR (NEW."id", NEW."organizationId", NEW."branchId", NEW."deviceId", NEW."leaseId",
         NEW."receiptNumber", NEW."saleId", NEW."soldAt", NEW."consumedXact", NEW."createdAt")
        IS DISTINCT FROM
        (OLD."id", OLD."organizationId", OLD."branchId", OLD."deviceId", OLD."leaseId",
         OLD."receiptNumber", OLD."saleId", OLD."soldAt", OLD."consumedXact", OLD."createdAt")
     OR (OLD."tenderId" IS NOT NULL AND NEW."tenderId" IS DISTINCT FROM OLD."tenderId")
     OR (OLD."cashMovementId" IS NOT NULL AND NEW."cashMovementId" IS DISTINCT FROM OLD."cashMovementId")
  THEN
    RAISE EXCEPTION 'PHARMACY_RECEIPT_CONSUMPTION_IMMUTABLE: a used receipt number stays recorded'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

-- A consumption is accepted only for the number this transaction moved its lease's cursor past.
CREATE OR REPLACE FUNCTION pharmacy_receipt_number_consumption_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  lease record;
  xact bigint := pg_current_xact_id()::text::bigint;
BEGIN
  IF NEW."tenderId" IS NOT NULL OR NEW."cashMovementId" IS NOT NULL THEN
    RAISE EXCEPTION 'PHARMACY_RECEIPT_CONSUMPTION_INVALID: a consumption is claimed by its tender'
      USING ERRCODE = '23514';
  END IF;
  SELECT l.* INTO lease FROM "pharmacy_receipt_number_leases" l
   WHERE l."organizationId" = NEW."organizationId" AND l."id" = NEW."leaseId"
   FOR UPDATE;
  IF NOT FOUND
     OR lease."branchId" IS DISTINCT FROM NEW."branchId"
     OR lease."deviceId" IS DISTINCT FROM NEW."deviceId"
     OR NEW."receiptNumber" NOT BETWEEN lease."blockStart" AND lease."blockEnd"
     OR lease."nextNumber" IS DISTINCT FROM NEW."receiptNumber" + 1
     OR lease."lastAdvancedXact" IS DISTINCT FROM xact
     OR lease."issuedAt" > NEW."soldAt" THEN
    RAISE EXCEPTION 'PHARMACY_RECEIPT_CONSUMPTION_INVALID: this transaction did not use that receipt number'
      USING ERRCODE = '23514';
  END IF;
  NEW."consumedXact" := xact;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_receipt_number_consumption_guard ON "pharmacy_receipt_number_consumptions";
CREATE TRIGGER pharmacy_receipt_number_consumption_guard
  BEFORE INSERT ON "pharmacy_receipt_number_consumptions"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_receipt_number_consumption_guard();
DROP TRIGGER IF EXISTS pharmacy_receipt_number_consumption_immutable ON "pharmacy_receipt_number_consumptions";
CREATE TRIGGER pharmacy_receipt_number_consumption_immutable
  BEFORE UPDATE OR DELETE ON "pharmacy_receipt_number_consumptions"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_receipt_number_consumption_immutable();

-- The attribution is the database's alone, and a late arrival is exactly what the application's own
-- offline path writes, nothing wider:
--   * a tender or refund never names its shift; the database sets it;
--   * a tender carries a sale time ("soldAt") only from an offline replay: its sale's receipt-number
--     consumption, for this counter and this sale time, was recorded in this transaction, and the
--     tender claims it (once), so a sale time cannot be written by hand to push a payment out of the
--     open shift;
--   * a drawer movement names a closed shift as a late arrival only for the cash of such a replayed
--     tender: a cash sale of the same amount on the same drawer and late shift, claiming that
--     tender's consumption (once). A paid-in, paid-out, refund or anything else never lands on a
--     closed shift.
CREATE OR REPLACE FUNCTION pharmacy_tender_cash_shift() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  attributed record;
BEGIN
  IF NEW."shiftId" IS NOT NULL OR NEW."lateArrivalShiftId" IS NOT NULL THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: the database chooses a tender''s shift'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."soldAt" IS NOT NULL THEN
    -- A replayed offline sale is settled in full by this one tender: never more (or less) than
    -- what its sale still owes, so no extra cash can ride on a used receipt number.
    IF NEW."amountMinor" IS DISTINCT FROM (
      SELECT COALESCE((SELECT sum(l."grossMinor" - l."discountMinor") FROM "pharmacy_sale_lines" l
                        WHERE l."organizationId" = NEW."organizationId" AND l."saleId" = NEW."saleId"), 0)
           - COALESCE((SELECT sum(t."amountMinor") FROM "pharmacy_tenders" t
                        WHERE t."organizationId" = NEW."organizationId" AND t."saleId" = NEW."saleId"), 0)
    ) THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: a replayed sale''s tender settles exactly what it owes'
        USING ERRCODE = '23514';
    END IF;
    UPDATE "pharmacy_receipt_number_consumptions" c SET "tenderId" = NEW."id"
     WHERE c."organizationId" = NEW."organizationId" AND c."saleId" = NEW."saleId"
       AND c."branchId" = NEW."branchId" AND c."deviceId" = NEW."deviceId"
       AND c."soldAt" = NEW."soldAt" AND c."tenderId" IS NULL
       AND c."consumedXact" = pg_current_xact_id()::text::bigint;
    IF NOT FOUND OR NEW."id" IS NULL THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: only an offline replay carries a sale time'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO attributed FROM pharmacy_cash_shift_for(
    NEW."organizationId", NEW."branchId", NEW."drawerSessionId", NEW."deviceId", NEW."businessDate",
    NEW."soldAt", NULL, NULL, NULL);
  NEW."shiftId" := attributed.shift_id;
  NEW."lateArrivalShiftId" := attributed.late_shift_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_refund_cash_shift() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  attributed record;
BEGIN
  IF NEW."shiftId" IS NOT NULL OR NEW."lateArrivalShiftId" IS NOT NULL THEN
    RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: the database chooses a refund''s shift'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO attributed FROM pharmacy_cash_shift_for(
    NEW."organizationId", NEW."branchId", NEW."drawerSessionId", NEW."deviceId", NEW."businessDate",
    NULL, NULL, NULL, NULL);
  NEW."shiftId" := attributed.shift_id;
  NEW."lateArrivalShiftId" := attributed.late_shift_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_drawer_movement_cash_shift() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  attributed record;
BEGIN
  IF NEW."lateArrivalShiftId" IS NOT NULL THEN
    IF NEW."kind" <> 'CASH_SALE' OR NEW."shiftId" IS NOT NULL OR NEW."id" IS NULL THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: only a replayed offline sale''s cash lands on a closed shift'
        USING ERRCODE = '23514';
    END IF;
    UPDATE "pharmacy_receipt_number_consumptions" c SET "cashMovementId" = NEW."id"
     WHERE c."id" = (
       SELECT c2."id" FROM "pharmacy_receipt_number_consumptions" c2
         JOIN "pharmacy_tenders" t ON t."organizationId" = c2."organizationId" AND t."id" = c2."tenderId"
        WHERE c2."organizationId" = NEW."organizationId" AND c2."cashMovementId" IS NULL
          AND c2."consumedXact" = pg_current_xact_id()::text::bigint
          AND t."drawerSessionId" = NEW."drawerSessionId"
          AND t."lateArrivalShiftId" = NEW."lateArrivalShiftId"
          AND t."type" = 'CASH' AND t."amountMinor" = NEW."amountMinor"
        ORDER BY c2."id" LIMIT 1
        FOR UPDATE OF c2);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PHARMACY_SHIFT_ATTRIBUTION_INVALID: only a replayed offline sale''s cash lands on a closed shift'
        USING ERRCODE = '23514';
    END IF;
  END IF;
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

-- A card-terminal attempt sends a real charge to a terminal. On a branch that runs shifts it is
-- written only while the counter's shift is open, under a share lock on that shift until the attempt
-- commits; from then on the open attempt keeps the shift from closing (cash-shifts.ts), so the charge
-- is always settled into that shift.
CREATE OR REPLACE FUNCTION pharmacy_card_terminal_attempt_cash_shift() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  attributed record;
BEGIN
  SELECT * INTO attributed FROM pharmacy_cash_shift_for(
    NEW."organizationId", NEW."branchId", NULL, NEW."deviceId", NEW."businessDate",
    NULL, NULL, NULL, NULL);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_card_terminal_attempt_cash_shift ON "pharmacy_card_terminal_attempts";
CREATE TRIGGER pharmacy_card_terminal_attempt_cash_shift
  BEFORE INSERT ON "pharmacy_card_terminal_attempts"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_card_terminal_attempt_cash_shift();

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
