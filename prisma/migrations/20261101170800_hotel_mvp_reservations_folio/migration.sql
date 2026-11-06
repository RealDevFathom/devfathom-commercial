-- Hotel MVP: guests, rate plans and effective-dated prices, reservations with
-- server-priced stay units, one folio ledger, payments, operation idempotency
-- and housekeeping.
--
-- Conventions, the same as every other hotel table (20261021100000):
--   * Tenant isolation is RLS enabled AND forced, keyed on the organization
--     (`app.current_organization_id`, or the control plane). The property is
--     enforced by the explicit `(organizationId, branchId)` predicate on every
--     query and by `requireHotelPropertyScope`; there is no second,
--     property-keyed policy for a session to forget to set.
--   * Every reference to a property-owned row is a composite
--     `(organizationId, branchId, id)` foreign key, so a row can never point
--     at another property's or another tenant's data.
--   * Money is BIGINT minor units, never negative. A folio correction is a new
--     entry naming the entry it reverses (a positive copy); balances subtract
--     reversals. There is one ledger and one sign convention.
--   * Recorded money (stay-unit price snapshots, folio entries, payments) is
--     append-only by trigger. The only DELETE admitted is the sanctioned tenant
--     purge, exactly as for the inventory ledgers.
--   * organizationId is always written explicitly by the server; it has no
--     session-derived default.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "HotelReservationStatus" AS ENUM ('HOLD', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW');
CREATE TYPE "HotelReservationSource" AS ENUM ('WALK_IN', 'PHONE', 'EMAIL', 'DIRECT');
CREATE TYPE "HotelFolioStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "HotelFolioEntryKind" AS ENUM ('ROOM_NIGHT', 'EXTRA');
CREATE TYPE "HotelPaymentDirection" AS ENUM ('COLLECTION', 'REFUND');
CREATE TYPE "HotelHousekeepingStatus" AS ENUM ('CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER');
CREATE TYPE "HotelHousekeepingTaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- A folio entry may name a catalog item of its own property only, which needs
-- the property-qualified key on the catalog.
CREATE UNIQUE INDEX "hotel_extras_scope_key" ON "hotel_extras"("organizationId", "branchId", "id");

-- ---------------------------------------------------------------------------
-- Guests (PII). Read only behind `hotel:reservations` with a bounded search.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_guests" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_guests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_guests_name_ck" CHECK (length(btrim("firstName")) > 0 AND length(btrim("lastName")) > 0)
);
CREATE UNIQUE INDEX "hotel_guests_scope_key" ON "hotel_guests"("organizationId", "branchId", "id");
CREATE INDEX "hotel_guests_last_name_idx" ON "hotel_guests"("organizationId", "branchId", "lastName");

-- ---------------------------------------------------------------------------
-- Confirmation-number sequence: exactly one row per property.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_confirmation_sequences" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "nextNumber" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_confirmation_sequences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_confirmation_sequences_next_ck" CHECK ("nextNumber" >= 1)
);
CREATE UNIQUE INDEX "hotel_confirmation_sequences_property_key" ON "hotel_confirmation_sequences"("organizationId", "branchId");

-- ---------------------------------------------------------------------------
-- Rate plans. The plan names the room type, currency and tax; prices live in
-- effective-dated, immutable `hotel_rate_plan_prices` rows. There is no
-- nightly rate on the plan: one pricing model, used by quotes and bookings.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_rate_plans" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "roomTypeId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "taxBasisPoints" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_rate_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_rate_plans_code_ck" CHECK (length(btrim("code")) > 0),
  CONSTRAINT "hotel_rate_plans_currency_ck" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "hotel_rate_plans_tax_ck" CHECK ("taxBasisPoints" BETWEEN 0 AND 100000)
);
CREATE UNIQUE INDEX "hotel_rate_plans_scope_key" ON "hotel_rate_plans"("organizationId", "branchId", "id");
-- Target of the price and stay-unit keys: pins their room type to the plan's.
CREATE UNIQUE INDEX "hotel_rate_plans_scope_room_type_key" ON "hotel_rate_plans"("organizationId", "branchId", "id", "roomTypeId");
CREATE UNIQUE INDEX "hotel_rate_plans_code_key" ON "hotel_rate_plans"("organizationId", "branchId", "code");

