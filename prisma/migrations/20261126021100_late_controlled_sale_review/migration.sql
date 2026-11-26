BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE pharmacy_controlled_register_entries
  ADD COLUMN IF NOT EXISTS "lateSaleLineId" text,
  ADD COLUMN IF NOT EXISTS "originalSaleAt" timestamp(3),
  ADD COLUMN IF NOT EXISTS "lateEntryReason" text;

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
    OR ("entryKind" = 'CORRECTION' AND "restorationMovementId" IS NOT NULL
        AND "witnessedByUserId" IS NULL AND "signatureRef" IS NOT NULL
        AND "witnessStatement" IS NOT DISTINCT FROM 'No witness')
    OR ("entryKind" = 'SALE' AND "witnessedByUserId" IS NULL
        AND "witnessStatement" IS NOT DISTINCT FROM 'No witness: dispensed by one pharmacist'
        AND NOT emergency AND "signatureRef" IS NOT NULL)
    OR ("entryKind"='SALE' AND "lateSaleLineId" IS NOT NULL
        AND "witnessStatement" IS NOT DISTINCT FROM 'No witness: recorded late by one pharmacist'
        AND "witnessedByUserId" IS NULL AND NOT emergency AND "signatureRef" IS NOT NULL)
    OR ("entryKind"::text = 'RETURN_TO_SUPPLIER' AND "lateDispatchAt" IS NOT NULL
        AND "witnessedByUserId" IS NULL AND COALESCE("signatureRef",'') ~ '^late-owner-(pin|authenticator):')
  );

ALTER TABLE pharmacy_controlled_register_entries DROP CONSTRAINT IF EXISTS pharmacy_late_sale_fields;
ALTER TABLE pharmacy_controlled_register_entries ADD CONSTRAINT pharmacy_late_sale_fields CHECK (
  ("lateSaleLineId" IS NULL AND "originalSaleAt" IS NULL AND "lateEntryReason" IS NULL)
  OR ("lateSaleLineId" IS NOT NULL AND "originalSaleAt" IS NOT NULL AND "createdAt" >= "originalSaleAt"
    AND "lateEntryReason" IS NOT NULL AND length(btrim("lateEntryReason")) BETWEEN 1 AND 500
    AND "entryKind"='SALE' AND NOT emergency AND "witnessedByUserId" IS NULL
    AND "witnessStatement" IS NOT DISTINCT FROM 'No witness: recorded late by one pharmacist')
);

