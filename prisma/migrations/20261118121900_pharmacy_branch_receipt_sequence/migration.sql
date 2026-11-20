-- DEV-637: one receipt sequence per branch, so no two receipts of a branch share a number.
--
-- Until now each counter device kept its own sequence, so every new browser or PC started
-- again at "Receipt 1". From this migration on:
--   * every receipt number of a branch, online or offline, is drawn from
--     pharmacy_branch_receipt_sequences, one row per branch;
--   * an offline counter keeps leasing blocks, but each block is now carved out of that
--     branch sequence, so leases of different counters never overlap;
--   * pharmacy_sales.receiptNumberBranchUnique marks a receipt numbered under this rule
--     (set by trigger, never by the caller) and a partial unique index makes those
--     numbers unique per branch. A newly numbered receipt is also refused if an older
--     receipt of the branch already carries that number.
--   * an offline sale replayed from a block leased BEFORE this migration (the old per-device
--     range) whose printed number already belongs to a receipt of the branch is still
--     accepted: it gets a fresh branch number and keeps the printed number in
--     pharmacy_sales.offlineReceiptReference, fixed once issued.
-- Receipts issued before this migration keep their numbers and are never renumbered.
-- Where older data already repeats a number within a branch it stays as it is; a branch's
-- sequence starts above the highest number the branch has issued, leased or reserved.
-- New table gets row-level security.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_branch_receipt_sequences" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "nextNumber" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_branch_receipt_sequences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_branch_receipt_sequences_visibility_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_branch_receipt_sequences_next_check" CHECK ("nextNumber" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_branch_receipt_sequences_organizationId_id_key"
  ON "pharmacy_branch_receipt_sequences"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_branch_receipt_sequences_organizationId_branchId_key"
  ON "pharmacy_branch_receipt_sequences"("organizationId", "branchId");

-- The sequence only moves forward. A removed row is not a hazard: the next draw re-seeds
-- it above every number the branch has issued or leased.
CREATE OR REPLACE FUNCTION guard_pharmacy_branch_receipt_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."organizationId", NEW."branchId")
     IS DISTINCT FROM (OLD."id", OLD."organizationId", OLD."branchId") THEN
    RAISE EXCEPTION 'RECEIPT_SEQUENCE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW."nextNumber" < OLD."nextNumber" THEN
    RAISE EXCEPTION 'RECEIPT_SEQUENCE_REWIND' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pharmacy_branch_receipt_sequences_guard ON "pharmacy_branch_receipt_sequences";
CREATE TRIGGER pharmacy_branch_receipt_sequences_guard
  BEFORE UPDATE ON "pharmacy_branch_receipt_sequences"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_branch_receipt_sequence();

ALTER TABLE "pharmacy_branch_receipt_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_branch_receipt_sequences" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_branch_receipt_sequences";
CREATE POLICY tenant_branch_isolation ON "pharmacy_branch_receipt_sequences"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true))))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true))));

-- Existing receipts keep false and keep their numbers; only numbers issued from now on
-- carry the branch-wide guarantee.
ALTER TABLE "pharmacy_sales"
  ADD COLUMN IF NOT EXISTS "receiptNumberBranchUnique" BOOLEAN NOT NULL DEFAULT false;
