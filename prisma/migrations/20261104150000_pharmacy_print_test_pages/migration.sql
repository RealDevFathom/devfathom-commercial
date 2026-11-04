-- DEV-742 — explicit thermal test-page jobs on the DEV-741 print queue.
--
-- A TEST_PAGE job proves a branch's bridge -> host -> printer path without a
-- sale. It carries no sale, receipt number or reprint flag, so it can never be
-- read as (or counted as) a receipt original. Claim, acknowledgement, retry,
-- expiry and paper-check rules are the receipt rules, unchanged.
--
-- Additive: one enum, one defaulted column, two relaxed NOT NULLs guarded by a
-- kind CHECK, and the immutability trigger extended to cover "kind". Existing
-- rows are RECEIPT jobs and still satisfy every constraint.

CREATE TYPE "PharmacyPrintJobKind" AS ENUM ('RECEIPT', 'TEST_PAGE');

ALTER TABLE "pharmacy_print_jobs"
  ADD COLUMN "kind" "PharmacyPrintJobKind" NOT NULL DEFAULT 'RECEIPT',
  ALTER COLUMN "saleId" DROP NOT NULL,
  ALTER COLUMN "receiptNumber" DROP NOT NULL,
  ADD CONSTRAINT "pharmacy_print_jobs_kind_check" CHECK (
    ("kind" = 'RECEIPT' AND "saleId" IS NOT NULL AND "receiptNumber" IS NOT NULL)
    OR ("kind" = 'TEST_PAGE' AND "saleId" IS NULL AND "receiptNumber" IS NULL
        AND "reprint" = false AND "idempotencyKey" LIKE 'test:%')
  );

-- Same function name and trigger as DEV-741; "kind" joins the immutable identity.
CREATE OR REPLACE FUNCTION guard_pharmacy_print_job_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."organizationId", NEW."branchId", NEW."bridgeId", NEW."printerId", NEW."saleId",
      NEW."receiptNumber", NEW."reprint", NEW."idempotencyKey", NEW."document",
      NEW."byteCount", NEW."paperWidth", NEW."requestedByActorId", NEW."createdAt", NEW."kind")
     IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."bridgeId", OLD."printerId", OLD."saleId",
      OLD."receiptNumber", OLD."reprint", OLD."idempotencyKey", OLD."document",
      OLD."byteCount", OLD."paperWidth", OLD."requestedByActorId", OLD."createdAt", OLD."kind") THEN
    RAISE EXCEPTION 'PRINT_JOB_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW."attemptCount" < OLD."attemptCount" THEN
    RAISE EXCEPTION 'PRINT_JOB_ATTEMPTS_MONOTONIC' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'TRANSPORT_ACCEPTED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'PRINT_JOB_ALREADY_ACCEPTED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