CREATE TABLE "hotel_rate_plan_prices" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "roomTypeId" TEXT NOT NULL,
  "ratePlanId" TEXT NOT NULL,
  "validFrom" DATE NOT NULL,
  "validTo" DATE NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "published" BOOLEAN NOT NULL DEFAULT false,
  "usedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_rate_plan_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_rate_plan_prices_net_ck" CHECK ("netMinor" >= 0),
  CONSTRAINT "hotel_rate_plan_prices_range_ck" CHECK ("validFrom" <= "validTo")
);
CREATE UNIQUE INDEX "hotel_rate_plan_prices_scope_key" ON "hotel_rate_plan_prices"("organizationId", "branchId", "id");
CREATE INDEX "hotel_rate_plan_prices_lookup_idx" ON "hotel_rate_plan_prices"("organizationId", "branchId", "ratePlanId", "roomTypeId", "validFrom");

-- ---------------------------------------------------------------------------
-- Reservations and their availability-consuming stay units.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_reservations" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "confirmationNumber" TEXT NOT NULL,
  "status" "HotelReservationStatus" NOT NULL DEFAULT 'HOLD',
  "source" "HotelReservationSource" NOT NULL,
  "primaryGuestId" TEXT NOT NULL,
  "arrivalDate" DATE NOT NULL,
  "departureDate" DATE NOT NULL,
  "adults" INTEGER NOT NULL,
  "children" INTEGER NOT NULL DEFAULT 0,
  "specialRequests" TEXT,
  "currency" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_reservations_dates_ck" CHECK ("departureDate" > "arrivalDate"),
  CONSTRAINT "hotel_reservations_party_ck" CHECK ("adults" >= 1 AND "children" >= 0),
  CONSTRAINT "hotel_reservations_version_ck" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "hotel_reservations_scope_key" ON "hotel_reservations"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX "hotel_reservations_confirmation_key" ON "hotel_reservations"("organizationId", "branchId", "confirmationNumber");
CREATE INDEX "hotel_reservations_arrival_idx" ON "hotel_reservations"("organizationId", "branchId", "arrivalDate");

CREATE TABLE "hotel_reservation_stay_units" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "roomTypeId" TEXT NOT NULL,
  "ratePlanId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "adults" INTEGER NOT NULL,
  "children" INTEGER NOT NULL DEFAULT 0,
  "arrivalDate" DATE NOT NULL,
  "departureDate" DATE NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "taxMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  "taxBasisPoints" INTEGER NOT NULL,
  "nightlyRates" JSONB NOT NULL,
  "currency" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_reservation_stay_units_pkey" PRIMARY KEY ("id"),
  -- The MVP books one unit per row; availability counts rows' quantity.
  CONSTRAINT "hotel_reservation_stay_units_quantity_ck" CHECK ("quantity" = 1),
  CONSTRAINT "hotel_reservation_stay_units_dates_ck" CHECK ("departureDate" > "arrivalDate"),
  CONSTRAINT "hotel_reservation_stay_units_party_ck" CHECK ("adults" >= 1 AND "children" >= 0),
  CONSTRAINT "hotel_reservation_stay_units_money_ck" CHECK (
    "netMinor" >= 0 AND "taxMinor" >= 0 AND "totalMinor" = "netMinor" + "taxMinor"
  )
);
CREATE UNIQUE INDEX "hotel_reservation_stay_units_scope_key" ON "hotel_reservation_stay_units"("organizationId", "branchId", "id");
CREATE INDEX "hotel_reservation_stay_units_reservation_idx" ON "hotel_reservation_stay_units"("organizationId", "branchId", "reservationId");
CREATE INDEX "hotel_reservation_stay_units_availability_idx" ON "hotel_reservation_stay_units"("organizationId", "branchId", "roomTypeId", "arrivalDate");

-- ---------------------------------------------------------------------------
-- Folio ledger: one folio per reservation, one append-only entry table, one
-- append-only payment table.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_folios" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "folioNumber" TEXT NOT NULL,
  "status" "HotelFolioStatus" NOT NULL DEFAULT 'OPEN',
  "currency" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_folios_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "hotel_folios_scope_key" ON "hotel_folios"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX "hotel_folios_reservation_key" ON "hotel_folios"("organizationId", "branchId", "reservationId");