CREATE OR REPLACE FUNCTION pharmacy_rx_reject_review_self_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester text; review_sale_line text;
BEGIN
  SELECT "requestedByUserId", "saleLineId" INTO requester, review_sale_line
    FROM "pharmacy_pharmacist_review_items"
   WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."reviewItemId";
  -- Only a line with its original non-controlled prescription reference can use late review.
  IF NEW.kind='SIGN' AND EXISTS (
    SELECT 1 FROM pharmacy_sale_lines l JOIN pharmacy_medicines m
      ON m."organizationId"=l."organizationId" AND m.id=l."medicineId"
    WHERE l."organizationId"=NEW."organizationId" AND l.id=review_sale_line
      AND m.controlled AND l."prescriptionLineId" IS NOT NULL
  ) THEN
    IF NEW."signedAt" IS NULL OR NOT EXISTS (
      SELECT 1 FROM pharmacy_sale_lines l JOIN pharmacy_branches b
        ON b."organizationId"=l."organizationId" AND b.id=l."branchId" AND b.active
      JOIN audit_logs a ON a."organizationId"=l."organizationId" AND a.id=NEW."selfApprovalAuditId"
      WHERE l.id=review_sale_line AND l."organizationId"=NEW."organizationId"
        AND a.xmin=pg_current_xact_id()::xid AND a."actorId"=NEW."actorUserId"
        AND a.action='pharmacyDispensing.lateControlledReview' AND a.outcome='SUCCESS'
        AND a."targetType"='PharmacyPharmacistReviewItem' AND a."targetId"=NEW."reviewItemId"
        AND length(btrim(NEW.reason)) BETWEEN 1 AND 500
        AND a.metadata @> jsonb_build_object('selfApproved',true,'branchId',l."branchId",
            'saleId',l."saleId",'saleLineId',l.id,'reviewItemId',NEW."reviewItemId",'reason',NEW.reason)
        AND (a.metadata @> '{"approvalMethod":"PIN","pinVerified":true}'
          OR a.metadata @> '{"approvalMethod":"AUTHENTICATOR","authenticatorVerified":true}')
      FOR SHARE OF b
    ) THEN RAISE EXCEPTION 'a controlled medicine needs an independent pharmacist signature or verified late review' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."actorUserId" IS DISTINCT FROM requester THEN
    -- DEV-950: the self-approval marker belongs only on the requester's own signature.
    IF NEW."selfApprovalAuditId" IS NOT NULL THEN
      RAISE EXCEPTION 'a self-approval marker is only for the requester''s own signature' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  -- An explicitly verified controlled review gets its own sale-bound approval.
  IF NEW."kind" = 'SIGN' AND NEW."signedAt" IS NOT NULL AND NEW."selfApprovalAuditId" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pharmacy_sale_lines l
      JOIN pharmacy_medicines m ON m.id=l."medicineId" AND m."organizationId"=l."organizationId"
      JOIN pharmacy_branches b ON b.id=l."branchId" AND b."organizationId"=l."organizationId"
      JOIN audit_logs a ON a.id=NEW."selfApprovalAuditId" AND a."organizationId"=l."organizationId"
      WHERE l.id=review_sale_line AND l."organizationId"=NEW."organizationId" AND m.controlled
        AND b.active AND NOT b."requireSecondPharmacist"
        AND a.xmin=pg_current_xact_id()::xid
        AND a."actorId"=requester AND a.action='pharmacySales.controlledSelfApproval'
        AND a.outcome='SUCCESS' AND a."targetType"='PharmacyPharmacistReviewItem'
        AND a."targetId"=NEW."reviewItemId"
        AND a.metadata @> jsonb_build_object('selfApproved',true,'branchId',l."branchId",
          'saleId',l."saleId",'saleLineId',l.id,'reviewItemId',NEW."reviewItemId")
        AND (a.metadata @> '{"approvalMethod":"PIN","pinVerified":true}'
          OR a.metadata @> '{"approvalMethod":"AUTHENTICATOR","authenticatorVerified":true}')
      FOR SHARE OF b
    ) THEN RETURN NEW;
  END IF;
  -- The requester's own decision: refused unless it is the audited solo self-signature.
  IF NEW."kind" <> 'SIGN' OR NEW."signedAt" IS NULL OR NEW."selfApprovalAuditId" IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM "audit_logs" a
        WHERE a."id" = NEW."selfApprovalAuditId"
          AND a."organizationId" = NEW."organizationId"
          AND a."actorId" = NEW."actorUserId"
          AND a."action" = 'pharmacyDispensing.selfSignReview'
          AND a."outcome" = 'SUCCESS'
          AND a."targetId" = NEW."reviewItemId"
          AND a."metadata"->>'selfApproved' = 'true'
          AND a."metadata"->>'pinVerified' = 'true'
          AND a."metadata"->>'reviewItemId' = NEW."reviewItemId"
          AND a."metadata"->>'saleLineId' = review_sale_line
     ) THEN
    RAISE EXCEPTION 'requesting cashier cannot approve pharmacist-required line' USING ERRCODE='42501';
  END IF;
  -- Fail closed: the line must be found, with a medicine that is not controlled.
  IF NOT EXISTS (
    SELECT 1 FROM "pharmacy_sale_lines" l
      JOIN "pharmacy_medicines" m ON m."id" = l."medicineId"
     WHERE l."organizationId" = NEW."organizationId" AND l."id" = review_sale_line
       AND m."controlled" = false
  ) THEN
    RAISE EXCEPTION 'a controlled medicine needs an independent pharmacist signature' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;


DROP TRIGGER IF EXISTS pharmacy_check_controlled_sale_witness ON pharmacy_controlled_register_entries;
CREATE TRIGGER pharmacy_check_controlled_sale_witness BEFORE INSERT ON pharmacy_controlled_register_entries
  FOR EACH ROW WHEN (NEW."entryKind" <> 'CORRECTION' AND NEW."lateSaleLineId" IS NULL) EXECUTE FUNCTION pharmacy_check_controlled_sale_witness();

