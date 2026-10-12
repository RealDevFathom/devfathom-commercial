-- PH-POS / POS-01: per-operator configurable counter shortcuts.
--
-- Organization- and user-scoped rather than branch-scoped: a cashier's muscle
-- memory follows them between counters, and a keymap is not branch stock.
--
-- The row is a preference, not a ledger entry, so it is mutable (SELECT/INSERT/
-- UPDATE) but never deletable — the same shape the other mutable pharmacy
-- preference tables use.

CREATE TABLE "pharmacy_counter_keymap_preferences" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "userId"         TEXT NOT NULL,
  "preset"         TEXT NOT NULL DEFAULT 'devfathom',
  "overrides"      JSONB NOT NULL DEFAULT '{}',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pharmacy_counter_keymap_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pharmacy_counter_keymap_preferences_org_id_key"
  ON "pharmacy_counter_keymap_preferences" ("organizationId", "id");

-- One map per operator per workspace. This is also what makes the upsert in
-- `pharmacySales.saveKeymap` idempotent under a double-submit.
CREATE UNIQUE INDEX "pharmacy_counter_keymap_preferences_org_user_key"
  ON "pharmacy_counter_keymap_preferences" ("organizationId", "userId");

-- The preset must be one the application actually ships. A row naming a preset
-- that does not exist would fail closed at read time and leave the operator
-- with no shortcuts at all, so it is refused at write time instead.
ALTER TABLE "pharmacy_counter_keymap_preferences"
  ADD CONSTRAINT "pharmacy_counter_keymap_preferences_preset_check"
  CHECK ("preset" IN ('devfathom', 'legacySpeed'));

-- `overrides` is an action → chord map. A non-object (array, scalar, null JSON)
-- could never be merged onto a preset, so it is rejected here rather than
-- discovered by a cashier whose F-keys stopped working.
ALTER TABLE "pharmacy_counter_keymap_preferences"
  ADD CONSTRAINT "pharmacy_counter_keymap_preferences_overrides_object_check"
  CHECK (jsonb_typeof("overrides") = 'object');

ALTER TABLE "pharmacy_counter_keymap_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_counter_keymap_preferences" FORCE ROW LEVEL SECURITY;

CREATE POLICY "pharmacy_counter_keymap_preferences_tenant_select"
  ON "pharmacy_counter_keymap_preferences"
  FOR SELECT
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

CREATE POLICY "pharmacy_counter_keymap_preferences_tenant_insert"
  ON "pharmacy_counter_keymap_preferences"
  FOR INSERT
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

CREATE POLICY "pharmacy_counter_keymap_preferences_tenant_update"
  ON "pharmacy_counter_keymap_preferences"
  FOR UPDATE
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
