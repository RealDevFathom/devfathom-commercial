CREATE OR REPLACE FUNCTION pharmacy_validate_khata_dishonour()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_kind "PharmacyKhataEventKind";
  linked_family_account_id text;
  paid_minor bigint;
  dishonoured_minor bigint;
BEGIN
  IF NEW."kind" <> 'DISHONOURED_CHEQUE' THEN
    RETURN NEW;
  END IF;

  IF NEW."settlesChargeId" IS NULL THEN
    RAISE EXCEPTION 'Dishonoured cheque must reference a charge';
  END IF;

  SELECT "kind", "familyAccountId"
    INTO linked_kind, linked_family_account_id
    FROM "pharmacy_khata_events"
    WHERE "organizationId" = NEW."organizationId"
      AND "branchId" = NEW."branchId"
      AND "id" = NEW."settlesChargeId"
    FOR UPDATE;

  IF linked_kind IS DISTINCT FROM 'CHARGE' OR
     linked_family_account_id IS DISTINCT FROM NEW."familyAccountId" THEN
    RAISE EXCEPTION 'Dishonoured cheque must reference a charge on the same family account';
  END IF;

  SELECT
    COALESCE(SUM("amountMinor") FILTER (WHERE "kind" = 'PAYMENT'), 0),
    COALESCE(SUM("amountMinor") FILTER (WHERE "kind" = 'DISHONOURED_CHEQUE'), 0)
    INTO paid_minor, dishonoured_minor
    FROM "pharmacy_khata_events"
    WHERE "organizationId" = NEW."organizationId"
      AND "branchId" = NEW."branchId"
      AND "familyAccountId" = NEW."familyAccountId"
      AND "settlesChargeId" = NEW."settlesChargeId";

  IF dishonoured_minor + NEW."amountMinor" > paid_minor THEN
    RAISE EXCEPTION 'Dishonoured cheque amount cannot exceed linked payments';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER pharmacy_khata_dishonour_guard
BEFORE INSERT ON "pharmacy_khata_events"
FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_khata_dishonour();
