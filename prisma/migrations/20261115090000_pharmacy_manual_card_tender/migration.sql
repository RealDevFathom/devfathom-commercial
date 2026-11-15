BEGIN;

-- DEV-713: a card taken on a standalone terminal is recorded as received
-- externally, with the slip's approval code and the confirming user. The
-- integrated provider path (any other provider) is unchanged.
ALTER TABLE pharmacy_tenders
  ADD COLUMN IF NOT EXISTS "approvalCode" TEXT,
  ADD COLUMN IF NOT EXISTS "confirmedById" TEXT;

-- Existing tender constraints, append-only guards and RLS remain in force.
-- NOT VALID: historical rows predate confirmer capture; every new row is checked.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pharmacy_manual_card_tender_capture_check'
      AND conrelid = 'pharmacy_tenders'::regclass
  ) THEN
    ALTER TABLE pharmacy_tenders ADD CONSTRAINT pharmacy_manual_card_tender_capture_check CHECK (
      (
        provider IS DISTINCT FROM 'MANUAL_TERMINAL' AND "approvalCode" IS NULL
      ) OR (
        -- Null-safe: a NULL provider must fail this branch, not make the CHECK NULL.
        type::text = 'CARD' AND provider IS NOT DISTINCT FROM 'MANUAL_TERMINAL'
        AND "providerRef" IS NOT NULL AND "providerRef" ~ '^[A-Za-z0-9]{4,24}$'
        AND "approvalCode" IS NOT NULL AND "approvalCode" ~ '^[A-Za-z0-9]{2,12}$'
        AND "confirmedById" IS NOT NULL AND "confirmedById" = "actorId"
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pharmacy_manual_wallet_tender_confirmer_check'
      AND conrelid = 'pharmacy_tenders'::regclass
  ) THEN
    ALTER TABLE pharmacy_tenders ADD CONSTRAINT pharmacy_manual_wallet_tender_confirmer_check CHECK (
      type::text NOT IN ('RAAST', 'JAZZCASH', 'EASYPAISA')
      OR ("confirmedById" IS NOT NULL AND "confirmedById" = "actorId")
    ) NOT VALID;
  END IF;
END $$;

COMMIT;
