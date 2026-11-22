BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TYPE "PharmacyControlledRegisterKind" ADD VALUE IF NOT EXISTS 'RETURN_TO_SUPPLIER';

-- Existing closed documents retain the old policy. Every subsequent dispatch
-- is stamped by the database, even when an older application posts it.
ALTER TABLE pharmacy_purchase_returns
  ADD COLUMN IF NOT EXISTS "dispatchedWithRegisterPolicy" boolean NOT NULL DEFAULT false;

ALTER TABLE pharmacy_controlled_register_entries
  ALTER COLUMN "witnessedByUserId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "supplierReturnReason" text,
  ADD COLUMN IF NOT EXISTS "lateDispatchAt" timestamp(3),
  ADD COLUMN IF NOT EXISTS "sourcePurchaseEntryId" text,
  ADD COLUMN IF NOT EXISTS "supplierReturnLineId" text;

-- PostgreSQL 16 permits use of the new enum literal after this transaction
-- commits. Compare the enum label as text in the two immediate CHECKs.
DO $constraints$
DECLARE register_table regclass := 'pharmacy_controlled_register_entries'::regclass;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = register_table AND conname = 'pharmacy_register_return_purchase_fk') THEN
    ALTER TABLE pharmacy_controlled_register_entries
      ADD CONSTRAINT pharmacy_register_return_purchase_fk FOREIGN KEY ("organizationId", "sourcePurchaseEntryId")
        REFERENCES pharmacy_controlled_register_entries ("organizationId", id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = register_table AND conname = 'pharmacy_register_return_line_fk') THEN
    ALTER TABLE pharmacy_controlled_register_entries
      ADD CONSTRAINT pharmacy_register_return_line_fk FOREIGN KEY ("organizationId", "supplierReturnLineId")
        REFERENCES pharmacy_purchase_return_lines ("organizationId", id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = register_table AND conname = 'pharmacy_register_return_line_once') THEN
    ALTER TABLE pharmacy_controlled_register_entries
      ADD CONSTRAINT pharmacy_register_return_line_once UNIQUE ("organizationId", "supplierReturnLineId");
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = register_table AND conname = 'pharmacy_register_return_source') THEN
    ALTER TABLE pharmacy_controlled_register_entries
      ADD CONSTRAINT pharmacy_register_return_source CHECK (
        ("entryKind"::text = 'RETURN_TO_SUPPLIER') = ("sourcePurchaseEntryId" IS NOT NULL) AND
        ("entryKind"::text = 'RETURN_TO_SUPPLIER') = ("supplierReturnLineId" IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = register_table AND conname = 'pharmacy_register_late_supplier_dispatch') THEN
    ALTER TABLE pharmacy_controlled_register_entries
      ADD CONSTRAINT pharmacy_register_late_supplier_dispatch CHECK (
        "lateDispatchAt" IS NULL OR ("entryKind"::text = 'RETURN_TO_SUPPLIER' AND "lateDispatchAt" <= "createdAt")
      );
  END IF;
END $constraints$;

-- Only a genuinely historical supplier return may have no witness. Keep
-- every existing witness rule for other register kinds, including SQL NULL.
ALTER TABLE pharmacy_controlled_register_entries
  DROP CONSTRAINT IF EXISTS pharmacy_controlled_register_independent_witness;
ALTER TABLE pharmacy_controlled_register_entries
  ADD CONSTRAINT pharmacy_controlled_register_independent_witness CHECK (
    ("witnessedByUserId" IS NOT NULL AND (
      "recordedByUserId" <> "witnessedByUserId"
      OR ("entryKind" = 'CORRECTION' AND "restorationMovementId" IS NOT NULL
          AND COALESCE("signatureRef", '') LIKE 'solo-pin:%')
      OR (COALESCE("signatureRef", '') LIKE 'pharmacist-check-off:%'
          AND ("entryKind" = 'SALE' OR ("entryKind" = 'CORRECTION' AND "restorationMovementId" IS NOT NULL)))
      OR ("entryKind"::text = 'RETURN_TO_SUPPLIER' AND "lateDispatchAt" IS NULL
          AND COALESCE("signatureRef",'') ~ '^solo-(pin|authenticator):')
    ))
    OR ("entryKind"::text = 'RETURN_TO_SUPPLIER' AND "lateDispatchAt" IS NOT NULL
        AND "witnessedByUserId" IS NULL AND COALESCE("signatureRef",'') ~ '^late-owner-(pin|authenticator):')
  );

ALTER TABLE pharmacy_controlled_register_entries DROP CONSTRAINT IF EXISTS pharmacy_controlled_register_kind_shape;
ALTER TABLE pharmacy_controlled_register_entries
  ADD CONSTRAINT "pharmacy_controlled_register_kind_shape" CHECK (
        (
          "entryKind" = 'SALE'
          AND "stockMovementId" IS NOT NULL
          AND "patientId" IS NOT NULL
          AND (
            (
              "emergency" = false
              AND "prescriptionId" IS NOT NULL
              AND "prescriptionLineId" IS NOT NULL
              AND "prescriberId" IS NOT NULL
            )
            OR (
              "emergency" = true
              AND length(btrim(COALESCE("prescriberName", ''))) > 0
            )
          )
        )
        OR (
          "entryKind" = 'SALE'
          AND "stockMovementId" IS NOT NULL
          AND "emergency" = false
          AND COALESCE("signatureRef", '') LIKE 'pharmacist-check-off:%'
        )
        OR (
          "entryKind" = 'PURCHASE'
          AND "stockMovementId" IS NOT NULL
          AND "prescriptionId" IS NULL
          AND length(btrim(COALESCE("counterpartyName", ''))) > 0
        )
        OR (
          "entryKind" = 'CORRECTION'
          AND "correctsEntryId" IS NOT NULL
          AND "stockMovementId" IS NULL
          AND length(btrim(COALESCE("correctionReason", ''))) > 0
        )
        OR (
          "entryKind"::text = 'RETURN_TO_SUPPLIER' AND "stockMovementId" IS NOT NULL
          AND (
            ("lateDispatchAt" IS NULL AND "witnessedByUserId" IS NOT NULL AND "recordedByUserId" <> "witnessedByUserId"
             AND COALESCE("signatureRef", '') ~ '^(pin|authenticator):' AND "supplierReturnReason" IS NULL)
            OR (length(btrim(COALESCE("supplierReturnReason",''))) BETWEEN 1 AND 500 AND (
              ("lateDispatchAt" IS NULL AND "witnessedByUserId" IS NOT NULL AND "recordedByUserId" = "witnessedByUserId"
               AND COALESCE("signatureRef",'') ~ '^solo-(pin|authenticator):')
              OR ("lateDispatchAt" IS NOT NULL AND "witnessedByUserId" IS NULL
                  AND COALESCE("signatureRef",'') ~ '^late-owner-(pin|authenticator):')
            ))
          )
          AND length(btrim(COALESCE("counterpartyName", ''))) > 0
          AND "correctsEntryId" IS NULL AND "restorationMovementId" IS NULL
          AND "prescriptionId" IS NULL AND "patientId" IS NULL AND NOT emergency
        )
      );

-- Older clients supplied the prefix, but always posted an indexed out/returned
-- pair together. Match the document date, original sender, location, lot, both
-- quantities and line ordinal. Prefer the document-bound purchasing screen key;
-- for another client's key, return NULL if the evidence is ambiguous.
CREATE OR REPLACE FUNCTION pharmacy_match_supplier_outgoing_at_cutover(org text, branch text, target_line text)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER AS $legacy$
  WITH line AS (
    SELECT l.*, d."dispatchedAt", d."dispatchedByUserId",
           (SELECT count(*) FROM pharmacy_purchase_return_lines prior
            WHERE prior."organizationId" = org AND prior."purchaseReturnId" = d.id
              AND prior."lineNumber" < l."lineNumber") AS ordinal
    FROM pharmacy_purchase_return_lines l
    JOIN pharmacy_purchase_returns d ON d."organizationId" = org AND d.id = l."purchaseReturnId"
    WHERE l."organizationId" = org AND l.id = target_line AND d."branchId" = branch
      AND d.status IN ('DISPATCHED', 'SETTLED') AND NOT d."dispatchedWithRegisterPolicy"
  ), candidates AS (
    SELECT m.id,
           m."idempotencyKey" = 'return-dispatch:' || l."purchaseReturnId" || ':' || l.ordinal || ':out' AS exact
    FROM line l
    JOIN pharmacy_stock_movements m ON m."organizationId" = org AND m."branchId" = branch
      AND m."inventoryLotId" = l."inventoryLotId" AND m."stockLocationId" = l."stockLocationId"
      AND m."actorId" = l."dispatchedByUserId" AND m."occurredAt" = l."dispatchedAt"
      AND m.kind = 'ADJUSTMENT' AND m.disposition = 'AVAILABLE' AND m."quantityUnits" = -l."quantityUnits"
      AND (m."idempotencyKey" NOT LIKE 'return-dispatch:%'
        OR m."idempotencyKey" = 'return-dispatch:' || l."purchaseReturnId" || ':' || l.ordinal || ':out')
      AND m."idempotencyKey" LIKE '%:' || l.ordinal || ':out'
    JOIN pharmacy_stock_movements incoming ON incoming."organizationId" = org AND incoming."branchId" = branch
      AND incoming."idempotencyKey" = left(m."idempotencyKey", -3) || 'returned'
      AND incoming."inventoryLotId" = m."inventoryLotId" AND incoming."stockLocationId" = m."stockLocationId"
      AND incoming."actorId" = m."actorId" AND incoming."occurredAt" = m."occurredAt"
      AND incoming.kind = 'ADJUSTMENT' AND incoming.disposition = 'RETURN_TO_SUPPLIER'
      AND incoming."quantityUnits" = -m."quantityUnits"
  )
  SELECT CASE WHEN count(*) FILTER (WHERE exact) = 1 THEN min(id) FILTER (WHERE exact)
              WHEN count(*) = 1 THEN min(id) END FROM candidates
$legacy$;

-- Freeze the matches once, while old dispatches and their movements are stable.
-- No register or stock row is written. A migration replay must not fill a gap
-- using a movement recorded after the original cutover.
DO $snapshot$
DECLARE tenant_id text;
BEGIN
  IF EXISTS (SELECT FROM pg_attribute WHERE attrelid = 'pharmacy_purchase_return_lines'::regclass
             AND attname = 'legacyOutgoingMovementId' AND NOT attisdropped) THEN
    RETURN;
  END IF;
  ALTER TABLE pharmacy_purchase_return_lines ADD COLUMN "legacyOutgoingMovementId" text;
  LOCK TABLE pharmacy_stock_movements IN SHARE MODE;
  PERFORM set_config('app.is_platform_admin','true',true);
  FOR tenant_id IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.current_organization_id',tenant_id,true);
    PERFORM set_config('app.current_branch_id','',true);
    WITH matches AS MATERIALIZED (
      SELECT l.id, pharmacy_match_supplier_outgoing_at_cutover(tenant_id,d."branchId",l.id) AS movement
      FROM pharmacy_purchase_return_lines l
      JOIN pharmacy_purchase_returns d ON d."organizationId" = l."organizationId" AND d.id = l."purchaseReturnId"
      WHERE l."organizationId" = tenant_id AND d.status IN ('DISPATCHED','SETTLED')
        AND NOT d."dispatchedWithRegisterPolicy"
        AND (EXISTS (SELECT FROM pharmacy_inventory_lots lot
              JOIN pharmacy_manufacturing_batches b ON b."organizationId" = tenant_id AND b.id = lot."manufacturingBatchId"
              JOIN pharmacy_medicines m ON m."organizationId" = tenant_id AND m.id = b."medicineId"
              WHERE lot."organizationId" = tenant_id AND lot.id = l."inventoryLotId" AND m.controlled)
          OR EXISTS (SELECT FROM pharmacy_controlled_register_entries purchase
              JOIN pharmacy_stock_movements receipt ON receipt."organizationId" = tenant_id AND receipt.id = purchase."stockMovementId"
              WHERE purchase."organizationId" = tenant_id AND purchase."branchId" = d."branchId"
                AND purchase."inventoryLotId" = l."inventoryLotId" AND purchase."entryKind" = 'PURCHASE'
                AND receipt."occurredAt" <= d."dispatchedAt"))
    ), unambiguous AS (
      SELECT movement,min(id) AS line FROM matches WHERE movement IS NOT NULL
      GROUP BY movement HAVING count(*) = 1
    )
    UPDATE pharmacy_purchase_return_lines l SET "legacyOutgoingMovementId" = u.movement
    FROM unambiguous u WHERE l."organizationId" = tenant_id AND l.id = u.line;
  END LOOP;
  PERFORM set_config('app.current_organization_id','',true);
  PERFORM set_config('app.is_platform_admin','false',true);
END $snapshot$;

DROP FUNCTION pharmacy_match_supplier_outgoing_at_cutover(text,text,text);

CREATE OR REPLACE FUNCTION pharmacy_guard_supplier_return_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $immutable$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."legacyOutgoingMovementId" IS NULL THEN RETURN NEW; END IF;
  ELSIF NEW."legacyOutgoingMovementId" IS NOT DISTINCT FROM OLD."legacyOutgoingMovementId"
    AND (OLD."legacyOutgoingMovementId" IS NULL OR
      (NEW."organizationId", NEW."branchId", NEW."purchaseReturnId", NEW.id)
      IS NOT DISTINCT FROM (OLD."organizationId", OLD."branchId", OLD."purchaseReturnId", OLD.id)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The legacy supplier movement snapshot is immutable.' USING ERRCODE='23514';
END $immutable$;
DROP TRIGGER IF EXISTS pharmacy_supplier_return_snapshot_immutable ON pharmacy_purchase_return_lines;
CREATE TRIGGER pharmacy_supplier_return_snapshot_immutable BEFORE INSERT OR UPDATE ON pharmacy_purchase_return_lines
FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_supplier_return_snapshot();

CREATE OR REPLACE FUNCTION pharmacy_require_legacy_supplier_outgoing(org text, branch text, target_line text, movement text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER AS $captured$
BEGIN
  IF NOT EXISTS (SELECT FROM pharmacy_purchase_return_lines l JOIN pharmacy_purchase_returns d
    ON d."organizationId" = l."organizationId" AND d.id = l."purchaseReturnId"
    WHERE l."organizationId" = org AND l."branchId" = branch AND l.id = target_line
      AND d."branchId" = branch AND d.status IN ('DISPATCHED','SETTLED') AND NOT d."dispatchedWithRegisterPolicy"
      AND l."legacyOutgoingMovementId" = movement) THEN
    RAISE EXCEPTION 'This outgoing movement was not captured at migration for this return line.' USING ERRCODE='23514';
  END IF;
  RETURN true;
END $captured$;

-- The stock ledger keeps dispatched units in a separate disposition. Develop
-- counted those units. Deduct only returns for which a register line exists,
-- including the current line in the AFTER INSERT reconciliation trigger.
CREATE OR REPLACE FUNCTION pharmacy_controlled_stock_for_register(org text, branch text, lot text)
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER AS $balance$
  SELECT (SELECT COALESCE(sum("onHandUnits"), 0) FROM pharmacy_stock_balances
          WHERE "organizationId" = org AND "branchId" = branch AND "inventoryLotId" = lot
            AND disposition <> 'QUARANTINE')
       - (SELECT COALESCE(sum("quantityCanonicalUnits"), 0) FROM pharmacy_controlled_register_entries
          WHERE "organizationId" = org AND "branchId" = branch AND "inventoryLotId" = lot
            AND "entryKind"::text = 'RETURN_TO_SUPPLIER')
$balance$;

-- A document dispatched by an older client after upgrade must also have its
-- witnessed entries. Historical documents are never updated by the migration.
CREATE OR REPLACE FUNCTION pharmacy_require_controlled_dispatch_entries() RETURNS trigger
LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."dispatchedWithRegisterPolicy" := NEW.status IN ('DISPATCHED', 'SETTLED');
    RETURN NEW;
  END IF;
  NEW."dispatchedWithRegisterPolicy" := OLD."dispatchedWithRegisterPolicy";
  IF NEW.status NOT IN ('DISPATCHED','SETTLED') OR OLD.status IN ('DISPATCHED','SETTLED') THEN RETURN NEW; END IF;
  NEW."dispatchedWithRegisterPolicy" := true;
  IF EXISTS (
    SELECT FROM pharmacy_purchase_return_lines l
    JOIN pharmacy_inventory_lots lot ON lot."organizationId" = l."organizationId" AND lot.id = l."inventoryLotId"
    JOIN pharmacy_manufacturing_batches b ON b."organizationId" = lot."organizationId" AND b.id = lot."manufacturingBatchId"
    JOIN pharmacy_medicines m ON m."organizationId" = b."organizationId" AND m.id = b."medicineId"
    WHERE l."organizationId" = NEW."organizationId" AND l."purchaseReturnId" = NEW.id AND m.controlled
      AND NOT EXISTS (SELECT FROM pharmacy_controlled_register_entries e
        WHERE e."organizationId" = l."organizationId" AND e."supplierReturnLineId" = l.id)
  ) THEN
    RAISE EXCEPTION 'A controlled supplier dispatch requires a witnessed register entry.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $guard$;
DROP TRIGGER IF EXISTS pharmacy_controlled_dispatch_entries ON pharmacy_purchase_returns;
CREATE TRIGGER pharmacy_controlled_dispatch_entries BEFORE INSERT OR UPDATE OF status, "dispatchedWithRegisterPolicy" ON pharmacy_purchase_returns
FOR EACH ROW
EXECUTE FUNCTION pharmacy_require_controlled_dispatch_entries();

CREATE OR REPLACE FUNCTION pharmacy_rx_reconcile_controlled_register() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual integer; movement record; lot_batch text; original record; previous_balance bigint; derived_delta bigint; restored bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."organizationId"||':'||NEW."branchId",0));
  IF EXISTS (
    SELECT 1 FROM "pharmacy_register_incidents"
    WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "status"='OPEN'
  ) THEN
    RAISE EXCEPTION 'controlled dispensing blocked by open register incident' USING ERRCODE='23514';
  END IF;
  IF NEW."serial" <> COALESCE((
    SELECT max("serial")+1 FROM "pharmacy_controlled_register_entries"
    WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "id"<>NEW."id"
  ),1) THEN
    RAISE EXCEPTION 'controlled register serial must be consecutive' USING ERRCODE='23514';
  END IF;

  IF NEW."entryKind" = 'CORRECTION' THEN
    SELECT * INTO original FROM "pharmacy_controlled_register_entries"
      WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."correctsEntryId";
    IF NOT FOUND OR original."entryKind" NOT IN ('PURCHASE', 'SALE')
       OR original."branchId" IS DISTINCT FROM NEW."branchId"
       OR original."inventoryLotId" IS DISTINCT FROM NEW."inventoryLotId"
       OR original."medicineId" IS DISTINCT FROM NEW."medicineId"
       OR original."batchNumber" IS DISTINCT FROM NEW."batchNumber" THEN
      RAISE EXCEPTION 'correction must reference an original entry in the same lot register' USING ERRCODE='23514';
    END IF;
    IF NEW."restorationMovementId" IS NULL THEN
      IF EXISTS (SELECT 1 FROM "pharmacy_controlled_register_entries"
        WHERE "organizationId"=NEW."organizationId" AND "correctsEntryId"=original."id" AND "id"<>NEW."id") THEN
        RAISE EXCEPTION 'entry already corrected' USING ERRCODE='23514';
      END IF;
      derived_delta := CASE WHEN original."entryKind"='SALE'
        THEN original."quantityCanonicalUnits"::bigint - NEW."quantityCanonicalUnits"
        ELSE NEW."quantityCanonicalUnits"::bigint - original."quantityCanonicalUnits" END;
      IF NEW."quantityCanonicalUnits" <= 0 OR abs(derived_delta)>original."quantityCanonicalUnits" THEN
        RAISE EXCEPTION 'correction quantity exceeds original cap' USING ERRCODE='23514';
      END IF;
      -- The database derives the delta too; callers cannot supply an arbitrary change.
      IF NEW."balanceDelta"::bigint IS DISTINCT FROM derived_delta THEN
        RAISE EXCEPTION 'correction delta must be derived from original quantity' USING ERRCODE='23514';
      END IF;
    ELSIF original."entryKind" = 'PURCHASE' THEN
      SELECT * INTO movement FROM "pharmacy_stock_movements"
        WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."restorationMovementId";
      IF NOT FOUND OR movement."kind" IS DISTINCT FROM 'ADJUSTMENT'
         OR movement."branchId" IS DISTINCT FROM NEW."branchId"
         OR movement."inventoryLotId" IS DISTINCT FROM NEW."inventoryLotId"
         OR movement."reversesMovementId" IS DISTINCT FROM original."stockMovementId"
         OR movement."disposition" = 'QUARANTINE'
         OR movement."quantityUnits"::bigint IS DISTINCT FROM -original."quantityCanonicalUnits"::bigint
         OR NEW."quantityCanonicalUnits" <> 0
         OR NEW."balanceDelta" IS DISTINCT FROM movement."quantityUnits" THEN
        RAISE EXCEPTION 'purchase reversal must match a compensating receipt movement' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO movement FROM "pharmacy_stock_movements"
        WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."restorationMovementId";
      IF NOT FOUND OR original."entryKind" <> 'SALE'
         OR movement."branchId" IS DISTINCT FROM NEW."branchId"
         OR movement."inventoryLotId" IS DISTINCT FROM NEW."inventoryLotId"
         OR movement."quantityUnits" IS DISTINCT FROM NEW."quantityCanonicalUnits"
         OR movement."quantityUnits" <= 0
         OR NOT COALESCE((
           (movement."kind"='ADJUSTMENT' AND movement."reversesMovementId"=original."stockMovementId")
           OR (movement."kind"='RETURN' AND EXISTS (
             SELECT 1 FROM "pharmacy_sale_return_lines" r
             JOIN "pharmacy_sale_line_allocations" a ON a."organizationId"=r."organizationId"
               AND a."saleLineId"=r."saleLineId" AND a."inventoryLotId"=r."inventoryLotId"
             WHERE r."organizationId"=NEW."organizationId" AND r."stockMovementId"=movement."id"
               AND a."stockMovementId"=original."stockMovementId"
           ))
         ), false) THEN
        RAISE EXCEPTION 'restoration must match a compensating stock movement' USING ERRCODE='23514';
      END IF;
      SELECT COALESCE(sum("quantityCanonicalUnits"),0) INTO restored
        FROM "pharmacy_controlled_register_entries"
        WHERE "organizationId"=NEW."organizationId" AND "correctsEntryId"=original."id"
          AND "restorationMovementId" IS NOT NULL AND "id"<>NEW."id";
      IF restored + NEW."quantityCanonicalUnits" > original."quantityCanonicalUnits" THEN
        RAISE EXCEPTION 'restoration exceeds original quantity' USING ERRCODE='23514';
      END IF;
      IF NEW."balanceDelta" IS DISTINCT FROM (CASE WHEN movement."disposition"='QUARANTINE' THEN 0 ELSE movement."quantityUnits" END) THEN
        RAISE EXCEPTION 'restoration delta must match sellable movement' USING ERRCODE='23514';
      END IF;
    END IF;
    SELECT "runningBalance" INTO previous_balance FROM "pharmacy_controlled_register_entries"
      WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId"
        AND "inventoryLotId"=NEW."inventoryLotId" AND "medicineId"=NEW."medicineId" AND "id"<>NEW."id"
      ORDER BY "serial" DESC LIMIT 1;
    actual := pharmacy_controlled_stock_for_register(NEW."organizationId", NEW."branchId", NEW."inventoryLotId");
    IF NEW."runningBalance"::bigint IS DISTINCT FROM previous_balance + NEW."balanceDelta"
       OR NEW."runningBalance" IS DISTINCT FROM actual THEN
      RAISE EXCEPTION 'correction balance must equal sellable on-hand and prior balance plus delta' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO movement FROM "pharmacy_stock_movements"
    WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."stockMovementId";
  IF NEW."entryKind" = 'PURCHASE' THEN
    IF movement."kind"<>'RECEIPT' OR movement."branchId"<>NEW."branchId"
       OR movement."inventoryLotId"<>NEW."inventoryLotId"
       OR movement."quantityUnits"<>NEW."quantityCanonicalUnits" THEN
      RAISE EXCEPTION 'controlled register purchase does not match stock ledger movement' USING ERRCODE='23514';
    END IF;
  ELSIF NEW."entryKind" = 'RETURN_TO_SUPPLIER' THEN
    -- The two self-confirmations are narrowly scoped exceptions. Recheck the
    -- live owner or the absence of another eligible dispenser at insertion.
    IF NEW."lateDispatchAt" IS NOT NULL THEN
      IF NEW."recordedByUserId" IS DISTINCT FROM NULLIF(current_setting('app.current_user_id',true),'')
        OR NOT EXISTS (
          SELECT FROM users u LEFT JOIN organization_roles r
            ON r."organizationId" = u."organizationId" AND r.id = u."organizationRoleId"
          CROSS JOIN LATERAL (
            SELECT bool_or(g.effect = 'DENY') AS denied,
                   bool_or(g.capability = '*' AND g.effect = 'ALLOW') AS unrestricted
            FROM (SELECT p.capability,p.effect FROM organization_role_permissions p
                    WHERE p."organizationId" = u."organizationId" AND p."organizationRoleId" = r.id
                  UNION ALL SELECT o.capability,o.effect FROM user_permission_overrides o
                    WHERE o."organizationId" = u."organizationId" AND o."userId" = u.id
                      AND (o."expiresAt" IS NULL OR o."expiresAt" > CURRENT_TIMESTAMP)) g
          ) grants
          WHERE u."organizationId" = NEW."organizationId" AND u.id = NEW."recordedByUserId"
            AND u.status = 'ACTIVE' AND NOT COALESCE(grants.denied,false)
            AND ((r."isSystem" AND r.key = 'owner') OR (u.role = 'ADMIN' AND grants.unrestricted))
        ) THEN
        RAISE EXCEPTION 'Only the acting pharmacy owner may confirm a late register entry.' USING ERRCODE='23514';
      END IF;
      PERFORM pharmacy_require_legacy_supplier_outgoing(NEW."organizationId", NEW."branchId", NEW."supplierReturnLineId", NEW."stockMovementId");
    ELSIF NEW."recordedByUserId" = NEW."witnessedByUserId" THEN
      IF EXISTS (
        SELECT FROM users u WHERE u."organizationId" = NEW."organizationId" AND u.id <> NEW."recordedByUserId"
          AND u.status IN ('ACTIVE','ON_LEAVE') AND EXISTS (
            SELECT FROM organization_role_permissions p WHERE p."organizationId" = u."organizationId"
              AND p."organizationRoleId" = u."organizationRoleId" AND p.capability = 'pharmacy:dispense' AND p.effect = 'ALLOW'
            UNION ALL SELECT FROM user_permission_overrides o WHERE o."organizationId" = u."organizationId"
              AND o."userId" = u.id AND o.capability = 'pharmacy:dispense' AND o.effect = 'ALLOW'
              AND (o."expiresAt" IS NULL OR o."expiresAt" > CURRENT_TIMESTAMP)
          )
      ) THEN
        RAISE EXCEPTION 'A second pharmacist must witness this supplier dispatch.' USING ERRCODE='23514';
      END IF;
    END IF;
    -- Follow both sides to the receipt and supplier. Lot or supplier names alone
    -- cannot prove where a purchase or dispatch came from.
    IF NOT EXISTS (
      SELECT 1 FROM pharmacy_controlled_register_entries purchase
      JOIN pharmacy_stock_movements receipt ON receipt."organizationId" = purchase."organizationId"
        AND receipt.id = purchase."stockMovementId"
      JOIN pharmacy_goods_receipt_lines grl ON grl."organizationId" = purchase."organizationId"
        AND receipt."idempotencyKey" = 'pharmacy-receipt:' || grl.id || ':accepted'
      JOIN pharmacy_goods_receipts gr ON gr."organizationId" = grl."organizationId" AND gr.id = grl."goodsReceiptId"
      JOIN pharmacy_purchase_return_lines line ON line."organizationId" = gr."organizationId"
        AND line.id = NEW."supplierReturnLineId"
      JOIN pharmacy_purchase_returns doc ON doc."organizationId" = line."organizationId" AND doc.id = line."purchaseReturnId"
      JOIN pharmacy_suppliers supplier ON supplier."organizationId" = doc."organizationId" AND supplier.id = doc."supplierId"
      WHERE purchase."organizationId" = NEW."organizationId" AND purchase.id = NEW."sourcePurchaseEntryId"
        AND purchase."entryKind" = 'PURCHASE' AND gr.status = 'POSTED'
        AND gr."supplierId" = doc."supplierId" AND NEW."counterpartyName" = supplier.name
        AND NEW."branchId" = purchase."branchId" AND doc."branchId" = NEW."branchId"
        AND purchase."medicineId" = NEW."medicineId" AND purchase."inventoryLotId" = NEW."inventoryLotId"
        AND line."inventoryLotId" = NEW."inventoryLotId" AND line."stockLocationId" = movement."stockLocationId"
        AND movement."branchId" = NEW."branchId" AND movement."inventoryLotId" = NEW."inventoryLotId"
        AND movement.kind = 'ADJUSTMENT' AND movement.disposition = 'AVAILABLE'
        AND (
          (NEW."lateDispatchAt" IS NULL AND doc.status = 'SUBMITTED'
           AND movement."actorId" = NEW."recordedByUserId"
           AND movement."idempotencyKey" = 'supplier-return:' || line.id || ':out')
          OR (NEW."lateDispatchAt" IS NOT NULL AND doc.status IN ('DISPATCHED','SETTLED')
              AND NEW."lateDispatchAt" = doc."dispatchedAt" AND movement."occurredAt" = doc."dispatchedAt"
              AND movement."actorId" = doc."dispatchedByUserId" AND receipt."occurredAt" <= movement."occurredAt"
              AND NEW."createdAt"::date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
              AND movement.id = line."legacyOutgoingMovementId")
        )
        AND movement."quantityUnits" = -line."quantityUnits"
        AND NEW."quantityCanonicalUnits" = line."quantityUnits" AND NEW."balanceDelta" = movement."quantityUnits"
        AND purchase."quantityCanonicalUnits" >= (SELECT sum(r."quantityCanonicalUnits") FROM pharmacy_controlled_register_entries r
          WHERE r."organizationId" = NEW."organizationId" AND r."sourcePurchaseEntryId" = purchase.id)
    ) THEN
      RAISE EXCEPTION 'controlled supplier return must match the original purchase and outgoing dispatch movement' USING ERRCODE='23514';
    END IF;
    SELECT "runningBalance" INTO previous_balance FROM pharmacy_controlled_register_entries
      WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "inventoryLotId"=NEW."inventoryLotId"
        AND "medicineId"=NEW."medicineId" AND serial < NEW.serial ORDER BY serial DESC LIMIT 1;
    IF previous_balance + NEW."balanceDelta" IS DISTINCT FROM NEW."runningBalance" THEN
      RAISE EXCEPTION 'controlled supplier return balance must follow the previous entry' USING ERRCODE='23514';
    END IF;
  ELSE
    IF movement."kind"<>'SALE' OR movement."branchId"<>NEW."branchId"
       OR movement."inventoryLotId"<>NEW."inventoryLotId"
       OR movement."quantityUnits"<>-NEW."quantityCanonicalUnits" THEN
      RAISE EXCEPTION 'controlled register entry does not match stock ledger movement' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT b."batchNumber" INTO lot_batch
    FROM "pharmacy_inventory_lots" l
    JOIN "pharmacy_manufacturing_batches" b
      ON b."organizationId"=l."organizationId" AND b."id"=l."manufacturingBatchId"
    WHERE l."organizationId"=NEW."organizationId" AND l."id"=NEW."inventoryLotId";
  IF lot_batch IS DISTINCT FROM NEW."batchNumber" THEN
    RAISE EXCEPTION 'controlled register batch does not match stock lot' USING ERRCODE='23514';
  END IF;
  actual := pharmacy_controlled_stock_for_register(NEW."organizationId", NEW."branchId", NEW."inventoryLotId");
  IF NEW."runningBalance"<>actual THEN
    IF NEW."entryKind" = 'RETURN_TO_SUPPLIER' THEN
      RAISE EXCEPTION 'controlled supplier return must reconcile with stock on hand' USING ERRCODE='23514';
    END IF;
    INSERT INTO "pharmacy_register_incidents" ("id","organizationId","branchId","registerEntryId","expectedBalance","actualBalance")
    VALUES ('ri_'||md5(random()::text||clock_timestamp()::text),NEW."organizationId",NEW."branchId",NEW."id",NEW."runningBalance",actual);
  END IF;
  RETURN NEW;
END $$;

COMMIT;
