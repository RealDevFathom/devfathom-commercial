BEGIN;

-- DEV-743: a card-terminal attempt in MANUAL_REVIEW is resolved by a manager or owner with their
-- own fresh PIN, to one of the two outcomes the lifecycle already allows:
--   DECLINED  nothing was charged (the attempt carries no charge evidence); the sale may take
--             another tender.
--   REVERSED  the terminal took the money; the charge is recorded for a refund through the
--             provider's own process, and the sale may take another tender.
-- Either way the person records why and the provider reference printed on the terminal slip.
-- This adds those two fields and makes the database require them on a resolution. Additive
-- only: no existing row is changed, and every earlier rule of the attempt guard is kept.
-- No card number, CVV, track, PIN, expiry or secret is ever stored.

ALTER TABLE "pharmacy_card_terminal_attempts" ADD COLUMN IF NOT EXISTS "resolutionReason" TEXT;
ALTER TABLE "pharmacy_card_terminal_attempts" ADD COLUMN IF NOT EXISTS "resolutionRef" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pharmacy_card_terminal_attempts_resolution_no_pan_check'
  ) THEN
    -- The same card-number refusal as every other stored text on the attempt.
    ALTER TABLE "pharmacy_card_terminal_attempts"
      ADD CONSTRAINT "pharmacy_card_terminal_attempts_resolution_no_pan_check"
      CHECK (concat_ws(' ', "resolutionReason", "resolutionRef") !~ '[0-9]{13,}');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pharmacy_card_terminal_attempts_resolution_check'
  ) THEN
    -- A recorded resolution is always complete: who, why and the slip reference together.
    ALTER TABLE "pharmacy_card_terminal_attempts"
      ADD CONSTRAINT "pharmacy_card_terminal_attempts_resolution_check" CHECK (
        ("resolutionReason" IS NULL AND "resolutionRef" IS NULL) OR (
          "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL AND
          "status" IN ('DECLINED', 'REVERSED') AND
          length(btrim("resolutionReason")) BETWEEN 3 AND 200 AND
          "resolutionRef" ~ '^[A-Za-z0-9._:/-]{1,64}$'
        )
      );
  END IF;
END $$;