CREATE UNIQUE INDEX "hotel_folios_number_key" ON "hotel_folios"("organizationId", "branchId", "folioNumber");

CREATE TABLE "hotel_folio_entries" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "folioId" TEXT NOT NULL,
  "kind" "HotelFolioEntryKind" NOT NULL,
  "catalogItemId" TEXT,
  "serviceDate" DATE,
  "description" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitMinor" BIGINT NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "taxMinor" BIGINT NOT NULL,
  "grossMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "reversesEntryId" TEXT,
  "reason" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_folio_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_folio_entries_quantity_ck" CHECK ("quantity" > 0),
  CONSTRAINT "hotel_folio_entries_money_ck" CHECK (
    "unitMinor" >= 0 AND "netMinor" >= 0 AND "taxMinor" >= 0 AND "grossMinor" = "netMinor" + "taxMinor"
  ),
  CONSTRAINT "hotel_folio_entries_extra_ck" CHECK ("kind" <> 'EXTRA' OR "catalogItemId" IS NOT NULL),
  CONSTRAINT "hotel_folio_entries_reversal_reason_ck" CHECK (
    "reversesEntryId" IS NULL OR length(btrim(coalesce("reason", ''))) > 0
  )
);
CREATE UNIQUE INDEX "hotel_folio_entries_scope_key" ON "hotel_folio_entries"("organizationId", "branchId", "id");
-- An entry is reversed at most once.
CREATE UNIQUE INDEX "hotel_folio_entries_reversal_key" ON "hotel_folio_entries"("organizationId", "branchId", "reversesEntryId");
CREATE INDEX "hotel_folio_entries_folio_idx" ON "hotel_folio_entries"("organizationId", "branchId", "folioId");

CREATE TABLE "hotel_folio_payments" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "folioId" TEXT NOT NULL,
  "direction" "HotelPaymentDirection" NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "refundsPaymentId" TEXT,
  "reference" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_folio_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_folio_payments_amount_ck" CHECK ("amountMinor" > 0),
  CONSTRAINT "hotel_folio_payments_refund_ck" CHECK (("direction" = 'REFUND') = ("refundsPaymentId" IS NOT NULL))
);
CREATE UNIQUE INDEX "hotel_folio_payments_scope_key" ON "hotel_folio_payments"("organizationId", "branchId", "id");
CREATE INDEX "hotel_folio_payments_folio_idx" ON "hotel_folio_payments"("organizationId", "branchId", "folioId");

-- ---------------------------------------------------------------------------
-- Operation idempotency: a key is bound to the canonical request hash and the
-- stored result.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_operation_idempotency_keys" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "resultType" TEXT,
  "resultId" TEXT,
  "response" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_operation_idempotency_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "hotel_operation_idempotency_keys_key" ON "hotel_operation_idempotency_keys"("organizationId", "branchId", "scope", "key");

-- ---------------------------------------------------------------------------
-- Housekeeping (HK-02): per-room cleaning state and a work queue.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_room_housekeeping" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "status" "HotelHousekeepingStatus" NOT NULL DEFAULT 'DIRTY',
  "changedById" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_room_housekeeping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "hotel_room_housekeeping_scope_key" ON "hotel_room_housekeeping"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX "hotel_room_housekeeping_room_key" ON "hotel_room_housekeeping"("organizationId", "branchId", "roomId");
CREATE INDEX "hotel_room_housekeeping_branch_status_idx" ON "hotel_room_housekeeping"("organizationId", "branchId", "status");

