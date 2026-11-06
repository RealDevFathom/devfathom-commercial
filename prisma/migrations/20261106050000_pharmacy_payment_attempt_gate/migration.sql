BEGIN;
ALTER TABLE pharmacy_sales ADD COLUMN "paymentRevision" INTEGER NOT NULL DEFAULT 0
  CHECK ("paymentRevision" >= 0);
CREATE TABLE pharmacy_payment_attempts (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "saleId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL, "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  method TEXT NOT NULL CHECK (method IN ('CARD','WALLET','BANK_TRANSFER','RAAST','JAZZCASH','EASYPAISA')),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
  "billRevision" INTEGER NOT NULL CHECK ("billRevision" >= 0),
  state TEXT NOT NULL DEFAULT 'PREPARED'
    CHECK (state IN ('PREPARED','EXPOSED','UNKNOWN','CONFIRMED','SETTLED','RELEASED')),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pharmacy_payment_attempt_sale_fk FOREIGN KEY ("organizationId","branchId","saleId")
    REFERENCES pharmacy_sales ("organizationId","branchId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE ("organizationId",id),
  UNIQUE ("organizationId","deviceId","requestKey")
);
CREATE UNIQUE INDEX pharmacy_payment_attempt_one_unresolved
 ON pharmacy_payment_attempts ("organizationId","branchId","saleId")
 WHERE state NOT IN ('SETTLED','RELEASED');
CREATE INDEX pharmacy_payment_attempt_scope_state
 ON pharmacy_payment_attempts ("organizationId","branchId","saleId",state);
ALTER TABLE pharmacy_payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_payment_attempts
 USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
 WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- Every writer uses the sale row as its first payment/bill lock. These are
-- invoker functions: no SECURITY DEFINER, RLS exemption or role escalation.
CREATE FUNCTION pharmacy_assert_no_payment_attempt(org TEXT, branch TEXT, sale TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM pharmacy_sales WHERE "organizationId"=org AND "branchId"=branch AND id=sale FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_SALE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF EXISTS (SELECT 1 FROM pharmacy_payment_attempts
    WHERE "organizationId"=org AND "branchId"=branch AND "saleId"=sale
      AND state NOT IN ('SETTLED','RELEASED')) THEN
    RAISE EXCEPTION 'PAYMENT_ATTEMPT_UNRESOLVED' USING ERRCODE='P0001';
  END IF;
END $$;

CREATE FUNCTION pharmacy_payment_attempt_prepare_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bill RECORD; remaining BIGINT;
BEGIN
  SELECT s.*, o.currency AS "billCurrency" INTO bill FROM pharmacy_sales s
    JOIN organizations o ON o.id=s."organizationId"
    JOIN pharmacy_branches b ON b.id=s."branchId" AND b."organizationId"=s."organizationId" AND b.active
    WHERE s.id=NEW."saleId" AND s."organizationId"=NEW."organizationId" AND s."branchId"=NEW."branchId"
    FOR UPDATE OF s;
  IF NOT FOUND OR bill.status::text <> 'OPEN' THEN RAISE EXCEPTION 'PAYMENT_SALE_NOT_OPEN'; END IF;
  IF NEW.state <> 'PREPARED' OR NEW."billRevision" <> bill."paymentRevision" OR NEW.currency <> bill."billCurrency" THEN
    RAISE EXCEPTION 'PAYMENT_BILL_CHANGED';
  END IF;
  SELECT coalesce((SELECT sum("grossMinor"::bigint-"discountMinor") FROM pharmacy_sale_lines
    WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "saleId"=NEW."saleId"),0)
    - coalesce((SELECT sum("amountMinor"::bigint) FROM pharmacy_tenders
    WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "saleId"=NEW."saleId"),0)
    INTO remaining;
  IF NEW."amountMinor" > remaining THEN RAISE EXCEPTION 'PAYMENT_AMOUNT_EXCEEDS_BALANCE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_payment_attempt_prepare BEFORE INSERT ON pharmacy_payment_attempts
 FOR EACH ROW EXECUTE FUNCTION pharmacy_payment_attempt_prepare_guard();

CREATE FUNCTION pharmacy_payment_attempt_identity_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_APPEND_ONLY'; END IF;
  IF (to_jsonb(NEW)-'state'-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'updatedAt') THEN
    RAISE EXCEPTION 'PAYMENT_ATTEMPT_IDENTITY_IMMUTABLE';
  END IF;
  -- Fail closed for every caller until the audited dispatch/settlement and
  -- Owner/Manager resolution boundary is installed. A raw state update must
  -- never release the bill simply because it belongs to the same tenant.
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'PAYMENT_ATTEMPT_TRANSITION_UNAVAILABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_payment_attempt_identity BEFORE UPDATE OR DELETE ON pharmacy_payment_attempts
 FOR EACH ROW EXECUTE FUNCTION pharmacy_payment_attempt_identity_guard();

CREATE FUNCTION pharmacy_payment_line_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE org TEXT; branch TEXT; sale TEXT;
BEGIN
  IF TG_OP='UPDATE' AND (NEW."organizationId",NEW."branchId",NEW."saleId") IS DISTINCT FROM (OLD."organizationId",OLD."branchId",OLD."saleId") THEN
    RAISE EXCEPTION 'PAYMENT_LINE_IDENTITY_IMMUTABLE';
  END IF;
  IF TG_OP='DELETE' THEN org:=OLD."organizationId"; branch:=OLD."branchId"; sale:=OLD."saleId";
  ELSE org:=NEW."organizationId"; branch:=NEW."branchId"; sale:=NEW."saleId"; END IF;
  PERFORM pharmacy_assert_no_payment_attempt(org,branch,sale);
  UPDATE pharmacy_sales SET "paymentRevision"="paymentRevision"+1 WHERE "organizationId"=org AND "branchId"=branch AND id=sale;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_payment_line BEFORE INSERT OR UPDATE OR DELETE ON pharmacy_sale_lines
 FOR EACH ROW EXECUTE FUNCTION pharmacy_payment_line_guard();

CREATE FUNCTION pharmacy_payment_allocation_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE org TEXT; line TEXT; linked RECORD;
BEGIN
  IF TG_OP='UPDATE' AND (NEW."organizationId",NEW."saleLineId") IS DISTINCT FROM (OLD."organizationId",OLD."saleLineId") THEN
    RAISE EXCEPTION 'PAYMENT_ALLOCATION_IDENTITY_IMMUTABLE';
  END IF;
  IF TG_OP='DELETE' THEN org:=OLD."organizationId"; line:=OLD."saleLineId";
  ELSE org:=NEW."organizationId"; line:=NEW."saleLineId"; END IF;
  SELECT "branchId","saleId" INTO linked FROM pharmacy_sale_lines WHERE "organizationId"=org AND id=line;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_SALE_NOT_FOUND'; END IF;
  PERFORM pharmacy_assert_no_payment_attempt(org,linked."branchId",linked."saleId");
  UPDATE pharmacy_sales SET "paymentRevision"="paymentRevision"+1
    WHERE "organizationId"=org AND "branchId"=linked."branchId" AND id=linked."saleId";
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_payment_allocation BEFORE INSERT OR UPDATE OR DELETE ON pharmacy_sale_line_allocations
 FOR EACH ROW EXECUTE FUNCTION pharmacy_payment_allocation_guard();

CREATE FUNCTION pharmacy_payment_sale_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status,NEW."customerId",NEW."receiptNumber",NEW."completedAt") IS DISTINCT FROM (OLD.status,OLD."customerId",OLD."receiptNumber",OLD."completedAt") THEN
    PERFORM pharmacy_assert_no_payment_attempt(OLD."organizationId",OLD."branchId",OLD.id);
    NEW."paymentRevision":=OLD."paymentRevision"+1;
  ELSIF NEW."paymentRevision" < OLD."paymentRevision" THEN RAISE EXCEPTION 'PAYMENT_REVISION_CANNOT_DECREASE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_payment_sale BEFORE UPDATE ON pharmacy_sales
 FOR EACH ROW EXECUTE FUNCTION pharmacy_payment_sale_guard();

-- Until the settlement hand-off explicitly resolves the matching attempt in
-- its transaction, legacy tender writers must fail closed for a locked bill.
CREATE FUNCTION pharmacy_payment_tender_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pharmacy_assert_no_payment_attempt(NEW."organizationId",NEW."branchId",NEW."saleId");
  UPDATE pharmacy_sales SET "paymentRevision"="paymentRevision"+1
    WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND id=NEW."saleId";
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_payment_tender BEFORE INSERT ON pharmacy_tenders
 FOR EACH ROW EXECUTE FUNCTION pharmacy_payment_tender_guard();

CREATE FUNCTION pharmacy_payment_reversal_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE linked RECORD;
BEGIN
  IF NEW."reversesMovementId" IS NOT NULL THEN
    FOR linked IN SELECT DISTINCT l."organizationId",l."branchId",l."saleId" FROM pharmacy_sale_line_allocations a
      JOIN pharmacy_sale_lines l ON l.id=a."saleLineId" AND l."organizationId"=a."organizationId"
      WHERE a."organizationId"=NEW."organizationId" AND a."stockMovementId"=NEW."reversesMovementId"
      ORDER BY l."organizationId",l."branchId",l."saleId"
    LOOP PERFORM pharmacy_assert_no_payment_attempt(linked."organizationId",linked."branchId",linked."saleId"); END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_payment_reversal BEFORE INSERT ON pharmacy_stock_movements
 FOR EACH ROW EXECUTE FUNCTION pharmacy_payment_reversal_guard();
COMMIT;
