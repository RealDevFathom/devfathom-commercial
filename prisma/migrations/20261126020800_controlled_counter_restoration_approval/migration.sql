BEGIN;
SET LOCAL lock_timeout = '5s';

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
    OR ("entryKind"::text = 'RETURN_TO_SUPPLIER' AND "lateDispatchAt" IS NOT NULL
        AND "witnessedByUserId" IS NULL AND COALESCE("signatureRef",'') ~ '^late-owner-(pin|authenticator):')
  );

CREATE OR REPLACE FUNCTION pharmacy_check_controlled_sale_witness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."witnessStatement" IS NULL THEN RETURN NEW; END IF;
  IF NEW."entryKind" = 'CORRECTION' AND NEW."witnessStatement"='No witness' THEN
    IF NEW."witnessedByUserId" IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM audit_logs a JOIN pharmacy_branches b ON b."organizationId"=a."organizationId"
       WHERE a.id=NEW."signatureRef" AND a."organizationId"=NEW."organizationId"
         AND a."actorId"=NEW."recordedByUserId" AND a.xmin=pg_current_xact_id()::xid
         AND a.action='pharmacySales.controlledRestorationSelfApproval' AND a.outcome='SUCCESS'
         AND a."targetType"='PharmacyStockMovement' AND a."targetId"=NEW."restorationMovementId"
         AND b.id=NEW."branchId" AND b.active AND NOT b."requireSecondPharmacist"
         AND a.metadata @> jsonb_build_object('selfApproved',true,'branchId',NEW."branchId",
           'correctsEntryId',NEW."correctsEntryId",'restorationMovementId',NEW."restorationMovementId")
         AND (a.metadata @> '{"approvalMethod":"PIN","pinVerified":true}'
           OR a.metadata @> '{"approvalMethod":"AUTHENTICATOR","authenticatorVerified":true}')
       FOR SHARE OF b
    ) THEN RAISE EXCEPTION 'controlled restoration requires its verified self-approval' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."witnessStatement" <> 'No witness: dispensed by one pharmacist'
    OR NEW."entryKind" <> 'SALE' OR NEW.emergency OR NEW."witnessedByUserId" IS NOT NULL
    OR NULLIF(btrim(NEW."patientAddress"),'') IS NULL OR NOT EXISTS (
      SELECT 1 FROM pharmacy_pharmacist_review_decisions d
      JOIN pharmacy_pharmacist_review_items i ON i.id=d."reviewItemId" AND i."organizationId"=d."organizationId"
      JOIN pharmacy_sale_lines l ON l.id=i."saleLineId" AND l."organizationId"=i."organizationId"
      JOIN pharmacy_sale_line_allocations al ON al."organizationId"=l."organizationId" AND al."saleLineId"=l.id
      JOIN audit_logs a ON a.id=d."selfApprovalAuditId" AND a."organizationId"=d."organizationId"
      JOIN pharmacy_prescription_lines rx ON rx.id=i."prescriptionLineId" AND rx."organizationId"=i."organizationId"
      JOIN pharmacy_prescriptions p ON p.id=rx."prescriptionId" AND p."organizationId"=rx."organizationId"
      WHERE d.id=NEW."signatureRef" AND d."organizationId"=NEW."organizationId"
        AND d.kind='SIGN' AND d."actorUserId"=NEW."recordedByUserId" AND i."requestedByUserId"=d."actorUserId"
        AND a.action='pharmacySales.controlledSelfApproval' AND a.xmin=pg_current_xact_id()::xid
        AND al."stockMovementId"=NEW."stockMovementId" AND l."branchId"=NEW."branchId"
        AND l."medicineId"=NEW."medicineId" AND rx."medicineId"=l."medicineId"
        AND rx.id=NEW."prescriptionLineId" AND p.id=NEW."prescriptionId"
        AND p."patientId"=NEW."patientId" AND p."prescriberId"=NEW."prescriberId"
    ) THEN
    RAISE EXCEPTION 'controlled register requires its verified self-approval' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
