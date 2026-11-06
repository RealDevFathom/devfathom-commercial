BEGIN;

ALTER TABLE pharmacy_supplier_expense_settlements
  ADD CONSTRAINT pharmacy_native_ap_funding_account CHECK ("fundingAccount" IN ('CASH', 'BANK'));

-- Voided references may be corrected without erasing their original evidence.
DROP INDEX pharmacy_supplier_expense_invoices_identity_key;
CREATE UNIQUE INDEX pharmacy_supplier_expense_invoices_identity_key
  ON pharmacy_supplier_expense_invoices ("organizationId", "supplierId", "supplierInvoiceRef")
  WHERE status <> 'VOID';

CREATE FUNCTION pharmacy_native_ap_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PHARMACY_NATIVE_AP_IMMUTABLE' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER pharmacy_native_ap_lines_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_supplier_expense_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_immutable();
CREATE TRIGGER pharmacy_native_ap_events_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_supplier_expense_invoice_events
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_immutable();
CREATE TRIGGER pharmacy_native_ap_reversals_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_supplier_expense_settlement_reversals
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_immutable();

-- Only lifecycle status may change on the original money records.
CREATE FUNCTION pharmacy_native_ap_status_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PHARMACY_NATIVE_AP_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'PHARMACY_NATIVE_AP_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (
    (TG_TABLE_NAME = 'pharmacy_supplier_expense_invoices' AND NOT (
      (OLD.status::text = 'OPEN' AND NEW.status::text IN ('PAID', 'VOID')) OR
      (OLD.status::text = 'PAID' AND NEW.status::text = 'OPEN')
    )) OR
    (TG_TABLE_NAME = 'pharmacy_supplier_expense_settlements' AND NOT (
      OLD.status::text = 'POSTED' AND NEW.status::text = 'REVERSED'
    ))
  ) THEN
    RAISE EXCEPTION 'PHARMACY_NATIVE_AP_INVALID_STATUS' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pharmacy_native_ap_invoice_status_only
  BEFORE UPDATE OR DELETE ON pharmacy_supplier_expense_invoices
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_status_only();
CREATE TRIGGER pharmacy_native_ap_settlement_status_only
  BEFORE UPDATE OR DELETE ON pharmacy_supplier_expense_settlements
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_status_only();

-- Serialize child writes with every invoice-directed application path, and
-- enforce the effective posting date at the database boundary as well.
CREATE FUNCTION pharmacy_native_ap_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_id text;
  branch_id text;
  posting_at timestamp;
BEGIN
  IF TG_TABLE_NAME = 'pharmacy_supplier_expense_invoices' THEN
    branch_id := NEW."branchId";
    posting_at := NEW."issuedAt";
  ELSE
    IF TG_TABLE_NAME = 'pharmacy_supplier_expense_settlement_reversals' THEN
      SELECT s."invoiceId" INTO invoice_id FROM pharmacy_supplier_expense_settlements s
        WHERE s."organizationId" = NEW."organizationId" AND s.id = NEW."settlementId";
      posting_at := NEW."reversedAt";
    ELSE
      invoice_id := NEW."invoiceId";
      IF TG_TABLE_NAME <> 'pharmacy_supplier_expense_invoice_lines' THEN
        posting_at := NEW."occurredAt";
      END IF;
    END IF;
    -- A new row version also forces a serialization failure for competing
    -- REPEATABLE READ snapshots, which a SELECT FOR UPDATE alone cannot do.
    UPDATE pharmacy_supplier_expense_invoices i SET status = i.status
      WHERE i."organizationId" = NEW."organizationId" AND i.id = invoice_id
      RETURNING i."branchId", COALESCE(posting_at, i."issuedAt") INTO branch_id, posting_at;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pharmacy_accounting_periods p
      WHERE p."organizationId" = NEW."organizationId" AND p."branchId" = branch_id
        AND p.status = 'CLOSED' AND posting_at >= p."startsAt" AND posting_at < p."endsAt"
  ) THEN
    RAISE EXCEPTION 'PHARMACY_ACCOUNTING_PERIOD_CLOSED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pharmacy_native_ap_invoice_period
  BEFORE INSERT ON pharmacy_supplier_expense_invoices
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_period_open();
CREATE TRIGGER pharmacy_native_ap_line_period
  BEFORE INSERT ON pharmacy_supplier_expense_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_period_open();
