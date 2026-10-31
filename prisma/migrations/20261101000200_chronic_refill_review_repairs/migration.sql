-- #743: preserve retention, owner approval and revocation through fulfillment.
SET lock_timeout = '5s';

-- Read access is needed by the reminder worker after nextDueAt advances.
CREATE POLICY chronic_refill_platform_scan ON "pharmacy_chronic_refill_cycles"
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true');

-- Only the existing platform purge transaction may destroy these histories.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['pharmacy_chronic_refill_subscriptions', 'pharmacy_chronic_refill_cycles', 'pharmacy_chronic_refill_events'] LOOP
    EXECUTE format('CREATE POLICY chronic_refill_platform_purge ON %I FOR DELETE USING (
      current_setting(''app.is_platform_admin'', true) = ''true'' AND
      "organizationId" = NULLIF(current_setting(''app.purging_organization_id'', true), ''''))', table_name);
  END LOOP;
END $$;
CREATE POLICY chronic_refill_purge_read ON "pharmacy_chronic_refill_events"
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' AND
    "organizationId" = NULLIF(current_setting('app.purging_organization_id', true), ''));

CREATE FUNCTION pharmacy_chronic_refill_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.is_platform_admin', true) = 'true'
    AND NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId" THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'chronic refill history is append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER pharmacy_chronic_refill_cycles_append_only ON "pharmacy_chronic_refill_cycles";
CREATE TRIGGER pharmacy_chronic_refill_cycles_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_chronic_refill_cycles"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_chronic_refill_history_guard();
DROP TRIGGER pharmacy_chronic_refill_events_append_only ON "pharmacy_chronic_refill_events";
CREATE TRIGGER pharmacy_chronic_refill_events_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_chronic_refill_events"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_chronic_refill_history_guard();

ALTER TABLE "pharmacy_chronic_refill_events" DROP CONSTRAINT "pharmacy_chronic_refill_events_kind_check";
ALTER TABLE "pharmacy_chronic_refill_events" ADD CONSTRAINT "pharmacy_chronic_refill_events_kind_check"
  CHECK ("kind" IN ('EDIT', 'PAUSE', 'REACTIVATE', 'CANCEL', 'SCHEDULER_FAILED', 'OWNER_PIN_APPROVED'));

-- Every new decision takes the same review-item lock used at release/handoff/completion.
-- The server sets this one-item exception only after verifying the owner's live PIN.
CREATE OR REPLACE FUNCTION pharmacy_rx_reject_review_self_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester text;
BEGIN
  SELECT "requestedByUserId" INTO requester FROM "pharmacy_pharmacist_review_items"
    WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."reviewItemId" FOR UPDATE;
  IF NEW."actorUserId" = requester AND NOT COALESCE((
    NEW."kind" = 'SIGN' AND NEW."signedAt" IS NOT NULL AND length(btrim(COALESCE(NEW."reason", ''))) > 0
    AND current_setting('app.current_user_id', true) = NEW."actorUserId"
    AND current_setting('app.chronic_refill_owner_review_item_id', true) = NEW."reviewItemId"
    AND EXISTS (
      SELECT 1 FROM "users" actor
      JOIN "organization_roles" role ON role."organizationId" = actor."organizationId" AND role."id" = actor."organizationRoleId"
      WHERE actor."organizationId" = NEW."organizationId" AND actor."id" = NEW."actorUserId"
        AND actor."status" = 'ACTIVE' AND role."key" IN ('owner', 'owner-operator')
    )
    AND EXISTS (
      SELECT 1 FROM "pharmacy_pharmacist_review_items" item
      JOIN "pharmacy_sale_lines" line ON line."organizationId" = item."organizationId" AND line."id" = item."saleLineId"
      JOIN "pharmacy_medicines" medicine ON medicine."organizationId" = line."organizationId" AND medicine."id" = line."medicineId"
      JOIN "pharmacy_chronic_refill_subscriptions" subscription
        ON subscription."organizationId" = line."organizationId" AND subscription."branchId" = line."branchId"
       AND subscription."prescriptionLineId" = item."prescriptionLineId" AND subscription."medicineId" = line."medicineId"
       AND subscription."presentationId" = line."presentationId" AND subscription."packLevelId" = line."packLevelId"
       AND subscription."quantityPacks" = line."quantity" AND subscription."active" AND subscription."cancelledAt" IS NULL
      WHERE item."organizationId" = NEW."organizationId" AND item."id" = NEW."reviewItemId"
        AND medicine."rx" AND NOT medicine."controlled" AND NOT medicine."restricted"
    )
  ), false) THEN
    RAISE EXCEPTION 'requesting cashier cannot approve pharmacist-required line' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pharmacy_assert_chronic_refill_review(org_id text, branch_id text, order_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM item."id"
  FROM "pharmacy_chronic_refill_cycles" cycle
  JOIN "pharmacy_pharmacist_review_decisions" decision
    ON decision."organizationId" = cycle."organizationId" AND decision."id" = cycle."pharmacistDecisionId"
  JOIN "pharmacy_pharmacist_review_items" item
    ON item."organizationId" = decision."organizationId" AND item."id" = decision."reviewItemId"
  WHERE cycle."organizationId" = org_id AND cycle."branchId" = branch_id AND cycle."orderId" = order_id
  FOR UPDATE OF item;
  IF EXISTS (
    SELECT 1 FROM "pharmacy_chronic_refill_cycles" cycle
    LEFT JOIN "pharmacy_pharmacist_review_decisions" decision
      ON decision."organizationId" = cycle."organizationId" AND decision."id" = cycle."pharmacistDecisionId"
    WHERE cycle."organizationId" = org_id AND cycle."branchId" = branch_id AND cycle."orderId" = order_id
      AND cycle."pharmacistDecisionId" IS NOT NULL AND (
        decision."kind" IS DISTINCT FROM 'SIGN' OR decision."signedAt" IS NULL OR EXISTS (
          SELECT 1 FROM "pharmacy_pharmacist_review_decisions" refusal
          WHERE refusal."organizationId" = decision."organizationId" AND refusal."reviewItemId" = decision."reviewItemId"
            AND refusal."kind" = 'REFUSE' AND refusal."createdAt" >= decision."createdAt"
        )
      )
  ) THEN
    RAISE EXCEPTION 'chronic refill pharmacist approval has been refused' USING ERRCODE = '23514';
  END IF;
END $$;
CREATE FUNCTION pharmacy_guard_chronic_refill_order_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IN ('READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY', 'COMPLETED') THEN
    PERFORM pharmacy_assert_chronic_refill_review(NEW."organizationId", NEW."branchId", NEW."id");
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_chronic_refill_order_review_guard BEFORE UPDATE OF "status" ON "pharmacy_customer_orders"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_chronic_refill_order_review();
CREATE FUNCTION pharmacy_guard_chronic_refill_sale_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE customer_order record;
BEGIN
  IF NEW."status" = 'COMPLETED' THEN
    FOR customer_order IN SELECT "id" FROM "pharmacy_customer_orders"
      WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId" AND "counterSaleId" = NEW."id"
    LOOP
      PERFORM pharmacy_assert_chronic_refill_review(NEW."organizationId", NEW."branchId", customer_order."id");
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_chronic_refill_sale_review_guard BEFORE UPDATE OF "status" ON "pharmacy_sales"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_chronic_refill_sale_review();
-- Recheck after the release transaction's lock wait using a fresh snapshot.
CREATE FUNCTION pharmacy_guard_chronic_refill_cycle_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pharmacy_assert_chronic_refill_review(NEW."organizationId", NEW."branchId", NEW."orderId");
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_chronic_refill_cycle_review_guard AFTER INSERT ON "pharmacy_chronic_refill_cycles"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_chronic_refill_cycle_review();
