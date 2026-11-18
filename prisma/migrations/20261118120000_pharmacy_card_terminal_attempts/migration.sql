BEGIN;

-- DEV-743: the one durable payment-attempt record for an integrated card terminal. A row is
-- committed before a terminal can send a charge, so a crash, timeout or lost response always
-- leaves something to recover from. Manual "received externally" Card and Wallet tenders
-- (DEV-713) never use this table and are unchanged. Additive only: no existing row is changed.
-- No card number, CVV, track, PIN, expiry or secret is ever stored here.

DO $$ BEGIN
  CREATE TYPE "PharmacyCardTerminalAttemptStatus" AS ENUM (
    'CREATED', 'SENT', 'UNKNOWN', 'APPROVED', 'SETTLED', 'DECLINED', 'ABANDONED',
    'MANUAL_REVIEW', 'REVERSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "pharmacy_card_terminal_attempts" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "terminalId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "attemptKey" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "businessDate" DATE NOT NULL,
  "status" "PharmacyCardTerminalAttemptStatus" NOT NULL DEFAULT 'CREATED',
  "providerRef" TEXT,
  "approvalCode" TEXT,
  "cardBrand" TEXT,
  "cardLast4" TEXT,
  "declineCode" TEXT,
  "statusChecks" INTEGER NOT NULL DEFAULT 0,
  "tenderId" TEXT,
  "reviewReason" TEXT,
  "resolvedById" TEXT,
  "actorId" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_card_terminal_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_card_terminal_attempts_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "pharmacy_card_terminal_attempts_status_checks_check" CHECK ("statusChecks" >= 0),
  CONSTRAINT "pharmacy_card_terminal_attempts_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "pharmacy_card_terminal_attempts_key_check"
    CHECK ("attemptKey" ~ '^[A-Za-z0-9:_-]{8,128}$'),
  -- A terminal provider never reuses a manual, sandbox, prepaid or mock provider name, so a
  -- tender can always be told apart from the manual Card and Wallet tenders.
  CONSTRAINT "pharmacy_card_terminal_attempts_provider_check" CHECK (
    "provider" ~ '^[A-Z][A-Z0-9_]{1,47}$' AND
    "provider" NOT IN ('MOCK', 'MANUAL_TERMINAL', 'MANUAL_MERCHANT', 'LOCAL_TOKEN_SANDBOX',
      'CUSTOMER_PREPAID')
  ),
  -- Only truncated card data: a brand and the last four digits. Nothing that holds a run of 13
  -- or more digits (a possible card number) is ever stored.
  CONSTRAINT "pharmacy_card_terminal_attempts_last4_check"
    CHECK ("cardLast4" IS NULL OR "cardLast4" ~ '^[0-9]{4}$'),
  CONSTRAINT "pharmacy_card_terminal_attempts_brand_check"
    CHECK ("cardBrand" IS NULL OR "cardBrand" ~ '^[A-Z][A-Z_]{1,23}$'),
  CONSTRAINT "pharmacy_card_terminal_attempts_no_pan_check" CHECK (
    concat_ws(' ', "terminalId", "providerRef", "approvalCode", "declineCode", "reviewReason")
      !~ '[0-9]{13,}'
  ),
  CONSTRAINT "pharmacy_card_terminal_attempts_ref_length_check" CHECK (
    length("terminalId") BETWEEN 1 AND 64 AND
    ("providerRef" IS NULL OR length("providerRef") BETWEEN 1 AND 64) AND
    ("approvalCode" IS NULL OR length("approvalCode") BETWEEN 1 AND 16) AND
    ("declineCode" IS NULL OR length("declineCode") BETWEEN 1 AND 48)
  ),
  -- Every state after CREATED was claimed by exactly one dispatcher.
  CONSTRAINT "pharmacy_card_terminal_attempts_sent_check"
    CHECK ("status" IN ('CREATED', 'ABANDONED') OR "sentAt" IS NOT NULL),
  -- An approved or settled charge always carries its provider reference.
  CONSTRAINT "pharmacy_card_terminal_attempts_approval_check"
    CHECK ("status" NOT IN ('APPROVED', 'SETTLED', 'REVERSED') OR "providerRef" IS NOT NULL),
  -- A tender link exists exactly when the attempt is settled.
  CONSTRAINT "pharmacy_card_terminal_attempts_tender_check"
    CHECK (("status" = 'SETTLED') = ("tenderId" IS NOT NULL)),
  -- A manual review always records why, and its resolution records who resolved it.
  CONSTRAINT "pharmacy_card_terminal_attempts_review_check" CHECK (
    ("status" <> 'MANUAL_REVIEW' OR length(btrim(coalesce("reviewReason", ''))) BETWEEN 3 AND 200) AND
    ("status" <> 'REVERSED' OR "resolvedById" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_card_terminal_attempts_organizationId_id_key"
  ON "pharmacy_card_terminal_attempts" ("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_card_terminal_attempts_organizationId_attemptKey_key"
  ON "pharmacy_card_terminal_attempts" ("organizationId", "attemptKey");
CREATE INDEX IF NOT EXISTS "pharmacy_card_terminal_attempts_organizationId_branchId_status_idx"
  ON "pharmacy_card_terminal_attempts" ("organizationId", "branchId", "status");
CREATE INDEX IF NOT EXISTS "pharmacy_card_terminal_attempts_organizationId_saleId_idx"
  ON "pharmacy_card_terminal_attempts" ("organizationId", "saleId");
-- At most one open terminal operation per sale: a second charge cannot start while one is in
-- flight, unresolved, approved but not yet a tender, or waiting for review.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_card_terminal_attempts_one_open_key"
  ON "pharmacy_card_terminal_attempts" ("organizationId", "saleId")
  WHERE "status" IN ('CREATED', 'SENT', 'UNKNOWN', 'APPROVED', 'MANUAL_REVIEW');
-- One approval is one attempt, and one attempt is at most one tender.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_card_terminal_attempts_provider_ref_key"
  ON "pharmacy_card_terminal_attempts" ("organizationId", "provider", "providerRef")
  WHERE "providerRef" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_card_terminal_attempts_tender_key"
  ON "pharmacy_card_terminal_attempts" ("organizationId", "tenderId")
  WHERE "tenderId" IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_card_terminal_attempts_sale_fkey'
  ) THEN
    ALTER TABLE "pharmacy_card_terminal_attempts"
      ADD CONSTRAINT "pharmacy_card_terminal_attempts_sale_fkey"
      FOREIGN KEY ("organizationId", "branchId", "saleId")
      REFERENCES "pharmacy_sales" ("organizationId", "branchId", "id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_card_terminal_attempts_tender_fkey'
  ) THEN
    ALTER TABLE "pharmacy_card_terminal_attempts"
      ADD CONSTRAINT "pharmacy_card_terminal_attempts_tender_fkey"
      FOREIGN KEY ("organizationId", "tenderId")
      REFERENCES "pharmacy_tenders" ("organizationId", "id") ON DELETE RESTRICT;
  END IF;
END $$;

-- An attempt is never deleted. Its identity never changes, its card evidence is written once,
-- and its status only moves forward along the allowed lifecycle.
CREATE OR REPLACE FUNCTION pharmacy_card_terminal_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy card-terminal attempts are never deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'CREATED' OR NEW."sentAt" IS NOT NULL OR NEW."providerRef" IS NOT NULL
      OR NEW."tenderId" IS NOT NULL OR NEW."statusChecks" <> 0 THEN
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

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'pharmacy_card_terminal_attempts_guard'
  ) THEN
    CREATE TRIGGER pharmacy_card_terminal_attempts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON "pharmacy_card_terminal_attempts"
    FOR EACH ROW EXECUTE FUNCTION pharmacy_card_terminal_attempt_guard();
  END IF;
END $$;

-- While a terminal operation is open on a sale, no other tender may be added to it: the only
-- tender allowed is the CARD tender that records that attempt's own approval. This stops a
-- second payment (cash, manual card, wallet) being taken while the terminal may be charging.
CREATE OR REPLACE FUNCTION pharmacy_tender_card_terminal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "pharmacy_card_terminal_attempts" a
    WHERE a."organizationId" = NEW."organizationId" AND a."saleId" = NEW."saleId"
      AND a."status" IN ('CREATED', 'SENT', 'UNKNOWN', 'APPROVED', 'MANUAL_REVIEW')
      -- Null-safe: a tender with no provider or reference is never the matching settlement.
      AND NOT COALESCE(
        a."status" = 'APPROVED' AND NEW."type" = 'CARD' AND NEW."provider" = a."provider"
        AND NEW."providerRef" = a."providerRef" AND NEW."amountMinor" = a."amountMinor",
        false
      )
  ) THEN
    RAISE EXCEPTION 'a card-terminal payment is still open on this sale' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'pharmacy_tenders_card_terminal_guard'
  ) THEN
    CREATE TRIGGER pharmacy_tenders_card_terminal_guard
    BEFORE INSERT ON "pharmacy_tenders"
    FOR EACH ROW EXECUTE FUNCTION pharmacy_tender_card_terminal_guard();
  END IF;
END $$;

ALTER TABLE "pharmacy_card_terminal_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_card_terminal_attempts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pharmacy_card_terminal_attempts_tenant_branch"
  ON "pharmacy_card_terminal_attempts";
CREATE POLICY "pharmacy_card_terminal_attempts_tenant_branch"
  ON "pharmacy_card_terminal_attempts"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
        "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
        "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  );

COMMIT;