CREATE TRIGGER pharmacy_native_ap_settlement_period
  BEFORE INSERT ON pharmacy_supplier_expense_settlements
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_period_open();
CREATE TRIGGER pharmacy_native_ap_reversal_period
  BEFORE INSERT ON pharmacy_supplier_expense_settlement_reversals
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_period_open();
CREATE TRIGGER pharmacy_native_ap_event_period
  BEFORE INSERT ON pharmacy_supplier_expense_invoice_events
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_period_open();

-- Deferred checks allow nested invoice lines and additive reversals to be
-- written in either order within one transaction, but never committed apart.
CREATE FUNCTION pharmacy_native_ap_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_id text;
  invoice_row pharmacy_supplier_expense_invoices%ROWTYPE;
  line_total bigint;
  paid_total bigint;
  voided boolean;
BEGIN
  IF TG_TABLE_NAME = 'pharmacy_supplier_expense_invoices' THEN
    invoice_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'pharmacy_supplier_expense_settlement_reversals' THEN
    SELECT s."invoiceId" INTO invoice_id FROM pharmacy_supplier_expense_settlements s
      WHERE s."organizationId" = NEW."organizationId" AND s.id = NEW."settlementId";
  ELSE
    invoice_id := NEW."invoiceId";
  END IF;
  SELECT * INTO invoice_row FROM pharmacy_supplier_expense_invoices i
    WHERE i."organizationId" = NEW."organizationId" AND i.id = invoice_id FOR UPDATE;
  SELECT COALESCE(SUM(l."amountMinor"), 0) INTO line_total FROM pharmacy_supplier_expense_invoice_lines l
    WHERE l."organizationId" = NEW."organizationId" AND l."invoiceId" = invoice_id;
  IF line_total <> invoice_row."amountMinor" THEN
    RAISE EXCEPTION 'PHARMACY_NATIVE_AP_LINE_TOTAL' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(s."amountMinor") FILTER (WHERE s.status = 'POSTED'), 0) INTO paid_total
    FROM pharmacy_supplier_expense_settlements s
    WHERE s."organizationId" = NEW."organizationId" AND s."invoiceId" = invoice_id;
  IF paid_total > invoice_row."amountMinor" THEN
    RAISE EXCEPTION 'PHARMACY_NATIVE_AP_OVERPAYMENT' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pharmacy_supplier_expense_settlements s
    WHERE s."organizationId" = NEW."organizationId" AND s."invoiceId" = invoice_id
      AND (s.status = 'REVERSED') IS DISTINCT FROM EXISTS (
        SELECT 1 FROM pharmacy_supplier_expense_settlement_reversals r
        WHERE r."organizationId" = s."organizationId" AND r."settlementId" = s.id
      )
  ) THEN
    RAISE EXCEPTION 'PHARMACY_NATIVE_AP_REVERSAL_EVIDENCE' USING ERRCODE = '23514';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM pharmacy_supplier_expense_invoice_events e
    WHERE e."organizationId" = NEW."organizationId" AND e."invoiceId" = invoice_id AND e.kind = 'VOID'
  ) INTO voided;
  IF (invoice_row.status = 'VOID') IS DISTINCT FROM voided OR
    (voided AND paid_total <> 0) OR
    (NOT voided AND (invoice_row.status = 'PAID') IS DISTINCT FROM (paid_total = invoice_row."amountMinor")) THEN
    RAISE EXCEPTION 'PHARMACY_NATIVE_AP_INVALID_STATUS' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER pharmacy_native_ap_invoice_totals
  AFTER INSERT OR UPDATE ON pharmacy_supplier_expense_invoices DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_totals();
CREATE CONSTRAINT TRIGGER pharmacy_native_ap_line_totals
  AFTER INSERT ON pharmacy_supplier_expense_invoice_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_totals();
CREATE CONSTRAINT TRIGGER pharmacy_native_ap_settlement_totals
  AFTER INSERT OR UPDATE ON pharmacy_supplier_expense_settlements DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_totals();
CREATE CONSTRAINT TRIGGER pharmacy_native_ap_reversal_totals
  AFTER INSERT ON pharmacy_supplier_expense_settlement_reversals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_totals();
CREATE CONSTRAINT TRIGGER pharmacy_native_ap_event_totals
  AFTER INSERT ON pharmacy_supplier_expense_invoice_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pharmacy_native_ap_totals();

COMMIT;