CREATE TABLE "hotel_housekeeping_tasks" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "notes" TEXT,
  "status" "HotelHousekeepingTaskStatus" NOT NULL DEFAULT 'OPEN',
  "assignedToId" TEXT,
  "createdById" TEXT NOT NULL,
  "completedById" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_housekeeping_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_housekeeping_tasks_title_ck" CHECK (char_length("title") BETWEEN 1 AND 160),
  CONSTRAINT "hotel_housekeeping_tasks_completion_ck" CHECK (
    ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL AND "completedById" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "hotel_housekeeping_tasks_scope_key" ON "hotel_housekeeping_tasks"("organizationId", "branchId", "id");
CREATE INDEX "hotel_housekeeping_tasks_branch_status_idx" ON "hotel_housekeeping_tasks"("organizationId", "branchId", "status");

-- ---------------------------------------------------------------------------
-- Foreign keys. Every one is tenant- and property-qualified.
-- ---------------------------------------------------------------------------
ALTER TABLE "hotel_guests" ADD CONSTRAINT "hotel_guests_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hotel_confirmation_sequences" ADD CONSTRAINT "hotel_confirmation_sequences_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hotel_rate_plans" ADD CONSTRAINT "hotel_rate_plans_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_rate_plans" ADD CONSTRAINT "hotel_rate_plans_room_type_fkey"
  FOREIGN KEY ("organizationId", "branchId", "roomTypeId") REFERENCES "hotel_room_types"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hotel_rate_plan_prices" ADD CONSTRAINT "hotel_rate_plan_prices_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_rate_plan_prices" ADD CONSTRAINT "hotel_rate_plan_prices_rate_plan_fkey"
  FOREIGN KEY ("organizationId", "branchId", "ratePlanId", "roomTypeId")
  REFERENCES "hotel_rate_plans"("organizationId", "branchId", "id", "roomTypeId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hotel_reservations" ADD CONSTRAINT "hotel_reservations_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_reservations" ADD CONSTRAINT "hotel_reservations_primary_guest_fkey"
  FOREIGN KEY ("organizationId", "branchId", "primaryGuestId") REFERENCES "hotel_guests"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hotel_reservation_stay_units" ADD CONSTRAINT "hotel_reservation_stay_units_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_reservation_stay_units" ADD CONSTRAINT "hotel_reservation_stay_units_reservation_fkey"
  FOREIGN KEY ("organizationId", "branchId", "reservationId") REFERENCES "hotel_reservations"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_reservation_stay_units" ADD CONSTRAINT "hotel_reservation_stay_units_rate_plan_fkey"
  FOREIGN KEY ("organizationId", "branchId", "ratePlanId", "roomTypeId")
  REFERENCES "hotel_rate_plans"("organizationId", "branchId", "id", "roomTypeId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hotel_folios" ADD CONSTRAINT "hotel_folios_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_folios" ADD CONSTRAINT "hotel_folios_reservation_fkey"
  FOREIGN KEY ("organizationId", "branchId", "reservationId") REFERENCES "hotel_reservations"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hotel_folio_entries" ADD CONSTRAINT "hotel_folio_entries_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_folio_entries" ADD CONSTRAINT "hotel_folio_entries_folio_fkey"
  FOREIGN KEY ("organizationId", "branchId", "folioId") REFERENCES "hotel_folios"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_folio_entries" ADD CONSTRAINT "hotel_folio_entries_catalog_item_fkey"
  FOREIGN KEY ("organizationId", "branchId", "catalogItemId") REFERENCES "hotel_extras"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_folio_entries" ADD CONSTRAINT "hotel_folio_entries_reverses_fkey"
  FOREIGN KEY ("organizationId", "branchId", "reversesEntryId") REFERENCES "hotel_folio_entries"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hotel_folio_payments" ADD CONSTRAINT "hotel_folio_payments_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_folio_payments" ADD CONSTRAINT "hotel_folio_payments_folio_fkey"
  FOREIGN KEY ("organizationId", "branchId", "folioId") REFERENCES "hotel_folios"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_folio_payments" ADD CONSTRAINT "hotel_folio_payments_refunds_fkey"
  FOREIGN KEY ("organizationId", "branchId", "refundsPaymentId") REFERENCES "hotel_folio_payments"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hotel_operation_idempotency_keys" ADD CONSTRAINT "hotel_operation_idempotency_keys_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hotel_room_housekeeping" ADD CONSTRAINT "hotel_room_housekeeping_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_room_housekeeping" ADD CONSTRAINT "hotel_room_housekeeping_room_fkey"
  FOREIGN KEY ("organizationId", "branchId", "roomId") REFERENCES "hotel_rooms"("organizationId", "branchId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hotel_housekeeping_tasks" ADD CONSTRAINT "hotel_housekeeping_tasks_property_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_housekeeping_tasks" ADD CONSTRAINT "hotel_housekeeping_tasks_room_fkey"
  FOREIGN KEY ("organizationId", "branchId", "roomId") REFERENCES "hotel_rooms"("organizationId", "branchId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Append-only money. UPDATE is always refused; DELETE only for the sanctioned
-- purge of this row's own tenant by the control plane.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hotel_money_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
     AND current_setting('app.is_platform_admin', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'hotel financial records are append-only; post a reversal instead' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER hotel_stay_units_append_only BEFORE UPDATE OR DELETE ON "hotel_reservation_stay_units"
  FOR EACH ROW EXECUTE FUNCTION hotel_money_append_only();
CREATE TRIGGER hotel_folio_entries_append_only BEFORE UPDATE OR DELETE ON "hotel_folio_entries"
  FOR EACH ROW EXECUTE FUNCTION hotel_money_append_only();
CREATE TRIGGER hotel_folio_payments_append_only BEFORE UPDATE OR DELETE ON "hotel_folio_payments"
  FOR EACH ROW EXECUTE FUNCTION hotel_money_append_only();

-- A reversal copies the original's folio, currency and amounts exactly, and
-- may not itself be reversed.
CREATE FUNCTION hotel_folio_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original "hotel_folio_entries"%ROWTYPE;
BEGIN
  IF NEW."reversesEntryId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO original FROM "hotel_folio_entries"
    WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId" AND "id" = NEW."reversesEntryId";
  IF NOT FOUND OR original."reversesEntryId" IS NOT NULL
     OR original."folioId" <> NEW."folioId" OR original."currency" <> NEW."currency"
     OR original."grossMinor" <> NEW."grossMinor" OR original."netMinor" <> NEW."netMinor"
     OR original."taxMinor" <> NEW."taxMinor" THEN
    RAISE EXCEPTION 'a reversal must copy an unreversed original entry of the same folio' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_folio_entries_reversal_guard BEFORE INSERT ON "hotel_folio_entries"
  FOR EACH ROW EXECUTE FUNCTION hotel_folio_reversal_guard();

-- Rate plans: what a price means (room type, currency, tax) is fixed once the
-- plan exists. A tax change is a new plan, so quotes and bookings already made
-- against the old one keep their meaning. Only the label and `active` move.
CREATE FUNCTION hotel_rate_plan_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."roomTypeId" IS DISTINCT FROM OLD."roomTypeId"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."taxBasisPoints" IS DISTINCT FROM OLD."taxBasisPoints" THEN
    RAISE EXCEPTION 'rate plan terms are immutable; create a new rate plan' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_rate_plan_terms_immutable BEFORE UPDATE ON "hotel_rate_plans"
  FOR EACH ROW EXECUTE FUNCTION hotel_rate_plan_terms_immutable();

-- Published or used prices are immutable; a change is a new version.
CREATE FUNCTION hotel_rate_price_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN
      RETURN OLD;
    END IF;
    IF OLD."published" OR OLD."usedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'published rate prices are immutable; insert a new version' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (OLD."published" OR OLD."usedAt" IS NOT NULL)
     AND (NEW."netMinor" IS DISTINCT FROM OLD."netMinor"
       OR NEW."validFrom" IS DISTINCT FROM OLD."validFrom"
       OR NEW."validTo" IS DISTINCT FROM OLD."validTo"
       OR NEW."ratePlanId" IS DISTINCT FROM OLD."ratePlanId"
       OR NEW."roomTypeId" IS DISTINCT FROM OLD."roomTypeId"
       OR NEW."published" IS DISTINCT FROM OLD."published") THEN
    RAISE EXCEPTION 'published rate prices are immutable; insert a new version' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_rate_price_immutable BEFORE UPDATE OR DELETE ON "hotel_rate_plan_prices"
  FOR EACH ROW EXECUTE FUNCTION hotel_rate_price_immutable();

-- ---------------------------------------------------------------------------
-- Tenant isolation: enabled AND forced, the standard hotel shape.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hotel_guests', 'hotel_confirmation_sequences', 'hotel_rate_plans', 'hotel_rate_plan_prices',
    'hotel_reservations', 'hotel_reservation_stay_units', 'hotel_folios', 'hotel_folio_entries',
    'hotel_folio_payments', 'hotel_operation_idempotency_keys', 'hotel_room_housekeeping',
    'hotel_housekeeping_tasks'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ('
        || 'current_setting(''app.is_platform_admin'', true) = ''true'' '
        || 'OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')'
        || ') WITH CHECK ('
        || 'current_setting(''app.is_platform_admin'', true) = ''true'' '
        || 'OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')'
        || ')',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