-- The number an offline counter printed when the sale had to be renumbered on replay.
ALTER TABLE "pharmacy_sales"
  ADD COLUMN IF NOT EXISTS "offlineReceiptReference" INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_sales_offline_receipt_reference_check'
  ) THEN
    ALTER TABLE "pharmacy_sales"
      ADD CONSTRAINT "pharmacy_sales_offline_receipt_reference_check" CHECK (
        "offlineReceiptReference" IS NULL OR (
          "offlineReceiptReference" > 0
          AND "receiptNumber" IS NOT NULL
          AND "offlineReceiptReference" <> "receiptNumber"
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_sales_branch_receipt_number_key"
  ON "pharmacy_sales"("organizationId", "branchId", "receiptNumber")
  WHERE "receiptNumberBranchUnique";
CREATE INDEX IF NOT EXISTS "pharmacy_sales_legacy_receipt_number_idx"
  ON "pharmacy_sales"("organizationId", "branchId", "receiptNumber")
  WHERE "receiptNumber" IS NOT NULL AND NOT "receiptNumberBranchUnique";

-- The flag is the database's decision, not the caller's: a receipt numbered from now on is
-- always branch-unique, and an issued receipt's flag never changes. Older receipts are fixed
-- (nothing new is ever numbered without the flag), so checking against them cannot race.
CREATE OR REPLACE FUNCTION pharmacy_mark_branch_receipt_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."receiptNumber" IS NOT NULL THEN
    IF NEW."offlineReceiptReference" IS DISTINCT FROM OLD."offlineReceiptReference" THEN
      RAISE EXCEPTION 'ISSUED_RECEIPT_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    NEW."receiptNumberBranchUnique" := OLD."receiptNumberBranchUnique";
    RETURN NEW;
  END IF;
  NEW."receiptNumberBranchUnique" := NEW."receiptNumber" IS NOT NULL;
  IF NEW."receiptNumber" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "pharmacy_sales" issued
    WHERE issued."organizationId" = NEW."organizationId"
      AND issued."branchId" = NEW."branchId"
      AND issued."receiptNumber" = NEW."receiptNumber"
      AND issued."receiptNumber" IS NOT NULL
      AND NOT issued."receiptNumberBranchUnique"
      AND issued."id" <> NEW."id"
  ) THEN
    RAISE EXCEPTION 'RECEIPT_NUMBER_TAKEN' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pharmacy_sales_branch_receipt_number ON "pharmacy_sales";
CREATE TRIGGER pharmacy_sales_branch_receipt_number
  BEFORE INSERT OR UPDATE ON "pharmacy_sales"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_mark_branch_receipt_number();

-- Draws `p_count` consecutive numbers from the branch sequence and returns the first. The
-- first draw for a branch starts above everything the branch already issued, leased or
-- reserved under the old per-device sequences; ON CONFLICT serializes two first draws.
CREATE OR REPLACE FUNCTION pharmacy_allocate_branch_receipt_numbers(
  p_organization_id text,
  p_branch_id text,
  p_count integer
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  high_water integer;
  issued_floor integer;
BEGIN
  IF p_count IS NULL OR p_count < 1 THEN
    RAISE EXCEPTION 'RECEIPT_ALLOCATION_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE "pharmacy_branch_receipt_sequences"
  SET "nextNumber" = "nextNumber" + p_count, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "organizationId" = p_organization_id AND "branchId" = p_branch_id
  RETURNING "nextNumber" INTO high_water;

  IF high_water IS NULL THEN
    SELECT GREATEST(
      COALESCE((SELECT max(sale."receiptNumber") FROM "pharmacy_sales" sale
                WHERE sale."organizationId" = p_organization_id
                  AND sale."branchId" = p_branch_id), 0),
      COALESCE((SELECT max(lease."blockEnd") FROM "pharmacy_receipt_number_leases" lease
                WHERE lease."organizationId" = p_organization_id
                  AND lease."branchId" = p_branch_id), 0),
      COALESCE((SELECT max(device_sequence."nextNumber") - 1
                FROM "pharmacy_receipt_number_sequences" device_sequence
                WHERE device_sequence."organizationId" = p_organization_id
                  AND device_sequence."branchId" = p_branch_id), 0)
    ) INTO issued_floor;

    INSERT INTO "pharmacy_branch_receipt_sequences"
      ("id", "organizationId", "branchId", "nextNumber", "updatedAt")
    VALUES (gen_random_uuid()::text, p_organization_id, p_branch_id,
            issued_floor + 1 + p_count, CURRENT_TIMESTAMP)
    ON CONFLICT ("organizationId", "branchId") DO UPDATE
      SET "nextNumber" = "pharmacy_branch_receipt_sequences"."nextNumber" + p_count,
          "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "nextNumber" INTO high_water;
  END IF;

  RETURN high_water - p_count;
END;
$$;

-- A new lease must lie below the BRANCH sequence's high-water mark and overlap no other
-- lease of the branch, whichever counter holds it.
CREATE OR REPLACE FUNCTION guard_pharmacy_receipt_lease_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  high_water integer;
  overlapping integer;
BEGIN
  SELECT "nextNumber" INTO high_water
  FROM "pharmacy_branch_receipt_sequences"
  WHERE "organizationId" = NEW."organizationId"
    AND "branchId" = NEW."branchId"
  FOR UPDATE;

  IF high_water IS NULL THEN
    RAISE EXCEPTION 'RECEIPT_SEQUENCE_MISSING' USING ERRCODE = '55000';
  END IF;
  IF NEW."blockEnd" >= high_water THEN
    RAISE EXCEPTION 'RECEIPT_LEASE_NOT_RESERVED' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO overlapping
  FROM "pharmacy_receipt_number_leases" lease
  WHERE lease."organizationId" = NEW."organizationId"
    AND lease."branchId" = NEW."branchId"
    AND lease."id" <> NEW."id"
    AND lease."blockStart" <= NEW."blockEnd"
    AND lease."blockEnd" >= NEW."blockStart";
  IF overlapping > 0 THEN
    RAISE EXCEPTION 'RECEIPT_LEASE_OVERLAP' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
