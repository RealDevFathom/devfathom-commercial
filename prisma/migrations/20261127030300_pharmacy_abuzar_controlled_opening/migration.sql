BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TYPE "PharmacyControlledRegisterKind" ADD VALUE IF NOT EXISTS 'OPENING';

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
        OR (
          "entryKind"::text='OPENING' AND "stockMovementId" IS NOT NULL AND "medicineId" IS NOT NULL
          AND "witnessedByUserId" IS NOT NULL AND "witnessedByUserId"<>"recordedByUserId"
          AND COALESCE("signatureRef",'') ~ '^abuzar-opening:[a-f0-9-]{36}$'
          AND "prescriptionId" IS NULL AND "prescriptionLineId" IS NULL AND "patientId" IS NULL
          AND "prescriberId" IS NULL AND "correctsEntryId" IS NULL AND "restorationMovementId" IS NULL
          AND "quantityCanonicalUnits">0 AND NOT emergency
        )
      );

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

  IF NEW."entryKind"::text='OPENING' THEN
    IF NOT EXISTS (
      SELECT FROM pharmacy_abuzar_openings a
      JOIN pharmacy_opening_stock_lines l ON l."organizationId"=a."organizationId" AND l.id=a."openingLineId"
      JOIN pharmacy_stock_movements m ON m."organizationId"=l."organizationId" AND m.id=l."postedMovementId"
      JOIN pharmacy_inventory_lots lot ON lot."organizationId"=l."organizationId" AND lot.id=l."postedLotId"
      JOIN pharmacy_manufacturing_batches b ON b."organizationId"=lot."organizationId" AND b.id=lot."manufacturingBatchId"
      JOIN pharmacy_medicines p ON p."organizationId"=b."organizationId" AND p.id=b."medicineId"
      JOIN audit_logs auth ON auth."organizationId"=a."organizationId" AND 'abuzar-opening:'||auth.id=NEW."signatureRef"
      WHERE a."organizationId"=NEW."organizationId" AND a."branchId"=NEW."branchId"
        AND m.kind='OPENING' AND m.id=NEW."stockMovementId" AND lot.id=NEW."inventoryLotId"
        AND m."inventoryLotId"=lot.id AND m."quantityUnits"=NEW."quantityCanonicalUnits"
        AND p.controlled AND p.id=NEW."medicineId" AND b."batchNumber" IS NOT DISTINCT FROM NEW."batchNumber"
        AND NEW."balanceDelta"=CASE WHEN m.disposition='QUARANTINE' THEN 0 ELSE m."quantityUnits" END
        AND NEW."runningBalance"=NEW."balanceDelta"
        AND NEW."runningBalance"=pharmacy_controlled_stock_for_register(a."organizationId",a."branchId",lot.id)
        AND auth."actorId"=NEW."witnessedByUserId" AND auth.action='pharmacy.abuzar.openingWitness'
        AND auth.metadata->>'recordedBy'=NEW."recordedByUserId" AND auth.metadata->>'sessionId'=l."sessionId"
        AND auth.outcome='SUCCESS'
    ) THEN RAISE EXCEPTION 'controlled opening must reconcile to its witnessed source movement' USING ERRCODE='23514'; END IF;
    RETURN NEW;
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


CREATE OR REPLACE FUNCTION pharmacy_require_abuzar_opening_register() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT FROM pharmacy_opening_stock_lines l
    JOIN pharmacy_manufacturing_batches b ON b."organizationId"=l."organizationId" AND b.id=l."manufacturingBatchId"
    JOIN pharmacy_medicines p ON p."organizationId"=b."organizationId" AND p.id=b."medicineId"
    WHERE l."organizationId"=NEW."organizationId" AND l.id=NEW."openingLineId" AND p.controlled AND l."countedUnits">0
      AND NOT EXISTS (SELECT FROM pharmacy_controlled_register_entries e WHERE e."organizationId"=l."organizationId"
        AND e."entryKind"::text='OPENING' AND e."stockMovementId"=l."postedMovementId")
  ) THEN RAISE EXCEPTION 'controlled opening requires a register entry' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_trigger WHERE tgrelid='pharmacy_abuzar_openings'::regclass AND tgname='abuzar_require_register') THEN
    CREATE CONSTRAINT TRIGGER abuzar_require_register AFTER INSERT ON pharmacy_abuzar_openings
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pharmacy_require_abuzar_opening_register();
  END IF;
END $$;

COMMIT;
