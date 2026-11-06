BEGIN;
ALTER TYPE "PharmacyOfflineAction" ADD VALUE 'MANUAL_PAYMENT_HOLD';
ALTER TABLE pharmacy_payment_attempts
 ADD COLUMN source TEXT NOT NULL DEFAULT 'PRECOLLECTION' CHECK (source IN ('PRECOLLECTION','OFFLINE_HOLD','LEGACY_CAPTURE')),
 ADD COLUMN "collectionTokenHash" TEXT,
 ADD COLUMN "collectionPolicyRevision" INTEGER,
 ADD COLUMN "collectionInstructionsHash" TEXT,
 ADD COLUMN "settlementTokenHash" TEXT,
 ADD COLUMN "settlementActorId" TEXT,
 ADD COLUMN "settlementInput" JSONB,
 ADD COLUMN "settlementResult" JSONB,
 ADD COLUMN "providerRef" TEXT,
 ADD COLUMN "providerName" TEXT,
 ADD COLUMN "resolvedByUserId" TEXT,
 ADD COLUMN "resolutionReason" TEXT,
 ADD COLUMN "settledTenderId" TEXT;
DROP INDEX pharmacy_payment_attempt_one_unresolved;
CREATE UNIQUE INDEX pharmacy_payment_attempt_one_unresolved ON pharmacy_payment_attempts ("organizationId","branchId","saleId")
 WHERE state NOT IN ('SETTLED','RELEASED') AND source='PRECOLLECTION';
ALTER TABLE pharmacy_tenders ADD COLUMN "paymentAttemptId" TEXT;
ALTER TABLE pharmacy_tenders ADD CONSTRAINT pharmacy_tender_attempt_fk
 FOREIGN KEY ("organizationId","paymentAttemptId") REFERENCES pharmacy_payment_attempts ("organizationId",id) ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE UNIQUE INDEX pharmacy_tender_one_payment_attempt ON pharmacy_tenders ("organizationId","paymentAttemptId");

CREATE TABLE pharmacy_payment_attempt_events (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),
 "branchId" TEXT NOT NULL, "saleId" TEXT NOT NULL, "attemptId" TEXT NOT NULL,
 "fromState" TEXT NOT NULL, "toState" TEXT NOT NULL, "actorId" TEXT NOT NULL,
 reason TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("organizationId","attemptId") REFERENCES pharmacy_payment_attempts ("organizationId",id) ON DELETE RESTRICT
);
CREATE INDEX pharmacy_payment_attempt_event_scope ON pharmacy_payment_attempt_events ("organizationId","branchId","saleId","createdAt");
ALTER TABLE pharmacy_payment_attempt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_payment_attempt_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_payment_attempt_events
 USING ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),''))
 WITH CHECK ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),''));

-- Stored identity, deny precedence and the approved system roles match #1413.
-- No SECURITY DEFINER and no caller-supplied role or authorization boolean.
CREATE FUNCTION pharmacy_payment_actor_allowed(org TEXT, branch TEXT, actor TEXT, resolution BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE member users%ROWTYPE; assigned organization_roles%ROWTYPE; action TEXT; denied BOOLEAN; granted BOOLEAN;
BEGIN
 IF org IS DISTINCT FROM NULLIF(current_setting('app.current_organization_id',true),'') THEN RETURN false; END IF;
 SELECT * INTO member FROM users WHERE id=actor AND "organizationId"=org;
 IF NOT FOUND OR member.status::text NOT IN ('ACTIVE','ON_LEAVE') OR member.role::text NOT IN ('ADMIN','EMPLOYEE','HR') THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pharmacy_branches WHERE id=branch AND "organizationId"=org AND active) THEN RETURN false; END IF;
 IF member."organizationRoleId" IS NOT NULL THEN
   SELECT * INTO assigned FROM organization_roles WHERE id=member."organizationRoleId" AND "organizationId"=org;
   IF NOT FOUND THEN RETURN false; END IF;
 END IF;
 IF resolution AND NOT (
   (member."organizationRoleId" IS NULL AND member.role::text='ADMIN') OR
   (member."organizationRoleId" IS NOT NULL AND assigned."isSystem" AND assigned.key IN ('owner','owner-operator','manager','admin'))
 ) THEN RETURN false; END IF;
 action:=CASE WHEN resolution THEN 'pharmacy:close' ELSE 'pharmacy:counter' END;
 SELECT coalesce(bool_or(effect='DENY'),false),coalesce(bool_or(effect='ALLOW'),false) INTO denied,granted FROM (
   SELECT capability,effect::text FROM organization_role_permissions WHERE "organizationId"=org AND "organizationRoleId"=member."organizationRoleId"
   UNION ALL SELECT capability,effect::text FROM user_permission_overrides WHERE "organizationId"=org AND "userId"=actor AND ("expiresAt" IS NULL OR "expiresAt">CURRENT_TIMESTAMP)
 ) rules WHERE capability IN (action,'pharmacy:*','*');
 IF denied OR (NOT granted AND (NOT resolution OR member.role::text<>'ADMIN')) THEN RETURN false; END IF;
 IF member.role::text<>'ADMIN' AND NOT EXISTS (SELECT 1 FROM pharmacy_branch_assignments
   WHERE "organizationId"=org AND "branchId"=branch AND "userId"=actor AND active) THEN RETURN false; END IF;
 RETURN true;