CREATE OR REPLACE FUNCTION pharmacy_check_late_controlled_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."witnessStatement" <> 'No witness: recorded late by one pharmacist'
    OR NEW."entryKind" <> 'SALE' OR NEW.emergency OR NEW."witnessedByUserId" IS NOT NULL
    OR NULLIF(btrim(NEW."patientAddress"),'') IS NULL OR NOT EXISTS (
      SELECT 1 FROM pharmacy_pharmacist_review_decisions d
      JOIN pharmacy_pharmacist_review_items i ON i.id=d."reviewItemId" AND i."organizationId"=d."organizationId"
      JOIN pharmacy_sale_lines l ON l.id=i."saleLineId" AND l."organizationId"=i."organizationId"
      JOIN pharmacy_sales s ON s.id=l."saleId" AND s."organizationId"=l."organizationId" AND s."branchId"=l."branchId"
      JOIN pharmacy_sale_line_allocations al ON al."organizationId"=l."organizationId" AND al."saleLineId"=l.id
      JOIN audit_logs a ON a.id=d."selfApprovalAuditId" AND a."organizationId"=d."organizationId"
      JOIN pharmacy_prescription_lines rx ON rx.id=i."prescriptionLineId" AND rx."organizationId"=i."organizationId"
      JOIN pharmacy_prescriptions p ON p.id=rx."prescriptionId" AND p."organizationId"=rx."organizationId"
      WHERE d.id=NEW."signatureRef" AND d."organizationId"=NEW."organizationId"
        AND d.kind='SIGN' AND d."actorUserId"=NEW."recordedByUserId" AND d.reason=NEW."lateEntryReason"
        AND l.id=NEW."lateSaleLineId" AND COALESCE(s."completedAt",l."createdAt")=NEW."originalSaleAt" AND d."signedAt"=NEW."createdAt"
        AND l."prescriptionLineId"=rx.id AND l."prescriptionPatientId"=p."patientId"
        AND al."inventoryLotId"=NEW."inventoryLotId" AND al."canonicalUnits"=NEW."quantityCanonicalUnits"
        AND a.action='pharmacyDispensing.lateControlledReview' AND a.xmin=pg_current_xact_id()::xid
        AND al."stockMovementId"=NEW."stockMovementId" AND l."branchId"=NEW."branchId"
        AND l."medicineId"=NEW."medicineId" AND rx."medicineId"=l."medicineId"
        AND rx.id=NEW."prescriptionLineId" AND p.id=NEW."prescriptionId"
        AND p."patientId"=NEW."patientId" AND p."prescriberId"=NEW."prescriberId"
    ) THEN
    RAISE EXCEPTION 'controlled register requires its verified self-approval' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_check_late_controlled_sale ON pharmacy_controlled_register_entries;
CREATE TRIGGER pharmacy_check_late_controlled_sale BEFORE INSERT ON pharmacy_controlled_register_entries
  FOR EACH ROW WHEN (NEW."lateSaleLineId" IS NOT NULL) EXECUTE FUNCTION pharmacy_check_late_controlled_sale();

-- A solo decision also requires a complete register entry for every allocation at commit.
CREATE OR REPLACE FUNCTION pharmacy_require_solo_dispense_register() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_id text;
BEGIN
  IF NEW."selfApprovalAuditId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM audit_logs WHERE id=NEW."selfApprovalAuditId" AND "organizationId"=NEW."organizationId"
      AND action IN ('pharmacySales.controlledSelfApproval','pharmacyDispensing.lateControlledReview')
  ) THEN RETURN NULL; END IF;
  SELECT "saleLineId" INTO STRICT line_id FROM pharmacy_pharmacist_review_items
    WHERE id=NEW."reviewItemId" AND "organizationId"=NEW."organizationId";
  IF NOT EXISTS (SELECT 1 FROM pharmacy_sale_line_allocations WHERE "organizationId"=NEW."organizationId" AND "saleLineId"=line_id)
    OR EXISTS (
      SELECT 1 FROM pharmacy_sale_line_allocations al WHERE al."organizationId"=NEW."organizationId" AND al."saleLineId"=line_id
        AND NOT EXISTS (SELECT 1 FROM pharmacy_controlled_register_entries r WHERE r."organizationId"=al."organizationId"
          AND r."stockMovementId"=al."stockMovementId" AND r."signatureRef"=NEW.id
          AND (r."witnessStatement"='No witness: dispensed by one pharmacist'
            OR (r."witnessStatement"='No witness: recorded late by one pharmacist' AND r."lateSaleLineId"=line_id)))
    ) THEN RAISE EXCEPTION 'controlled dispensation requires its full register' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pharmacy_require_solo_dispense_register ON pharmacy_pharmacist_review_decisions;
CREATE CONSTRAINT TRIGGER pharmacy_require_solo_dispense_register AFTER INSERT ON pharmacy_pharmacist_review_decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pharmacy_require_solo_dispense_register();

COMMIT;
