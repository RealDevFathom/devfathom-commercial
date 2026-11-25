BEGIN;
-- All student money is integer paisa. Each posted entry has one equal debit and credit.
CREATE TABLE university_challans (
    organization_id text NOT NULL,
    reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 100),
    person_id text NOT NULL,
    fee_head text NOT NULL CHECK (fee_head IN ('TUITION','ADMISSION','APPLICATION','EXAM','LIBRARY','TRANSPORT','LAB','UTILITIES','SPORTS','DEPOSIT','HOSTEL','OTHER','OPENING')),
    amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
    commencement_date date NOT NULL,
    due_date date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, reference),
    FOREIGN KEY (organization_id, person_id) REFERENCES university_people (organization_id, id)
);
CREATE INDEX university_challans_person_idx ON university_challans (organization_id, person_id);

CREATE TABLE university_finance_entries (
    organization_id text NOT NULL,
    entry_key text NOT NULL,
    reference text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('CHARGE','SCHOLARSHIP','PAYMENT','REFUND_CREDIT','REFUND_PAID','TRANSFER_CREDIT','TRANSFER_OUT','TRANSFER_IN','OPENING_DEBIT','OPENING_CREDIT','OPENING_APPLIED','OPENING_ALLOCATED','REVERSAL')),
    debit_account text NOT NULL,
    credit_account text NOT NULL CHECK (credit_account <> debit_account),
    amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
    reversal_of text,
    posting_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Karachi')::date),
    actor_id text NOT NULL,
    reason text NOT NULL,
    PRIMARY KEY (organization_id, entry_key),
    UNIQUE (organization_id, reversal_of),
    FOREIGN KEY (organization_id, reversal_of) REFERENCES university_finance_entries (organization_id, entry_key),
    FOREIGN KEY (organization_id, reference) REFERENCES university_challans (organization_id, reference)
);
CREATE INDEX university_finance_entries_period_idx ON university_finance_entries (organization_id, posting_date);
CREATE INDEX university_finance_entries_ref_idx ON university_finance_entries (organization_id, reference);

CREATE TABLE university_finance_gl_acknowledgments (
    organization_id text NOT NULL,
    entry_key text NOT NULL,
    journal_reference text NOT NULL,
    actor_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, entry_key),
    FOREIGN KEY (organization_id, entry_key) REFERENCES university_finance_entries (organization_id, entry_key)
);

CREATE TABLE university_bank_receipts (
    organization_id text NOT NULL,
    provider text NOT NULL,
    transaction_id text NOT NULL,
    supplied_reference text NOT NULL,
    matched_reference text,
    paid_paisa bigint NOT NULL CHECK (paid_paisa > 0),
    value_date date NOT NULL,
    status text NOT NULL CHECK (status IN ('UNMATCHED','POSTED','SETTLED','REVERSED','RETURNED')),
    exception text,
    settlement_reference text,
    settled_date date,
    actor_id text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, provider, transaction_id),
    FOREIGN KEY (organization_id, matched_reference) REFERENCES university_challans (organization_id, reference)
);
CREATE INDEX university_bank_receipts_queue_idx ON university_bank_receipts (organization_id,status,value_date);

CREATE TABLE university_fee_refunds (
    organization_id text NOT NULL,
    id text NOT NULL,
    reference text NOT NULL,
    request_date date NOT NULL,
    policy_version text NOT NULL,
    evidence text NOT NULL,
    beneficiary text NOT NULL,
    basis jsonb NOT NULL,
    amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
    status text NOT NULL CHECK (status IN ('REQUESTED','APPROVED','DISBURSED','REJECTED')),
    requested_by text NOT NULL,
    approved_by text,
    disbursement_reference text,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, disbursement_reference),
    FOREIGN KEY (organization_id, reference) REFERENCES university_challans (organization_id, reference),
    CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE UNIQUE INDEX university_fee_refund_open_idx ON university_fee_refunds (organization_id,reference)
    WHERE status IN ('REQUESTED','APPROVED','DISBURSED');

CREATE TABLE university_finance_closed_periods (
    organization_id text NOT NULL REFERENCES organizations(id),
    month_start date NOT NULL CHECK (EXTRACT(DAY FROM month_start) = 1),
    closed_by text NOT NULL,
    closed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, month_start)
);

DO $$
DECLARE
  tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['university_challans','university_finance_entries',
      'university_finance_gl_acknowledgments','university_bank_receipts','university_fee_refunds',
      'university_finance_closed_periods'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (organization_id = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',tab);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (organization_id = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',tab);
  END LOOP;
  FOREACH tab IN ARRAY ARRAY['university_bank_receipts','university_fee_refunds'] LOOP
    EXECUTE format('CREATE POLICY tenant_update ON %I FOR UPDATE USING (organization_id = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK (organization_id = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',tab);
  END LOOP;
END $$;

-- Database-level append-only protection also applies to table owners and maintenance roles.
CREATE FUNCTION university_finance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Posted university finance records are immutable';
END $$;
CREATE TRIGGER university_finance_entries_immutable BEFORE UPDATE OR DELETE ON university_finance_entries
  FOR EACH ROW EXECUTE FUNCTION university_finance_immutable();
CREATE TRIGGER university_challans_immutable BEFORE UPDATE OR DELETE ON university_challans
  FOR EACH ROW EXECUTE FUNCTION university_finance_immutable();

CREATE FUNCTION university_finance_check_open_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM university_finance_closed_periods p WHERE p.organization_id=NEW.organization_id
       AND p.month_start=date_trunc('month',NEW.posting_date)::date) THEN
    RAISE EXCEPTION 'University accounting period is closed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER university_finance_period_guard BEFORE INSERT ON university_finance_entries
  FOR EACH ROW EXECUTE FUNCTION university_finance_check_open_period();

CREATE TABLE university_fee_collection_accounts (
  organization_id text PRIMARY KEY REFERENCES organizations(id),
  bank_name text NOT NULL, beneficiary text NOT NULL, iban text NOT NULL,
  updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE university_fee_collection_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE university_fee_collection_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON university_fee_collection_accounts
  USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),''))
  WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),''));

COMMIT;
