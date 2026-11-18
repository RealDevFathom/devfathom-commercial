BEGIN;

-- DEV-743: the card-terminal router and counter states sit on the durable attempt record
-- (20261118120100_pharmacy_card_terminal_attempts). This adds the two database rules that
-- record does not hold on its own. Additive only: no existing row is changed. Manual Card and
-- Wallet tenders (DEV-713) keep their own providers and are not touched by either rule.

-- One terminal approval is at most one tender, even outside the attempt flow: a provider
-- reference repeats only on the manual, sandbox, prepaid and mock providers, whose references
-- are slip codes the cashier types (they may repeat), so those stay outside this index.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_tenders_terminal_provider_ref_key"
  ON "pharmacy_tenders" ("organizationId", "provider", "providerRef")
  WHERE "type" = 'CARD' AND "provider" IS NOT NULL AND "providerRef" IS NOT NULL
    AND "provider" NOT IN ('MOCK', 'MANUAL_TERMINAL', 'MANUAL_MERCHANT', 'LOCAL_TOKEN_SANDBOX',
      'CUSTOMER_PREPAID');

-- A business day is never closed while a terminal payment on it is still open (created, sent,
-- unknown, approved but not yet a tender, or waiting for review): the Z report would miss money
-- the customer may already have paid. The application refuses first, under the same day lock
-- the attempt is committed under; this is the database's own refusal.
CREATE OR REPLACE FUNCTION pharmacy_daily_close_card_terminal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "pharmacy_card_terminal_attempts" a
    WHERE a."organizationId" = NEW."organizationId" AND a."branchId" = NEW."branchId"
      AND a."businessDate" = NEW."businessDate"
      AND a."status" IN ('CREATED', 'SENT', 'UNKNOWN', 'APPROVED', 'MANUAL_REVIEW')
  ) THEN
    RAISE EXCEPTION 'a card-terminal payment is still open on this business day'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'pharmacy_daily_closes_card_terminal_guard'
  ) THEN
    CREATE TRIGGER pharmacy_daily_closes_card_terminal_guard
    BEFORE INSERT ON "pharmacy_daily_closes"
    FOR EACH ROW EXECUTE FUNCTION pharmacy_daily_close_card_terminal_guard();
  END IF;
END $$;

COMMIT;
