-- FOL-01: an append-only, property-scoped folio ledger. Amounts are snapshots
-- calculated by the server; callers never supply them to the posting API.
CREATE TABLE IF NOT EXISTS hotel_folios (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL,
  "branchId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "branchId", id),
  FOREIGN KEY ("organizationId", "branchId")
    REFERENCES hotel_properties ("organizationId", "branchId") ON DELETE RESTRICT
);

-- PostgreSQL requires every referenced column set to be unique. Older installs
-- only have (organizationId, id); retain the branch in the key so a folio entry
-- can never attach a catalog item from another property. The catalog table is
-- created by an earlier migration, so this is safe to establish before the FK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hotel_extras_org_branch_id_key'
      AND conrelid = 'hotel_extras'::regclass
  ) THEN
    ALTER TABLE hotel_extras
      ADD CONSTRAINT hotel_extras_org_branch_id_key
      UNIQUE ("organizationId", "branchId", id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS hotel_folio_entries (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL,
  "branchId" text NOT NULL,
  "folioId" text NOT NULL,
  "catalogItemId" text,
  quantity integer NOT NULL CHECK (quantity > 0),
  "unitMinor" bigint NOT NULL CHECK ("unitMinor" >= 0),
  "netMinor" bigint NOT NULL CHECK ("netMinor" >= 0),
  "taxMinor" bigint NOT NULL CHECK ("taxMinor" >= 0),
  "grossMinor" bigint NOT NULL CHECK ("grossMinor" = "netMinor" + "taxMinor"),
  "reversesEntryId" text,
  reason text,
  "createdBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "branchId", id),
  UNIQUE ("organizationId", "branchId", "reversesEntryId"),
  FOREIGN KEY ("organizationId", "branchId", "folioId")
    REFERENCES hotel_folios ("organizationId", "branchId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId", "catalogItemId")
    REFERENCES hotel_extras ("organizationId", "branchId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId", "reversesEntryId")
    REFERENCES hotel_folio_entries ("organizationId", "branchId", id) ON DELETE RESTRICT,
  CHECK (("reversesEntryId" IS NULL) OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

CREATE OR REPLACE FUNCTION hotel_folio_entries_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hotel folio money is immutable; post a reversal';
END
$$;

DROP TRIGGER IF EXISTS hotel_folio_entries_no_update_or_delete ON hotel_folio_entries;
CREATE TRIGGER hotel_folio_entries_no_update_or_delete
BEFORE UPDATE OR DELETE ON hotel_folio_entries
FOR EACH ROW EXECUTE FUNCTION hotel_folio_entries_immutable();

ALTER TABLE hotel_folios ENABLE ROW LEVEL SECURITY;
ALTER TABLE hotel_folios FORCE ROW LEVEL SECURITY;
ALTER TABLE hotel_folio_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hotel_folio_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hotel_folios_property_scope ON hotel_folios;
CREATE POLICY hotel_folios_property_scope ON hotel_folios
  USING (
    "organizationId" = current_setting('app.current_organization_id', true)
    AND EXISTS (
      SELECT 1 FROM hotel_property_assignments a
      WHERE a."organizationId" = hotel_folios."organizationId"
        AND a."branchId" = hotel_folios."branchId"
        AND a."userId" = current_setting('app.current_user_id', true)
        AND a.active
    )
  )
  WITH CHECK (
    "organizationId" = current_setting('app.current_organization_id', true)
    AND EXISTS (
      SELECT 1 FROM hotel_property_assignments a
      WHERE a."organizationId" = hotel_folios."organizationId"
        AND a."branchId" = hotel_folios."branchId"
        AND a."userId" = current_setting('app.current_user_id', true)
        AND a.active
    )
  );

DROP POLICY IF EXISTS hotel_folio_entries_property_scope ON hotel_folio_entries;
CREATE POLICY hotel_folio_entries_property_scope ON hotel_folio_entries
  USING (
    "organizationId" = current_setting('app.current_organization_id', true)
    AND EXISTS (
      SELECT 1 FROM hotel_property_assignments a
      WHERE a."organizationId" = hotel_folio_entries."organizationId"
        AND a."branchId" = hotel_folio_entries."branchId"
        AND a."userId" = current_setting('app.current_user_id', true)
        AND a.active
    )
  )
  WITH CHECK (
    "organizationId" = current_setting('app.current_organization_id', true)
    AND EXISTS (
      SELECT 1 FROM hotel_property_assignments a
      WHERE a."organizationId" = hotel_folio_entries."organizationId"
        AND a."branchId" = hotel_folio_entries."branchId"
        AND a."userId" = current_setting('app.current_user_id', true)
        AND a.active
    )
  );

-- Corrections are new, opposite-signed economic records represented with the
-- original positive snapshot plus reversesEntryId. Reports subtract reversals.
-- The tenant predicate is repeated on every source row, rather than trusting RLS.
CREATE OR REPLACE FUNCTION reverse_hotel_folio_entry(
  p_id text, p_organization_id text, p_branch_id text,
  p_entry_id text, p_reason text, p_actor_id text
) RETURNS hotel_folio_entries
LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO hotel_folio_entries (
    id, "organizationId", "branchId", "folioId", "catalogItemId", quantity,
    "unitMinor", "netMinor", "taxMinor", "grossMinor", "reversesEntryId", reason, "createdBy"
  )
  SELECT p_id, e."organizationId", e."branchId", e."folioId", e."catalogItemId", e.quantity,
         e."unitMinor", e."netMinor", e."taxMinor", e."grossMinor", e.id, p_reason, p_actor_id
  FROM hotel_folio_entries e
  WHERE e.id = p_entry_id
    AND e."organizationId" = p_organization_id
    AND e."branchId" = p_branch_id
    AND e."reversesEntryId" IS NULL
  RETURNING *
$$;
