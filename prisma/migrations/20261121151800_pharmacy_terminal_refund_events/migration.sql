BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TYPE "FinanceAccountCode" ADD VALUE IF NOT EXISTS 'CARD_REFUNDS_PAYABLE';
ALTER TYPE "FinanceSourceKind" ADD VALUE IF NOT EXISTS 'PHARMACY_TERMINAL_REFUND';

ALTER TABLE pharmacy_card_terminal_attempts
  ADD COLUMN IF NOT EXISTS "approvedAmountMinor" integer CHECK ("approvedAmountMinor" > 0 AND ("approvedAmountMinor" IS NULL OR "providerRef" IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_card_terminal_attempts_organizationId_branchId_id_key"
  ON pharmacy_card_terminal_attempts ("organizationId","branchId",id);

CREATE OR REPLACE FUNCTION pharmacy_terminal_approved_amount_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."approvedAmountMinor" IS DISTINCT FROM OLD."approvedAmountMinor" AND
    (OLD."approvedAmountMinor" IS NOT NULL OR OLD.status NOT IN ('SENT','UNKNOWN') OR
     NEW.status NOT IN ('MANUAL_REVIEW','APPROVED') OR NEW."providerRef" IS NULL) THEN
    RAISE EXCEPTION 'terminal approval amount is immutable evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER terminal_approved_amount_guard BEFORE UPDATE ON pharmacy_card_terminal_attempts
FOR EACH ROW EXECUTE FUNCTION pharmacy_terminal_approved_amount_guard();

CREATE TABLE IF NOT EXISTS pharmacy_terminal_refund_events (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL, "branchId" text NOT NULL, "attemptId" text NOT NULL,
  "refundId" text, "previousId" text UNIQUE, kind text NOT NULL CHECK (kind IN ('OWED','DECLINED','SETTLED')),
  "amountMinor" integer NOT NULL CHECK ("amountMinor">0),
  "remainingMinor" integer NOT NULL CHECK ("remainingMinor" >= 0),
  "settledOn" date, "selfApproved" boolean NOT NULL DEFAULT false,
  CHECK ((kind = 'SETTLED') = ("settledOn" IS NOT NULL)),
  CHECK (kind <> 'OWED' OR "remainingMinor" = "amountMinor"),
  CHECK (kind <> 'DECLINED' OR "remainingMinor" = 0),
  "actorId" text NOT NULL, reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 200),
  "slipRef" text NOT NULL CHECK ("slipRef" ~ '^[A-Za-z0-9._:/-]{1,64}$'),
  "roleIdentity" text, "roleRules" text[] NOT NULL, "secondApproverId" text CHECK ("secondApproverId" <> "actorId"),
  "ownerAuthority" boolean NOT NULL, "terminalConfirmed" boolean NOT NULL,
  "commandKey" text NOT NULL, "journalId" text UNIQUE, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","commandKey"),
  UNIQUE ("organizationId","branchId","attemptId",id),
  FOREIGN KEY ("organizationId","branchId","attemptId") REFERENCES pharmacy_card_terminal_attempts ("organizationId","branchId",id),
  FOREIGN KEY ("organizationId","branchId","attemptId","previousId") REFERENCES pharmacy_terminal_refund_events ("organizationId","branchId","attemptId",id),
  FOREIGN KEY ("organizationId","refundId") REFERENCES pharmacy_refunds ("organizationId",id),
  FOREIGN KEY ("organizationId","journalId") REFERENCES finance_journal_entries ("organizationId",id),
  CHECK (concat_ws(' ',reason,"slipRef") !~ '[0-9]{13,}'),
  CHECK (kind = 'DECLINED' OR "journalId" IS NOT NULL),
  CHECK (kind <> 'SETTLED' OR "previousId" IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS terminal_review_root ON pharmacy_terminal_refund_events ("attemptId")
  WHERE "previousId" IS NULL AND "refundId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS terminal_refund_root ON pharmacy_terminal_refund_events ("refundId")
  WHERE "previousId" IS NULL AND "refundId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS terminal_refund_branch ON pharmacy_terminal_refund_events ("organizationId","branchId","attemptId");
ALTER TABLE pharmacy_terminal_refund_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_terminal_refund_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terminal_refund_scope ON pharmacy_terminal_refund_events;
CREATE POLICY terminal_refund_scope ON pharmacy_terminal_refund_events USING (
  "organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND
  (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))
);
CREATE OR REPLACE FUNCTION pharmacy_terminal_refund_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'card terminal refund events are append-only' USING ERRCODE='55000';
END $$;
CREATE OR REPLACE TRIGGER terminal_refund_immutable BEFORE UPDATE OR DELETE ON pharmacy_terminal_refund_events
  FOR EACH ROW EXECUTE FUNCTION pharmacy_terminal_refund_immutable();

-- An event must reference the same branch, tender and amount as its source refund.
-- Posting and event are written in the same transaction, with the journal first.
CREATE OR REPLACE FUNCTION pharmacy_terminal_refund_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."refundId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pharmacy_refunds r JOIN pharmacy_card_terminal_attempts a ON
      a."organizationId" = r."organizationId" AND a."branchId" = r."branchId" AND a."tenderId" = r."originalTenderId"
    WHERE r.id = NEW."refundId" AND r."organizationId" = NEW."organizationId" AND r."branchId" = NEW."branchId"
      AND a.id = NEW."attemptId" AND (NEW.kind = 'SETTLED' OR r."amountMinor" = NEW."amountMinor")
  ) THEN RAISE EXCEPTION 'refund does not belong to this terminal payment'; END IF;
  IF NEW."refundId" IS NOT NULL AND NEW.kind = 'DECLINED' AND NOT EXISTS (
    SELECT 1 FROM pharmacy_terminal_refund_events root JOIN finance_journal_entries undo
      ON undo."organizationId" = root."organizationId" AND undo."reversesEntryId" = root."journalId"
    WHERE root.id=NEW."previousId" AND root."refundId"=NEW."refundId" AND root.kind='OWED'
      AND root."previousId" IS NULL AND root."branchId"=NEW."branchId" AND undo.id=NEW."journalId"
  ) THEN RAISE EXCEPTION 'tender refund correction requires the linked journal reversal'; END IF;
  IF NEW.kind = 'SETTLED' AND NOT EXISTS (
    SELECT 1 FROM pharmacy_terminal_refund_events e WHERE e.id = NEW."previousId"
    AND e.kind IN ('OWED','SETTLED') AND e."remainingMinor" = NEW."remainingMinor"::bigint + NEW."amountMinor"
  ) THEN RAISE EXCEPTION 'settlement exceeds or disagrees with the remaining obligation'; END IF;
  IF NEW."journalId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finance_journal_lines l WHERE l."organizationId"=NEW."organizationId"
    AND l."entryId"=NEW."journalId" AND l."accountCode"::text='CARD_REFUNDS_PAYABLE'
    AND l.side::text = CASE WHEN NEW.kind='OWED' THEN 'CREDIT' ELSE 'DEBIT' END
  ) THEN RAISE EXCEPTION 'use the dedicated provider refund liability'; END IF;
  IF NEW."journalId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finance_journal_entries j
    JOIN finance_journal_lines l ON l."organizationId" = j."organizationId" AND l."entryId" = j.id
    WHERE j.id = NEW."journalId" AND j."organizationId" = NEW."organizationId" AND j."branchId" = NEW."branchId"
      AND j."sourceKind"::text = 'PHARMACY_TERMINAL_REFUND'
      AND (j."sourceId" = NEW.id OR j."reversesEntryId" = (
        SELECT e."journalId" FROM pharmacy_terminal_refund_events e WHERE e.id = NEW."previousId"
      ))
    GROUP BY j.id HAVING count(*) = 2 AND bool_and(l."amountMinor" = NEW."amountMinor")
  ) THEN RAISE EXCEPTION 'terminal refund must reference its balanced journal posting'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER terminal_refund_source_guard BEFORE INSERT ON pharmacy_terminal_refund_events
  FOR EACH ROW EXECUTE FUNCTION pharmacy_terminal_refund_source_guard();

-- Keep the original tender lock and cap. Only a linked, posted cancellation
-- releases its reserved amount. The original refund and posting remain intact.
CREATE OR REPLACE FUNCTION pharmacy_guard_refund_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tendered integer; refunded bigint;
BEGIN
  SELECT "amountMinor" INTO tendered FROM pharmacy_tenders
    WHERE "organizationId"=NEW."organizationId" AND id=NEW."originalTenderId" FOR UPDATE;
  SELECT COALESCE(SUM(r."amountMinor"),0) INTO refunded FROM pharmacy_refunds r
    WHERE r."organizationId"=NEW."organizationId" AND r."originalTenderId"=NEW."originalTenderId"
      AND NOT EXISTS (SELECT 1 FROM pharmacy_terminal_refund_events e WHERE
        e."organizationId"=r."organizationId" AND e."branchId"=r."branchId" AND e."refundId"=r.id
        AND e.kind='DECLINED' AND e."journalId" IS NOT NULL AND e."previousId" IS NOT NULL);
  IF tendered IS NULL OR refunded+NEW."amountMinor">tendered THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_TENDER' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
