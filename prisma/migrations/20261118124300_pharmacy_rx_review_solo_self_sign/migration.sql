BEGIN;

-- DEV-950: a pharmacist working alone may sign the RX-03 review of a prescription line they rang
-- up themselves, under the solo rule (owner decision on DEV-622, 15 Nov 2026: "Controls that need
-- a second person keep the solo rule: self-approval with a fresh PIN and an audit record").
--
-- The application writes that self-signature only through one path
-- (`pharmacyDispensing.selfSignReview`): the person holds the dispensing right, nobody else at the
-- branch with a working PIN holds it, and the person re-entered their own PIN. In the same
-- transaction it first writes an audit_logs entry marked self-approved (who, when, which sale and
-- line), then the SIGN decision naming that entry in "selfApprovalAuditId".
--
-- The database rule that refused every decision by the requester
-- (20260902170000, pharmacy_rx_reject_review_self_approval) is narrowed only as far as that:
--   * a requester's decision is still refused unless it is a SIGN carrying the marker, the marker
--     names a SUCCESS audit entry of this organization by this same person, for this review item
--     and this sale line, recorded as self-approved with a verified PIN, and no other decision
--     already uses that entry;
--   * a controlled medicine's line is never self-signed: its review is signed by the independent
--     pharmacist who witnesses the controlled register, and that rule is unchanged;
--   * any other decision carrying a marker is refused, so the marker cannot be put on a
--     signature by someone else.
-- Additive: no existing row changes. Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, CREATE OR REPLACE FUNCTION (the trigger already calls this function by name). The table
-- keeps its row-level security, append-only trigger and policies.

ALTER TABLE "pharmacy_pharmacist_review_decisions" ADD COLUMN IF NOT EXISTS "selfApprovalAuditId" TEXT;

-- One audit entry vouches for one self-signature only.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_review_decisions_self_approval_audit_key"
  ON "pharmacy_pharmacist_review_decisions" ("organizationId", "selfApprovalAuditId")
  WHERE "selfApprovalAuditId" IS NOT NULL;

CREATE OR REPLACE FUNCTION pharmacy_rx_reject_review_self_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester text; review_sale_line text;
BEGIN
  SELECT "requestedByUserId", "saleLineId" INTO requester, review_sale_line
    FROM "pharmacy_pharmacist_review_items"
   WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."reviewItemId";
  IF NEW."actorUserId" IS DISTINCT FROM requester THEN
    -- DEV-950: the self-approval marker belongs only on the requester's own signature.
    IF NEW."selfApprovalAuditId" IS NOT NULL THEN
      RAISE EXCEPTION 'a self-approval marker is only for the requester''s own signature' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  -- The requester's own decision: refused unless it is the audited solo self-signature.
  IF NEW."kind" <> 'SIGN' OR NEW."signedAt" IS NULL OR NEW."selfApprovalAuditId" IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM "audit_logs" a
        WHERE a."id" = NEW."selfApprovalAuditId"
          AND a."organizationId" = NEW."organizationId"
          AND a."actorId" = NEW."actorUserId"
          AND a."action" = 'pharmacyDispensing.selfSignReview'
          AND a."outcome" = 'SUCCESS'
          AND a."targetId" = NEW."reviewItemId"
          AND a."metadata"->>'selfApproved' = 'true'
          AND a."metadata"->>'pinVerified' = 'true'
          AND a."metadata"->>'reviewItemId' = NEW."reviewItemId"
          AND a."metadata"->>'saleLineId' = review_sale_line
     ) THEN
    RAISE EXCEPTION 'requesting cashier cannot approve pharmacist-required line' USING ERRCODE='42501';
  END IF;
  -- Fail closed: the line must be found, with a medicine that is not controlled.
  IF NOT EXISTS (
    SELECT 1 FROM "pharmacy_sale_lines" l
      JOIN "pharmacy_medicines" m ON m."id" = l."medicineId"
     WHERE l."organizationId" = NEW."organizationId" AND l."id" = review_sale_line
       AND m."controlled" = false
  ) THEN
    RAISE EXCEPTION 'a controlled medicine needs an independent pharmacist signature' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
