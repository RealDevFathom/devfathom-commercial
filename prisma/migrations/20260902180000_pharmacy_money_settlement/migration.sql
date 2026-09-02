CREATE TYPE "PharmacyTenderType" AS ENUM ('CASH','CARD','BANK_TRANSFER','WALLET','CREDIT');
CREATE TYPE "PharmacyDrawerSessionStatus" AS ENUM ('OPEN','CLOSED');
CREATE TYPE "PharmacyDrawerMovementKind" AS ENUM ('OPENING_FLOAT','CASH_SALE','CASH_REFUND','PAID_IN','PAID_OUT','CLOSING_COUNT');

ALTER TABLE "pharmacy_sales" ADD COLUMN "receiptNumber" INTEGER,
  ADD COLUMN "receiptDeviceId" TEXT, ADD COLUMN "businessDate" DATE;

CREATE TABLE "pharmacy_money_idempotency_keys" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "deviceId" TEXT NOT NULL, "key" TEXT NOT NULL, "commandType" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL, "resultPayload" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "pharmacy_money_idempotency_keys_organizationId_id_key" ON "pharmacy_money_idempotency_keys"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_money_idempotency_keys_organizationId_deviceId_key_key" ON "pharmacy_money_idempotency_keys"("organizationId","deviceId","key");

CREATE TABLE "pharmacy_drawer_sessions" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "businessDate" DATE NOT NULL,
  "status" "PharmacyDrawerSessionStatus" NOT NULL DEFAULT 'OPEN', "openingFloatMinor" INTEGER NOT NULL,
  "countedCashMinor" INTEGER, "controlledCountHook" JSONB, "openedByActorId" TEXT NOT NULL,
  "closedByActorId" TEXT, "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "closedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "pharmacy_drawer_sessions_organizationId_id_key" ON "pharmacy_drawer_sessions"("organizationId","id");
CREATE INDEX "pharmacy_drawer_sessions_organizationId_branchId_businessDate_idx" ON "pharmacy_drawer_sessions"("organizationId","branchId","businessDate");
CREATE UNIQUE INDEX pharmacy_one_open_drawer_per_device ON "pharmacy_drawer_sessions"("organizationId","branchId","deviceId") WHERE "status"='OPEN';

CREATE TABLE "pharmacy_tenders" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "saleId" TEXT NOT NULL, "type" "PharmacyTenderType" NOT NULL,
  "amountMinor" INTEGER NOT NULL, "cashReceivedMinor" INTEGER, "changeGivenMinor" INTEGER,
  "provider" TEXT, "providerRef" TEXT, "drawerSessionId" TEXT, "businessDate" DATE NOT NULL,
  "actorId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "pharmacy_tenders_organizationId_id_key" ON "pharmacy_tenders"("organizationId","id");
CREATE INDEX "pharmacy_tenders_organizationId_branchId_businessDate_idx" ON "pharmacy_tenders"("organizationId","branchId","businessDate");

CREATE TABLE "pharmacy_refunds" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "saleId" TEXT NOT NULL, "originalTenderId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL, "providerRef" TEXT, "drawerSessionId" TEXT, "businessDate" DATE NOT NULL,
  "reason" TEXT NOT NULL, "actorId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "pharmacy_refunds_organizationId_id_key" ON "pharmacy_refunds"("organizationId","id");
CREATE INDEX "pharmacy_refunds_organizationId_branchId_businessDate_idx" ON "pharmacy_refunds"("organizationId","branchId","businessDate");

CREATE TABLE "pharmacy_drawer_movements" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "drawerSessionId" TEXT NOT NULL, "kind" "PharmacyDrawerMovementKind" NOT NULL, "amountMinor" INTEGER NOT NULL,
  "reason" TEXT, "actorId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "pharmacy_drawer_movements_organizationId_id_key" ON "pharmacy_drawer_movements"("organizationId","id");
CREATE INDEX "pharmacy_drawer_movements_organizationId_drawerSessionId_createdAt_idx" ON "pharmacy_drawer_movements"("organizationId","drawerSessionId","createdAt");

CREATE TABLE "pharmacy_daily_closes" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "businessDate" DATE NOT NULL, "sequence" INTEGER NOT NULL,
  "supersedesCloseId" TEXT, "reason" TEXT, "grossSalesMinor" INTEGER NOT NULL, "refundTotalMinor" INTEGER NOT NULL,
  "netSalesMinor" INTEGER NOT NULL, "cashExpectedMinor" INTEGER NOT NULL, "cashCountedMinor" INTEGER NOT NULL,
  "cashVarianceMinor" INTEGER NOT NULL, "controlledCountHook" JSONB, "sourceHash" TEXT NOT NULL,
  "actorId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "pharmacy_daily_closes_organizationId_id_key" ON "pharmacy_daily_closes"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_daily_closes_organizationId_branchId_businessDate_sequence_key" ON "pharmacy_daily_closes"("organizationId","branchId","businessDate","sequence");