-- The attempt guard from 20261118120100, unchanged, plus the resolution rules marked DEV-743
-- review below.
CREATE OR REPLACE FUNCTION pharmacy_card_terminal_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy card-terminal attempts are never deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'CREATED' OR NEW."sentAt" IS NOT NULL OR NEW."providerRef" IS NOT NULL
      OR NEW."tenderId" IS NOT NULL OR NEW."statusChecks" <> 0
      -- DEV-743 review: an attempt starts unresolved.
      OR NEW."resolvedById" IS NOT NULL OR NEW."resolutionReason" IS NOT NULL
      OR NEW."resolutionRef" IS NOT NULL THEN
      RAISE EXCEPTION 'a pharmacy card-terminal attempt starts CREATED and unsent'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."organizationId", NEW."branchId", NEW."saleId", NEW."deviceId",
      NEW."terminalId", NEW."provider", NEW."attemptKey", NEW."amountMinor", NEW."currency",
      NEW."businessDate", NEW."actorId", NEW."createdAt")
      IS DISTINCT FROM
     (OLD."id", OLD."organizationId", OLD."branchId", OLD."saleId", OLD."deviceId",
      OLD."terminalId", OLD."provider", OLD."attemptKey", OLD."amountMinor", OLD."currency",
      OLD."businessDate", OLD."actorId", OLD."createdAt") THEN
    RAISE EXCEPTION 'a pharmacy card-terminal attempt identity never changes'
      USING ERRCODE = '55000';
  END IF;
  IF (OLD."providerRef" IS NOT NULL AND NEW."providerRef" IS DISTINCT FROM OLD."providerRef")
    OR (OLD."approvalCode" IS NOT NULL AND NEW."approvalCode" IS DISTINCT FROM OLD."approvalCode")
    OR (OLD."cardBrand" IS NOT NULL AND NEW."cardBrand" IS DISTINCT FROM OLD."cardBrand")
    OR (OLD."cardLast4" IS NOT NULL AND NEW."cardLast4" IS DISTINCT FROM OLD."cardLast4")
    OR (OLD."sentAt" IS NOT NULL AND NEW."sentAt" IS DISTINCT FROM OLD."sentAt") THEN
    RAISE EXCEPTION 'pharmacy card-terminal evidence is written once' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD."status" = 'CREATED' AND NEW."status" IN ('SENT', 'ABANDONED')) OR
    (OLD."status" = 'SENT' AND NEW."status" IN ('APPROVED', 'DECLINED', 'UNKNOWN', 'MANUAL_REVIEW')) OR
    (OLD."status" = 'UNKNOWN' AND NEW."status" IN ('UNKNOWN', 'APPROVED', 'DECLINED', 'MANUAL_REVIEW')) OR
    (OLD."status" = 'APPROVED' AND NEW."status" IN ('SETTLED', 'MANUAL_REVIEW')) OR
    (OLD."status" = 'MANUAL_REVIEW' AND NEW."status" IN ('DECLINED', 'REVERSED'))
  ) THEN
    RAISE EXCEPTION 'pharmacy card-terminal attempt cannot move from % to %',
      OLD."status", NEW."status" USING ERRCODE = '55000';
  END IF;
  -- "Never charged" can never be recorded for an attempt that carries charge evidence.
  IF NEW."status" = 'DECLINED' AND NEW."providerRef" IS NOT NULL THEN
    RAISE EXCEPTION 'an approved pharmacy card-terminal charge cannot be marked declined'
      USING ERRCODE = '55000';
  END IF;
  -- DEV-743 review: the resolver, reason and slip reference are written once, and only by the
  -- resolution of a manual review.
  IF (OLD."resolvedById" IS NOT NULL OR OLD."resolutionReason" IS NOT NULL
      OR OLD."resolutionRef" IS NOT NULL OR NOT (
        OLD."status" = 'MANUAL_REVIEW' AND NEW."status" IN ('DECLINED', 'REVERSED')
      ))
    AND (NEW."resolvedById", NEW."resolutionReason", NEW."resolutionRef")
      IS DISTINCT FROM (OLD."resolvedById", OLD."resolutionReason", OLD."resolutionRef") THEN
    RAISE EXCEPTION 'a pharmacy card-terminal review is resolved once' USING ERRCODE = '55000';
  END IF;
  -- DEV-743 review: a person resolves a manual review, and always says who, why and which slip.
  -- (A reversal with no resolver at all is refused by the review check constraint.)
  IF OLD."status" = 'MANUAL_REVIEW' AND NOT (NEW."status" = 'REVERSED' AND NEW."resolvedById" IS NULL)
    AND (
      NEW."resolvedById" IS NULL OR NEW."resolvedAt" IS NULL OR
      length(btrim(coalesce(NEW."resolutionReason", ''))) NOT BETWEEN 3 AND 200 OR
      coalesce(NEW."resolutionRef", '') !~ '^[A-Za-z0-9._:/-]{1,64}$'
    ) THEN
    RAISE EXCEPTION 'a pharmacy card-terminal review needs its resolver, reason and slip reference'
      USING ERRCODE = '55000';
  END IF;
  -- DEV-743 review: a reversal records the charge it reverses: the slip shows that reference.
  IF OLD."status" = 'MANUAL_REVIEW' AND NEW."status" = 'REVERSED' AND NEW."resolvedById" IS NOT NULL
    AND NEW."providerRef" IS DISTINCT FROM NEW."resolutionRef" THEN
    RAISE EXCEPTION 'a reversed pharmacy card-terminal charge must match its slip reference'
      USING ERRCODE = '55000';
  END IF;
  -- A settled attempt points at the one CARD tender that records this exact approval.
  IF NEW."status" = 'SETTLED' AND NOT EXISTS (
    SELECT 1 FROM "pharmacy_tenders" t
    WHERE t."organizationId" = NEW."organizationId" AND t."id" = NEW."tenderId"
      AND t."saleId" = NEW."saleId" AND t."branchId" = NEW."branchId" AND t."type" = 'CARD'
      AND t."provider" = NEW."provider" AND t."providerRef" = NEW."providerRef"
      AND t."amountMinor" = NEW."amountMinor"
  ) THEN
    RAISE EXCEPTION 'a settled pharmacy card-terminal attempt must match its tender'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
