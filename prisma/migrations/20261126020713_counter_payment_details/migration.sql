BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE pharmacy_branches ADD COLUMN IF NOT EXISTS "requirePaymentDetails" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pharmacy_tenders DROP CONSTRAINT IF EXISTS pharmacy_manual_card_tender_capture_check;
ALTER TABLE pharmacy_tenders ADD CONSTRAINT pharmacy_manual_card_tender_capture_check CHECK (
  (provider IS DISTINCT FROM 'MANUAL_TERMINAL' AND "approvalCode" IS NULL)
  OR (type::text = 'CARD' AND provider IS NOT DISTINCT FROM 'MANUAL_TERMINAL'
    AND ("providerRef" IS NULL OR ("providerRef" ~ '^[A-Za-z0-9]{4,24}$' AND "providerRef" !~ '^[0-9]{13,}$'))
    AND ("approvalCode" IS NULL OR "approvalCode" ~ '^[A-Za-z0-9]{2,12}$')
    AND "confirmedById" IS NOT NULL AND "confirmedById" = "actorId")
) NOT VALID;

CREATE OR REPLACE FUNCTION pharmacy_check_manual_tender_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings JSONB;
        required BOOLEAN;
BEGIN
  IF NEW.type::text IN ('RAAST', 'JAZZCASH', 'EASYPAISA', 'BANK_TRANSFER')
     OR (NEW.type::text = 'CARD' AND NEW.provider = 'MANUAL_TERMINAL') THEN
    SELECT "manualPaymentSettings", "requirePaymentDetails" INTO STRICT settings, required
      FROM pharmacy_branches WHERE id = NEW."branchId" AND "organizationId" = NEW."organizationId" AND active FOR SHARE;
    IF NEW.type::text IN ('RAAST', 'JAZZCASH', 'EASYPAISA') THEN
      IF settings -> NEW.type::text IS NULL OR settings -> NEW.type::text = 'null'::jsonb THEN
        RAISE EXCEPTION 'manual merchant tender is not configured for this branch' USING ERRCODE = '23514';
      END IF;
      IF NEW."referenceSkipped" AND (required OR NEW."soldAt" IS NOT NULL)
         AND COALESCE(settings -> NEW.type::text ->> 'allowReferenceSkip', 'false') <> 'true' THEN
        RAISE EXCEPTION 'manual merchant tender reference is required' USING ERRCODE = '23514';
      END IF;
    ELSIF required AND (NULLIF(btrim(NEW."providerRef"), '') IS NULL
             OR (NEW.type::text = 'CARD' AND NEW."approvalCode" IS NULL)) THEN
      RAISE EXCEPTION 'This branch requires payment details.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