CREATE TABLE "pharmacy_receipt_number_sequences" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "nextNumber" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "pharmacy_receipt_number_sequences_organizationId_id_key" ON "pharmacy_receipt_number_sequences"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_receipt_number_sequences_organizationId_branchId_deviceId_key" ON "pharmacy_receipt_number_sequences"("organizationId","branchId","deviceId");
CREATE UNIQUE INDEX pharmacy_issued_receipt_number ON "pharmacy_sales"("organizationId","branchId","receiptDeviceId","receiptNumber") WHERE "receiptNumber" IS NOT NULL;

ALTER TABLE "pharmacy_tenders" ADD CONSTRAINT pharmacy_tenders_sale_fkey FOREIGN KEY ("organizationId","branchId","saleId") REFERENCES "pharmacy_sales"("organizationId","branchId","id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_tenders" ADD CONSTRAINT pharmacy_tenders_drawer_fkey FOREIGN KEY ("organizationId","drawerSessionId") REFERENCES "pharmacy_drawer_sessions"("organizationId","id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_refunds" ADD CONSTRAINT pharmacy_refunds_sale_fkey FOREIGN KEY ("organizationId","branchId","saleId") REFERENCES "pharmacy_sales"("organizationId","branchId","id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_refunds" ADD CONSTRAINT pharmacy_refunds_tender_fkey FOREIGN KEY ("organizationId","originalTenderId") REFERENCES "pharmacy_tenders"("organizationId","id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_drawer_movements" ADD CONSTRAINT pharmacy_drawer_movements_session_fkey FOREIGN KEY ("organizationId","drawerSessionId") REFERENCES "pharmacy_drawer_sessions"("organizationId","id") ON DELETE RESTRICT;

ALTER TABLE "pharmacy_tenders" ADD CONSTRAINT pharmacy_tender_amount_check CHECK ("amountMinor">0 AND (("type"='CASH' AND "cashReceivedMinor">="amountMinor" AND "changeGivenMinor"="cashReceivedMinor"-"amountMinor" AND "drawerSessionId" IS NOT NULL) OR ("type"<>'CASH' AND "cashReceivedMinor" IS NULL AND "changeGivenMinor" IS NULL)));
ALTER TABLE "pharmacy_refunds" ADD CONSTRAINT pharmacy_refund_amount_check CHECK ("amountMinor">0 AND length(btrim("reason"))>0);
ALTER TABLE "pharmacy_drawer_sessions" ADD CONSTRAINT pharmacy_drawer_close_check CHECK ("openingFloatMinor">=0 AND (("status"='OPEN' AND "closedAt" IS NULL AND "countedCashMinor" IS NULL) OR ("status"='CLOSED' AND "closedAt" IS NOT NULL AND "countedCashMinor">=0)));

CREATE FUNCTION pharmacy_guard_refund_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tendered integer; refunded integer;
BEGIN
  SELECT "amountMinor" INTO tendered FROM "pharmacy_tenders" WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."originalTenderId" FOR UPDATE;
  SELECT COALESCE(SUM("amountMinor"),0) INTO refunded FROM "pharmacy_refunds" WHERE "organizationId"=NEW."organizationId" AND "originalTenderId"=NEW."originalTenderId";
  IF tendered IS NULL OR refunded+NEW."amountMinor">tendered THEN RAISE EXCEPTION 'REFUND_EXCEEDS_TENDER' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_refund_total_guard BEFORE INSERT ON "pharmacy_refunds" FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_refund_total();

CREATE FUNCTION pharmacy_reject_money_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='55000'; END $$;
CREATE TRIGGER pharmacy_tenders_append_only BEFORE UPDATE OR DELETE ON "pharmacy_tenders" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_money_mutation();
CREATE TRIGGER pharmacy_refunds_append_only BEFORE UPDATE OR DELETE ON "pharmacy_refunds" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_money_mutation();
CREATE TRIGGER pharmacy_drawer_movements_append_only BEFORE UPDATE OR DELETE ON "pharmacy_drawer_movements" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_money_mutation();
CREATE TRIGGER pharmacy_daily_closes_append_only BEFORE UPDATE OR DELETE ON "pharmacy_daily_closes" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_money_mutation();
CREATE FUNCTION pharmacy_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."receiptNumber" IS NOT NULL AND (NEW."receiptNumber",NEW."receiptDeviceId") IS DISTINCT FROM (OLD."receiptNumber",OLD."receiptDeviceId") THEN RAISE EXCEPTION 'ISSUED_RECEIPT_IMMUTABLE' USING ERRCODE='55000'; END IF; RETURN NEW; END $$;
CREATE TRIGGER pharmacy_receipt_immutable_guard BEFORE UPDATE ON "pharmacy_sales" FOR EACH ROW EXECUTE FUNCTION pharmacy_receipt_immutable();

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['pharmacy_money_idempotency_keys','pharmacy_tenders','pharmacy_refunds','pharmacy_drawer_sessions','pharmacy_drawer_movements','pharmacy_daily_closes','pharmacy_receipt_number_sequences'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("organizationId"=current_setting(''app.current_organization_id'',true)) WITH CHECK ("organizationId"=current_setting(''app.current_organization_id'',true))',t);
END LOOP; END $$;
