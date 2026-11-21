ALTER TYPE "FinanceAccountCode" ADD VALUE 'CARD_REFUNDS_PAYABLE';
ALTER TYPE "FinanceSourceKind" ADD VALUE 'PHARMACY_TERMINAL_REFUND';

ALTER TABLE organizations
  ADD COLUMN "terminalRefundAccount" "FinanceAccountCode",
  ADD COLUMN "usesCustomFinanceChart" boolean NOT NULL DEFAULT false;
ALTER TABLE pharmacy_card_terminal_attempts
  ADD COLUMN "approvedAmountMinor" integer CHECK ("approvedAmountMinor" > 0 AND ("approvedAmountMinor" IS NULL OR "providerRef" IS NOT NULL)),
  ADD UNIQUE ("organizationId","branchId",id);

CREATE FUNCTION pharmacy_terminal_approved_amount_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."approvedAmountMinor" IS DISTINCT FROM OLD."approvedAmountMinor" AND
    (OLD."approvedAmountMinor" IS NOT NULL OR OLD.status NOT IN ('SENT','UNKNOWN') OR
     NEW.status NOT IN ('MANUAL_REVIEW','APPROVED') OR NEW."providerRef" IS NULL) THEN
    RAISE EXCEPTION 'terminal approval amount is immutable evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER terminal_approved_amount_guard BEFORE UPDATE ON pharmacy_card_terminal_attempts
FOR EACH ROW EXECUTE FUNCTION pharmacy_terminal_approved_amount_guard();

CREATE TABLE pharmacy_terminal_refund_events (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL, "branchId" text NOT NULL, "attemptId" text NOT NULL,
  "refundId" text, "previousId" text UNIQUE, kind text NOT NULL CHECK (kind IN ('OWED','DECLINED','SETTLED')),
  "amountMinor" integer NOT NULL CHECK ("amountMinor">0),
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
CREATE UNIQUE INDEX terminal_review_root ON pharmacy_terminal_refund_events ("attemptId")
  WHERE "previousId" IS NULL AND "refundId" IS NULL;
CREATE UNIQUE INDEX terminal_refund_root ON pharmacy_terminal_refund_events ("refundId")
  WHERE "previousId" IS NULL AND "refundId" IS NOT NULL;
CREATE INDEX terminal_refund_branch ON pharmacy_terminal_refund_events ("organizationId","branchId","attemptId");
ALTER TABLE pharmacy_terminal_refund_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_terminal_refund_events FORCE ROW LEVEL SECURITY;
CREATE POLICY terminal_refund_scope ON pharmacy_terminal_refund_events USING (
  "organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND
  (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))
);
CREATE FUNCTION pharmacy_terminal_refund_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'card terminal refund events are append-only' USING ERRCODE='55000';
END $$;
CREATE TRIGGER terminal_refund_immutable BEFORE UPDATE OR DELETE ON pharmacy_terminal_refund_events
  FOR EACH ROW EXECUTE FUNCTION pharmacy_terminal_refund_immutable();


-- An event must reference the same branch, tender and amount as its source refund.
-- Posting and event are written in the same transaction, with the journal first.
CREATE FUNCTION pharmacy_terminal_refund_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."refundId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pharmacy_refunds r JOIN pharmacy_card_terminal_attempts a ON
      a."organizationId" = r."organizationId" AND a."branchId" = r."branchId" AND a."tenderId" = r."originalTenderId"
    WHERE r.id = NEW."refundId" AND r."organizationId" = NEW."organizationId" AND r."branchId" = NEW."branchId"
      AND a.id = NEW."attemptId" AND r."amountMinor" = NEW."amountMinor"
  ) THEN RAISE EXCEPTION 'refund does not belong to this terminal payment'; END IF;
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
CREATE TRIGGER terminal_refund_source_guard BEFORE INSERT ON pharmacy_terminal_refund_events
  FOR EACH ROW EXECUTE FUNCTION pharmacy_terminal_refund_source_guard();