END $$;

CREATE FUNCTION pharmacy_payment_token_matches(token_name TEXT, expected TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT expected IS NOT NULL AND length(coalesce(current_setting(token_name,true),''))>=32
   AND encode(sha256(convert_to(coalesce(current_setting(token_name,true),''),'UTF8')),'hex')=expected
$$;

CREATE OR REPLACE FUNCTION pharmacy_payment_attempt_prepare_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bill RECORD; remaining BIGINT;
BEGIN
 SELECT s.*,o.currency AS "billCurrency" INTO bill FROM pharmacy_sales s JOIN organizations o ON o.id=s."organizationId"
   JOIN pharmacy_branches b ON b.id=s."branchId" AND b."organizationId"=s."organizationId" AND b.active
   WHERE s.id=NEW."saleId" AND s."organizationId"=NEW."organizationId" AND s."branchId"=NEW."branchId" FOR UPDATE OF s;
 IF NOT FOUND OR (NEW.source<>'LEGACY_CAPTURE' AND bill.status::text<>'OPEN') THEN RAISE EXCEPTION 'PAYMENT_SALE_NOT_OPEN'; END IF;
 IF NEW."billRevision"<>bill."paymentRevision" OR NEW.currency<>bill."billCurrency" OR
   NEW.state<>(CASE WHEN NEW.source='LEGACY_CAPTURE' THEN 'UNKNOWN' ELSE 'PREPARED' END)
 THEN RAISE EXCEPTION 'PAYMENT_BILL_CHANGED'; END IF;
 SELECT coalesce((SELECT sum("grossMinor"::bigint-"discountMinor") FROM pharmacy_sale_lines WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "saleId"=NEW."saleId"),0)
   -coalesce((SELECT sum("amountMinor"::bigint) FROM pharmacy_tenders WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "saleId"=NEW."saleId"),0) INTO remaining;
 -- Evidence already received from an older client or offline hold must survive
 -- even when a stale amount exceeds the current bill. It stays locked; the
 -- unchanged settlement over-tender check still refuses financial completion.
 IF NEW.source='PRECOLLECTION' AND NEW."amountMinor">remaining THEN RAISE EXCEPTION 'PAYMENT_AMOUNT_EXCEEDS_BALANCE'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_payment_attempt_identity_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE actor TEXT; mutable TEXT[]; owner_resolution BOOLEAN;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_APPEND_ONLY'; END IF;
 mutable:=ARRAY['state','updatedAt','collectionTokenHash','collectionPolicyRevision','collectionInstructionsHash','settlementTokenHash','settlementActorId','settlementInput','settlementResult','providerRef','providerName','resolvedByUserId','resolutionReason','settledTenderId'];
 IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable) THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_IDENTITY_IMMUTABLE'; END IF;
 actor:=NULLIF(current_setting('app.current_user_id',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_FORBIDDEN'; END IF;
 PERFORM 1 FROM pharmacy_sales WHERE id=OLD."saleId" AND "organizationId"=OLD."organizationId" AND "branchId"=OLD."branchId" FOR UPDATE;
 owner_resolution:=pharmacy_payment_actor_allowed(OLD."organizationId",OLD."branchId",actor,true);
 IF NEW.state=OLD.state THEN
   IF (to_jsonb(NEW)-'updatedAt') IS NOT DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN RETURN NEW; END IF;
   IF OLD.state='SETTLED' AND OLD."settlementResult" IS NULL AND NEW."settlementResult"->>'tenderId'=OLD."settledTenderId"
     AND (to_jsonb(NEW)-'updatedAt'-'settlementResult') IS NOT DISTINCT FROM (to_jsonb(OLD)-'updatedAt'-'settlementResult')
     AND actor=OLD."settlementActorId" AND pharmacy_payment_token_matches('app.pharmacy_settlement_token',OLD."settlementTokenHash") THEN RETURN NEW; END IF;
   IF NOT (OLD.state='CONFIRMED' AND (
      (OLD.method NOT IN ('CARD','WALLET') AND owner_resolution AND NEW."resolvedByUserId"=actor AND length(trim(coalesce(NEW."resolutionReason",'')))>0) OR
      (OLD.method IN ('CARD','WALLET') AND OLD."providerRef" IS NOT NULL AND OLD."providerName" IS NOT NULL AND actor=OLD."createdByUserId"
       AND pharmacy_payment_actor_allowed(OLD."organizationId",OLD."branchId",actor,false))
     ) AND NEW."settlementActorId"=actor AND NEW."settlementTokenHash" ~ '^[a-f0-9]{64}$'
     AND (to_jsonb(NEW)-ARRAY['updatedAt','settlementTokenHash','settlementActorId','resolvedByUserId','resolutionReason']) IS NOT DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['updatedAt','settlementTokenHash','settlementActorId','resolvedByUserId','resolutionReason'])
   ) THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_TRANSITION_UNAVAILABLE'; END IF;
   RETURN NEW;
 END IF;
 IF OLD.state='PREPARED' AND NEW.state='EXPOSED' THEN
   IF actor<>OLD."createdByUserId" OR NOT pharmacy_payment_actor_allowed(OLD."organizationId",OLD."branchId",actor,false)
      OR NEW."collectionTokenHash" IS NULL OR NEW."collectionTokenHash" !~ '^[a-f0-9]{64}$'
      OR (to_jsonb(NEW)-ARRAY['state','updatedAt','collectionTokenHash','settlementInput','collectionPolicyRevision','collectionInstructionsHash']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','updatedAt','collectionTokenHash','settlementInput','collectionPolicyRevision','collectionInstructionsHash'])
   THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_FORBIDDEN'; END IF;
   IF OLD.method IN ('RAAST','JAZZCASH','EASYPAISA') AND (NEW."collectionPolicyRevision" IS NULL OR NEW."collectionPolicyRevision"<0
      OR NEW."collectionInstructionsHash" IS NULL OR NEW."collectionInstructionsHash" !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'PAYMENT_METHOD_NOT_SETUP'; END IF;
 ELSIF OLD.state='EXPOSED' AND NEW.state='UNKNOWN' THEN
   IF actor<>OLD."createdByUserId" OR NOT pharmacy_payment_actor_allowed(OLD."organizationId",OLD."branchId",actor,false)
      OR NOT pharmacy_payment_token_matches('app.pharmacy_collection_token',OLD."collectionTokenHash")
      OR NEW."settlementActorId" IS DISTINCT FROM actor OR NEW."settlementTokenHash" IS NULL OR NEW."settlementTokenHash" !~ '^[a-f0-9]{64}$'
      OR NEW."settlementInput" IS NULL OR NEW."settledTenderId" IS NOT NULL OR NEW."settlementResult" IS NOT NULL OR NEW."providerRef" IS NOT NULL
      OR (to_jsonb(NEW)-ARRAY['state','updatedAt','settlementTokenHash','settlementActorId','settlementInput']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['state','updatedAt','settlementTokenHash','settlementActorId','settlementInput'])
   THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_FORBIDDEN'; END IF;
 ELSIF OLD.state IN ('PREPARED','EXPOSED','UNKNOWN') AND NEW.state='RELEASED' THEN
   IF NOT owner_resolution OR OLD.method IN ('CARD','WALLET') OR NEW."resolvedByUserId" IS DISTINCT FROM actor
     OR length(trim(coalesce(NEW."resolutionReason",'')))=0
     OR NEW."settledTenderId" IS NOT NULL OR NEW."settlementResult" IS NOT NULL
     OR (to_jsonb(NEW)-ARRAY['state','updatedAt','resolvedByUserId','resolutionReason']) IS DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['state','updatedAt','resolvedByUserId','resolutionReason'])
   THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_FORBIDDEN'; END IF;
 ELSIF OLD.state IN ('PREPARED','EXPOSED','UNKNOWN') AND NEW.state='CONFIRMED' THEN
   IF OLD.method IN ('CARD','WALLET') THEN
     IF OLD.state<>'UNKNOWN' OR actor<>OLD."settlementActorId" OR NEW."providerRef" IS NULL OR NEW."providerName" IS NULL
       OR NOT pharmacy_payment_actor_allowed(OLD."organizationId",OLD."branchId",actor,false)
       OR NOT pharmacy_payment_token_matches('app.pharmacy_settlement_token',OLD."settlementTokenHash")
       OR NEW."settlementTokenHash" IS DISTINCT FROM OLD."settlementTokenHash" OR NEW."settlementInput" IS DISTINCT FROM OLD."settlementInput"
       OR (to_jsonb(NEW)-ARRAY['state','updatedAt','providerRef','providerName']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','updatedAt','providerRef','providerName'])
     THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_FORBIDDEN'; END IF;
   ELSIF NOT owner_resolution OR NEW."resolvedByUserId" IS DISTINCT FROM actor OR NEW."settlementActorId" IS DISTINCT FROM actor
      OR length(trim(coalesce(NEW."resolutionReason",'')))=0 OR NEW."settlementTokenHash" IS NULL OR NEW."settlementTokenHash" !~ '^[a-f0-9]{64}$'
      OR NEW."settlementInput" IS NULL OR NEW."providerRef" IS NOT NULL
      OR (to_jsonb(NEW)-ARRAY['state','updatedAt','settlementTokenHash','settlementActorId','settlementInput','resolvedByUserId','resolutionReason']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['state','updatedAt','settlementTokenHash','settlementActorId','settlementInput','resolvedByUserId','resolutionReason'])
   THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_FORBIDDEN'; END IF;
 ELSIF OLD.state IN ('UNKNOWN','CONFIRMED') AND NEW.state='SETTLED' THEN
   IF actor<>OLD."settlementActorId" OR NOT pharmacy_payment_token_matches('app.pharmacy_settlement_token',OLD."settlementTokenHash")
     OR NOT EXISTS (SELECT 1 FROM pharmacy_tenders t WHERE t.id=NEW."settledTenderId" AND t."organizationId"=OLD."organizationId"
       AND t."branchId"=OLD."branchId" AND t."saleId"=OLD."saleId" AND t."paymentAttemptId"=OLD.id AND t.type::text=OLD.method AND t."amountMinor"=OLD."amountMinor")
     OR (to_jsonb(NEW)-'state'-'updatedAt'-'settledTenderId') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'updatedAt'-'settledTenderId')
   THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_FORBIDDEN'; END IF;
 ELSE RAISE EXCEPTION 'PAYMENT_ATTEMPT_TRANSITION_UNAVAILABLE'; END IF;
 IF NEW.state IN ('EXPOSED','UNKNOWN','CONFIRMED') AND (
   NEW."settlementInput"->>'saleId' IS DISTINCT FROM OLD."saleId" OR NEW."settlementInput"->>'deviceId' IS DISTINCT FROM OLD."deviceId"
   OR NEW."settlementInput"->>'idempotencyKey' IS DISTINCT FROM OLD."requestKey" OR NEW."settlementInput"->>'type' IS DISTINCT FROM OLD.method
   OR NEW."settlementInput"->>'paymentAttemptId' IS DISTINCT FROM OLD.id OR (NEW."settlementInput"->>'amountMinor')::integer IS DISTINCT FROM OLD."amountMinor"
 ) THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_REQUEST_CONFLICT'; END IF;
 IF NEW.state IN ('UNKNOWN','CONFIRMED') AND (NEW."settledTenderId" IS NOT NULL OR NEW."settlementResult" IS NOT NULL) THEN
   RAISE EXCEPTION 'PAYMENT_ATTEMPT_RESULT_CONFLICT'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION pharmacy_audit_payment_attempt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state OR NEW."settlementTokenHash" IS DISTINCT FROM OLD."settlementTokenHash" THEN INSERT INTO pharmacy_payment_attempt_events
 (id,"organizationId","branchId","saleId","attemptId","fromState","toState","actorId",reason)
 VALUES (gen_random_uuid()::text,NEW."organizationId",NEW."branchId",NEW."saleId",NEW.id,OLD.state,NEW.state,current_setting('app.current_user_id',true),NEW."resolutionReason"); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_payment_attempt_audit AFTER UPDATE ON pharmacy_payment_attempts FOR EACH ROW EXECUTE FUNCTION pharmacy_audit_payment_attempt();
CREATE FUNCTION pharmacy_payment_attempt_event_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_AUDIT_APPEND_ONLY'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_payment_attempt_event_immutable BEFORE INSERT OR UPDATE OR DELETE ON pharmacy_payment_attempt_events FOR EACH ROW EXECUTE FUNCTION pharmacy_payment_attempt_event_guard();

CREATE FUNCTION pharmacy_assert_payment_settlement_allowed(org TEXT, branch TEXT, sale TEXT, method TEXT, amount INTEGER, attempt_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE attempt RECORD; revision INTEGER; actor TEXT;
BEGIN
 SELECT "paymentRevision" INTO revision FROM pharmacy_sales WHERE "organizationId"=org AND "branchId"=branch AND id=sale FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_SALE_NOT_FOUND'; END IF;
 SELECT * INTO attempt FROM pharmacy_payment_attempts WHERE "organizationId"=org AND "branchId"=branch AND "saleId"=sale AND state NOT IN ('SETTLED','RELEASED');
 IF NOT FOUND THEN
   IF attempt_id IS NOT NULL THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_UNRESOLVED'; END IF;
   RETURN; -- historical/internal writers still use their existing status/tender guards
 END IF;
 actor:=NULLIF(current_setting('app.current_user_id',true),'');
 IF EXISTS (SELECT 1 FROM pharmacy_payment_attempts WHERE "organizationId"=org AND "branchId"=branch AND "saleId"=sale
   AND state NOT IN ('SETTLED','RELEASED') AND id IS DISTINCT FROM attempt_id) THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_UNRESOLVED'; END IF;
 IF attempt_id IS DISTINCT FROM attempt.id OR method<>attempt.method OR amount<>attempt."amountMinor" OR revision<>attempt."billRevision"
   OR attempt.state NOT IN ('UNKNOWN','CONFIRMED') OR actor IS DISTINCT FROM attempt."settlementActorId"
   OR NOT pharmacy_payment_token_matches('app.pharmacy_settlement_token',attempt."settlementTokenHash")
   OR NOT pharmacy_payment_actor_allowed(org,branch,actor,attempt.state='CONFIRMED' AND method NOT IN ('CARD','WALLET'))
 THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_UNRESOLVED'; END IF;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_payment_tender_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='pharmacy_refunds' THEN
   PERFORM pharmacy_assert_no_payment_attempt(NEW."organizationId",NEW."branchId",NEW."saleId");
 ELSE PERFORM pharmacy_assert_payment_settlement_allowed(NEW."organizationId",NEW."branchId",NEW."saleId",NEW.type::text,NEW."amountMinor",NEW."paymentAttemptId"); END IF;
 UPDATE pharmacy_sales SET "paymentRevision"="paymentRevision"+1 WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND id=NEW."saleId";
 RETURN NEW;
END $$;
CREATE FUNCTION pharmacy_settle_payment_attempt_from_tender() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."paymentAttemptId" IS NOT NULL THEN UPDATE pharmacy_payment_attempts SET state='SETTLED',"settledTenderId"=NEW.id,"updatedAt"=CURRENT_TIMESTAMP
   WHERE id=NEW."paymentAttemptId" AND "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "saleId"=NEW."saleId"; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_tender_settles_attempt AFTER INSERT ON pharmacy_tenders FOR EACH ROW EXECUTE FUNCTION pharmacy_settle_payment_attempt_from_tender();
CREATE FUNCTION pharmacy_payment_attempt_commit_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE final RECORD;
BEGIN
 SELECT * INTO final FROM pharmacy_payment_attempts WHERE id=NEW.id AND "organizationId"=NEW."organizationId";
 IF final.state='SETTLED' AND (final."settlementResult" IS NULL OR final."settlementResult"->>'tenderId' IS DISTINCT FROM final."settledTenderId") THEN
   RAISE EXCEPTION 'PAYMENT_ATTEMPT_RESULT_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pharmacy_payment_attempt_complete_at_commit AFTER INSERT OR UPDATE ON pharmacy_payment_attempts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pharmacy_payment_attempt_commit_guard();
COMMIT;
