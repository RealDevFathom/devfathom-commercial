-- Hotel MVP phase 0: operational contracts and persistence. All dates are property-local
-- calendar dates and every money value is an integer minor-unit amount.
CREATE TYPE "HotelReservationStatus" AS ENUM ('HOLD','CONFIRMED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW');
CREATE TYPE "HotelReservationSource" AS ENUM ('WALK_IN','PHONE','EMAIL','DIRECT');
CREATE TYPE "HotelRoomAssignmentStatus" AS ENUM ('HELD','ACTIVE','RELEASED');
CREATE TYPE "HotelReservationEventKind" AS ENUM ('CREATED','CONFIRMED','ROOM_ASSIGNED','ROOM_CHANGED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW','NOTE_ADDED');
CREATE TYPE "HotelFolioStatus" AS ENUM ('OPEN','CLOSED','VOID');
CREATE TYPE "HotelFolioPostingKind" AS ENUM ('ROOM','EXTRA','TAX','DISCOUNT','ADJUSTMENT','REVERSAL');
CREATE TYPE "HotelFolioSourceKind" AS ENUM ('NIGHT_AUDIT','HOTEL_EXTRA','MANUAL','REVERSAL');
CREATE TYPE "HotelTenderType" AS ENUM ('CASH','CARD');
CREATE TYPE "HotelPaymentDirection" AS ENUM ('COLLECTION','REFUND');
CREATE TYPE "HotelPaymentAttemptStatus" AS ENUM ('PENDING','SUCCEEDED','FAILED','CANCELLED');
CREATE TYPE "HotelPaymentEventKind" AS ENUM ('REQUESTED','AUTHORIZED','SETTLED','FAILED','CANCELLED','REFUNDED');
CREATE TYPE "HotelNightAuditStatus" AS ENUM ('RUNNING','COMPLETED','FAILED');
CREATE TYPE "HotelNightAuditStep" AS ENUM ('PRECHECK','NO_SHOWS','ROOM_POSTINGS','BALANCES','ADVANCE_DATE');
CREATE TYPE "HotelNightAuditStepStatus" AS ENUM ('PENDING','RUNNING','COMPLETED','FAILED');

ALTER TABLE "hotel_properties" ADD COLUMN "businessDate" DATE;
UPDATE "hotel_properties" SET "businessDate" = (CURRENT_TIMESTAMP AT TIME ZONE "timezone")::date;
ALTER TABLE "hotel_properties" ALTER COLUMN "businessDate" SET NOT NULL;

CREATE TABLE "hotel_guests" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true), "branchId" TEXT NOT NULL,
 "firstName" TEXT NOT NULL, "lastName" TEXT NOT NULL, "email" TEXT, "phone" TEXT, "countryCode" TEXT, "notes" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT hotel_guests_name_ck CHECK(length(btrim("firstName"))>0 AND length(btrim("lastName"))>0),
 CONSTRAINT hotel_guests_property_fk FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX hotel_guests_org_id_key ON "hotel_guests"("organizationId","id");
CREATE INDEX hotel_guests_email_idx ON "hotel_guests"("organizationId","branchId",lower("email"));
CREATE INDEX hotel_guests_phone_idx ON "hotel_guests"("organizationId","branchId","phone");
CREATE INDEX hotel_guests_name_idx ON "hotel_guests"("organizationId","branchId","lastName","firstName");

CREATE TABLE "hotel_reservations" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true), "branchId" TEXT NOT NULL,
 "confirmationNumber" TEXT NOT NULL, "status" "HotelReservationStatus" NOT NULL, "source" "HotelReservationSource" NOT NULL, "primaryGuestId" TEXT NOT NULL,
 "arrivalDate" DATE NOT NULL, "departureDate" DATE NOT NULL, "adults" INTEGER NOT NULL, "children" INTEGER NOT NULL DEFAULT 0,
 "specialRequests" TEXT, "currency" TEXT NOT NULL, "bookedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "cancelledAt" TIMESTAMP(3), "checkedInAt" TIMESTAMP(3), "checkedOutAt" TIMESTAMP(3), "noShowAt" TIMESTAMP(3),
 "version" INTEGER NOT NULL DEFAULT 1, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT hotel_reservation_dates_ck CHECK("departureDate">"arrivalDate"),
 CONSTRAINT hotel_reservation_party_ck CHECK("adults">=1 AND "children">=0),
 CONSTRAINT hotel_reservation_currency_ck CHECK("currency" ~ '^[A-Z]{3}$'),
 FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","primaryGuestId") REFERENCES "hotel_guests"("organizationId","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX hotel_reservations_scope_key ON "hotel_reservations"("organizationId","branchId","id");
CREATE UNIQUE INDEX hotel_reservations_confirmation_key ON "hotel_reservations"("organizationId","branchId","confirmationNumber");
CREATE INDEX hotel_reservations_arrival_idx ON "hotel_reservations"("organizationId","branchId","arrivalDate","status");
CREATE INDEX hotel_reservations_departure_idx ON "hotel_reservations"("organizationId","branchId","departureDate","status");
CREATE INDEX hotel_reservations_guest_idx ON "hotel_reservations"("organizationId","branchId","primaryGuestId");

CREATE TABLE "hotel_reservation_stay_units" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true), "branchId" TEXT NOT NULL,
 "reservationId" TEXT NOT NULL, "roomTypeId" TEXT NOT NULL, "mealPlanId" TEXT, "quantity" INTEGER NOT NULL DEFAULT 1,
 "adults" INTEGER NOT NULL, "children" INTEGER NOT NULL DEFAULT 0, "nightlyRateMinor" INTEGER NOT NULL, "taxMinorPerNight" INTEGER NOT NULL DEFAULT 0,
 "currency" TEXT NOT NULL, "arrivalDate" DATE NOT NULL, "departureDate" DATE NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT hotel_stay_unit_values_ck CHECK("quantity">0 AND "adults">=1 AND "children">=0 AND "nightlyRateMinor">=0 AND "taxMinorPerNight">=0 AND "departureDate">"arrivalDate"),
 FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","branchId","reservationId") REFERENCES "hotel_reservations"("organizationId","branchId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","branchId","roomTypeId") REFERENCES "hotel_room_types"("organizationId","branchId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","mealPlanId") REFERENCES "hotel_meal_plans"("organizationId","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX hotel_stay_units_org_id_key ON "hotel_reservation_stay_units"("organizationId","id");
CREATE UNIQUE INDEX hotel_stay_units_scope_key ON "hotel_reservation_stay_units"("organizationId","branchId","id");
CREATE INDEX hotel_stay_units_availability_idx ON "hotel_reservation_stay_units"("organizationId","branchId","roomTypeId","arrivalDate","departureDate");
CREATE INDEX hotel_stay_units_reservation_idx ON "hotel_reservation_stay_units"("organizationId","branchId","reservationId");

CREATE TABLE "hotel_room_assignments" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true), "branchId" TEXT NOT NULL,
 "stayUnitId" TEXT NOT NULL, "roomId" TEXT NOT NULL, "bedId" TEXT, "startDate" DATE NOT NULL, "endDate" DATE NOT NULL,
 "status" "HotelRoomAssignmentStatus" NOT NULL, "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "assignedById" TEXT NOT NULL,
 "releasedAt" TIMESTAMP(3), "releaseReason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT hotel_room_assignment_dates_ck CHECK("endDate">"startDate"),
 CONSTRAINT hotel_room_assignment_release_ck CHECK(("status"='RELEASED')=("releasedAt" IS NOT NULL)),
 FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","branchId","stayUnitId") REFERENCES "hotel_reservation_stay_units"("organizationId","branchId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","branchId","roomId") REFERENCES "hotel_rooms"("organizationId","branchId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","branchId","roomId","bedId") REFERENCES "hotel_beds"("organizationId","branchId","roomId","id") ON DELETE RESTRICT
);
CREATE INDEX hotel_room_assignments_room_idx ON "hotel_room_assignments"("organizationId","branchId","roomId","startDate","endDate");
CREATE INDEX hotel_room_assignments_stay_idx ON "hotel_room_assignments"("organizationId","branchId","stayUnitId","status");
ALTER TABLE "hotel_room_assignments" ADD CONSTRAINT hotel_room_assignments_room_no_overlap EXCLUDE USING gist
 ("organizationId" WITH =,"branchId" WITH =,"roomId" WITH =,daterange("startDate","endDate",'[)') WITH &&) WHERE ("status" IN ('HELD','ACTIVE'));
ALTER TABLE "hotel_room_assignments" ADD CONSTRAINT hotel_room_assignments_bed_no_overlap EXCLUDE USING gist
 ("organizationId" WITH =,"branchId" WITH =,"bedId" WITH =,daterange("startDate","endDate",'[)') WITH &&) WHERE ("bedId" IS NOT NULL AND "status" IN ('HELD','ACTIVE'));

CREATE TABLE "hotel_reservation_events" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true), "branchId" TEXT NOT NULL,
 "reservationId" TEXT NOT NULL, "kind" "HotelReservationEventKind" NOT NULL, "fromStatus" "HotelReservationStatus", "toStatus" "HotelReservationStatus",
 "actorId" TEXT NOT NULL, "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "reason" TEXT, "metadata" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","branchId","reservationId") REFERENCES "hotel_reservations"("organizationId","branchId","id") ON DELETE RESTRICT
);
CREATE INDEX hotel_reservation_events_timeline_idx ON "hotel_reservation_events"("organizationId","branchId","reservationId","occurredAt");

CREATE TABLE "hotel_confirmation_number_sequences" ("id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"nextNumber" INTEGER NOT NULL DEFAULT 1,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT hotel_confirmation_next_ck CHECK("nextNumber">0),UNIQUE("organizationId","branchId"),FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE CASCADE);
CREATE TABLE "hotel_operation_idempotency_keys" ("id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"scope" TEXT NOT NULL,"key" TEXT NOT NULL,"requestHash" TEXT NOT NULL,"resultType" TEXT,"resultId" TEXT,"response" JSONB,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE("organizationId","branchId","scope","key"),UNIQUE("organizationId","branchId","id"),FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT);
CREATE INDEX hotel_idempotency_created_idx ON "hotel_operation_idempotency_keys"("organizationId","branchId","createdAt");

CREATE TABLE "hotel_folios" (
 "id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"reservationId" TEXT NOT NULL,
 "folioNumber" TEXT NOT NULL,"status" "HotelFolioStatus" NOT NULL DEFAULT 'OPEN',"guestId" TEXT NOT NULL,"currency" TEXT NOT NULL,"openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"closedAt" TIMESTAMP(3),"version" INTEGER NOT NULL DEFAULT 1,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT hotel_folio_close_ck CHECK(("status"='OPEN' AND "closedAt" IS NULL) OR ("status"<>'OPEN' AND "closedAt" IS NOT NULL)),
 UNIQUE("organizationId","branchId","reservationId"),UNIQUE("organizationId","branchId","folioNumber"),UNIQUE("organizationId","branchId","id"),
 FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","branchId","reservationId") REFERENCES "hotel_reservations"("organizationId","branchId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","guestId") REFERENCES "hotel_guests"("organizationId","id") ON DELETE RESTRICT);
CREATE INDEX hotel_folios_list_idx ON "hotel_folios"("organizationId","branchId","status","openedAt");

CREATE TABLE "hotel_folio_postings" (
 "id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"folioId" TEXT NOT NULL,
 "kind" "HotelFolioPostingKind" NOT NULL,"sourceKind" "HotelFolioSourceKind" NOT NULL,"sourceId" TEXT,"reversesPostingId" TEXT,"serviceDate" DATE NOT NULL,
 "description" TEXT NOT NULL,"quantity" INTEGER NOT NULL,"unitAmountMinor" INTEGER NOT NULL,"netMinor" INTEGER NOT NULL,"taxMinor" INTEGER NOT NULL,"totalMinor" INTEGER NOT NULL,
 "currency" TEXT NOT NULL,"postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"postedById" TEXT NOT NULL,"reason" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT hotel_posting_amount_ck CHECK("quantity">0 AND "taxMinor">=0 AND "totalMinor"="netMinor"+"taxMinor"),
 CONSTRAINT hotel_posting_reversal_ck CHECK(("kind"='REVERSAL')=("reversesPostingId" IS NOT NULL)),
 UNIQUE("organizationId","branchId","id"),
 FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","branchId","folioId") REFERENCES "hotel_folios"("organizationId","branchId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","branchId","reversesPostingId") REFERENCES "hotel_folio_postings"("organizationId","branchId","id") ON DELETE RESTRICT);
CREATE UNIQUE INDEX hotel_postings_source_key ON "hotel_folio_postings"("organizationId","branchId","folioId","sourceKind","sourceId") WHERE "sourceId" IS NOT NULL;
CREATE INDEX hotel_postings_timeline_idx ON "hotel_folio_postings"("organizationId","branchId","folioId","postedAt");
CREATE INDEX hotel_postings_service_idx ON "hotel_folio_postings"("organizationId","branchId","serviceDate","kind");

CREATE TABLE "hotel_payment_attempts" (
 "id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"folioId" TEXT NOT NULL,"tenderType" "HotelTenderType" NOT NULL,"direction" "HotelPaymentDirection" NOT NULL,"status" "HotelPaymentAttemptStatus" NOT NULL,"amountMinor" INTEGER NOT NULL,"currency" TEXT NOT NULL,"provider" TEXT,"externalReference" TEXT,"idempotencyKeyId" TEXT NOT NULL,"requestedById" TEXT NOT NULL,"failureCode" TEXT,"failureMessage" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT hotel_payment_attempt_amount_ck CHECK("amountMinor">0),UNIQUE("organizationId","branchId","id"),
 FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,FOREIGN KEY("organizationId","branchId","folioId") REFERENCES "hotel_folios"("organizationId","branchId","id") ON DELETE RESTRICT,FOREIGN KEY("organizationId","branchId","idempotencyKeyId") REFERENCES "hotel_operation_idempotency_keys"("organizationId","branchId","id") ON DELETE RESTRICT);
CREATE INDEX hotel_attempts_folio_idx ON "hotel_payment_attempts"("organizationId","branchId","folioId","createdAt");
CREATE INDEX hotel_attempts_status_idx ON "hotel_payment_attempts"("organizationId","branchId","status","createdAt");

CREATE TABLE "hotel_folio_payments" (
 "id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"folioId" TEXT NOT NULL,"attemptId" TEXT NOT NULL,"receiptNumber" TEXT NOT NULL,"tenderType" "HotelTenderType" NOT NULL,"direction" "HotelPaymentDirection" NOT NULL,"amountMinor" INTEGER NOT NULL,"currency" TEXT NOT NULL,"refundsPaymentId" TEXT,"settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"settledById" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT hotel_payment_amount_ck CHECK("amountMinor">0),CONSTRAINT hotel_payment_refund_link_ck CHECK(("direction"='REFUND')=("refundsPaymentId" IS NOT NULL)),
 UNIQUE("organizationId","branchId","attemptId"),UNIQUE("organizationId","branchId","receiptNumber"),UNIQUE("organizationId","branchId","id"),
 FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,FOREIGN KEY("organizationId","branchId","folioId") REFERENCES "hotel_folios"("organizationId","branchId","id") ON DELETE RESTRICT,FOREIGN KEY("organizationId","branchId","attemptId") REFERENCES "hotel_payment_attempts"("organizationId","branchId","id") ON DELETE RESTRICT,FOREIGN KEY("organizationId","branchId","refundsPaymentId") REFERENCES "hotel_folio_payments"("organizationId","branchId","id") ON DELETE RESTRICT);
CREATE INDEX hotel_payments_timeline_idx ON "hotel_folio_payments"("organizationId","branchId","folioId","settledAt");

CREATE TABLE "hotel_payment_events" ("id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"paymentAttemptId" TEXT NOT NULL,"kind" "HotelPaymentEventKind" NOT NULL,"occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"providerReference" TEXT,"metadata" JSONB NOT NULL DEFAULT '{}',"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,FOREIGN KEY("organizationId","branchId","paymentAttemptId") REFERENCES "hotel_payment_attempts"("organizationId","branchId","id") ON DELETE RESTRICT);
CREATE UNIQUE INDEX hotel_payment_events_provider_key ON "hotel_payment_events"("organizationId","branchId","paymentAttemptId","providerReference") WHERE "providerReference" IS NOT NULL;
CREATE INDEX hotel_payment_events_timeline_idx ON "hotel_payment_events"("organizationId","branchId","paymentAttemptId","occurredAt");
CREATE TABLE "hotel_receipt_number_sequences" ("id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"nextNumber" INTEGER NOT NULL DEFAULT 1,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT hotel_receipt_next_ck CHECK("nextNumber">0),UNIQUE("organizationId","branchId"),FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE CASCADE);

CREATE TABLE "hotel_night_audit_runs" ("id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"businessDate" DATE NOT NULL,"status" "HotelNightAuditStatus" NOT NULL,"currentStep" "HotelNightAuditStep" NOT NULL,"startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"startedById" TEXT NOT NULL,"completedAt" TIMESTAMP(3),"failedAt" TIMESTAMP(3),"failureCode" TEXT,"failureMessage" TEXT,"summary" JSONB NOT NULL DEFAULT '{}',"version" INTEGER NOT NULL DEFAULT 1,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,UNIQUE("organizationId","branchId","businessDate"),UNIQUE("organizationId","branchId","id"),FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT);
CREATE UNIQUE INDEX hotel_audit_one_running_idx ON "hotel_night_audit_runs"("organizationId","branchId") WHERE "status"='RUNNING';
CREATE INDEX hotel_audit_list_idx ON "hotel_night_audit_runs"("organizationId","branchId","status","businessDate");
CREATE TABLE "hotel_night_audit_step_runs" ("id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"auditRunId" TEXT NOT NULL,"step" "HotelNightAuditStep" NOT NULL,"status" "HotelNightAuditStepStatus" NOT NULL,"attempt" INTEGER NOT NULL DEFAULT 1,"startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"completedAt" TIMESTAMP(3),"result" JSONB NOT NULL DEFAULT '{}',"errorCode" TEXT,"errorMessage" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT hotel_audit_attempt_ck CHECK("attempt">0),UNIQUE("auditRunId","step"),FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,FOREIGN KEY("organizationId","branchId","auditRunId") REFERENCES "hotel_night_audit_runs"("organizationId","branchId","id") ON DELETE RESTRICT);
CREATE INDEX hotel_audit_steps_idx ON "hotel_night_audit_step_runs"("organizationId","branchId","auditRunId","status");
CREATE TABLE "hotel_daily_snapshots" ("id" TEXT PRIMARY KEY,"organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id',true),"branchId" TEXT NOT NULL,"auditRunId" TEXT NOT NULL,"businessDate" DATE NOT NULL,"roomsAvailable" INTEGER NOT NULL,"roomsOccupied" INTEGER NOT NULL,"roomsOutOfOrder" INTEGER NOT NULL,"arrivals" INTEGER NOT NULL,"departures" INTEGER NOT NULL,"noShows" INTEGER NOT NULL,"roomRevenueMinor" INTEGER NOT NULL,"extrasMinor" INTEGER NOT NULL,"taxMinor" INTEGER NOT NULL,"adjustmentsMinor" INTEGER NOT NULL,"cashCollectionsMinor" INTEGER NOT NULL,"cashRefundsMinor" INTEGER NOT NULL,"cardCollectionsMinor" INTEGER NOT NULL,"cardRefundsMinor" INTEGER NOT NULL,"closingReceivableMinor" INTEGER NOT NULL,"currency" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE("organizationId","branchId","businessDate"),UNIQUE("organizationId","branchId","auditRunId"),FOREIGN KEY("organizationId","branchId") REFERENCES "hotel_properties"("organizationId","branchId") ON DELETE RESTRICT,FOREIGN KEY("organizationId","branchId","auditRunId") REFERENCES "hotel_night_audit_runs"("organizationId","branchId","id") ON DELETE RESTRICT);
CREATE INDEX hotel_snapshots_date_idx ON "hotel_daily_snapshots"("organizationId","branchId","businessDate");

-- Stay dates remain inside their reservation even for direct SQL writers.
CREATE FUNCTION hotel_stay_unit_range_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a date; d date; BEGIN
 SELECT "arrivalDate","departureDate" INTO a,d FROM "hotel_reservations" WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "id"=NEW."reservationId" FOR SHARE;
 IF NEW."arrivalDate"<a OR NEW."departureDate">d THEN RAISE EXCEPTION 'Stay unit dates must be inside reservation dates' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER hotel_stay_unit_range_guard BEFORE INSERT OR UPDATE ON "hotel_reservation_stay_units" FOR EACH ROW EXECUTE FUNCTION hotel_stay_unit_range_guard();

-- Cross-row guards serialize the original row before validating cumulative corrections.
CREATE FUNCTION hotel_posting_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE original bigint; reversed bigint; BEGIN
 IF NEW."reversesPostingId" IS NULL THEN RETURN NEW; END IF;
 SELECT abs("totalMinor") INTO original FROM "hotel_folio_postings" WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "id"=NEW."reversesPostingId" AND "kind"<>'REVERSAL' FOR UPDATE;
 SELECT coalesce(sum(abs("totalMinor")),0) INTO reversed FROM "hotel_folio_postings" WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "reversesPostingId"=NEW."reversesPostingId";
 IF original IS NULL OR reversed+abs(NEW."totalMinor")>original THEN RAISE EXCEPTION 'Reversal exceeds original posting' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER hotel_posting_reversal_guard BEFORE INSERT ON "hotel_folio_postings" FOR EACH ROW EXECUTE FUNCTION hotel_posting_reversal_guard();
CREATE FUNCTION hotel_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE original bigint; refunded bigint; BEGIN
 IF NEW."direction"<>'REFUND' THEN RETURN NEW; END IF;
 SELECT "amountMinor" INTO original FROM "hotel_folio_payments" WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "id"=NEW."refundsPaymentId" AND "direction"='COLLECTION' FOR UPDATE;
 SELECT coalesce(sum("amountMinor"),0) INTO refunded FROM "hotel_folio_payments" WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "refundsPaymentId"=NEW."refundsPaymentId";
 IF original IS NULL OR refunded+NEW."amountMinor">original THEN RAISE EXCEPTION 'Refund exceeds settled payment' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER hotel_refund_guard BEFORE INSERT ON "hotel_folio_payments" FOR EACH ROW EXECUTE FUNCTION hotel_refund_guard();

-- Append-only evidence may only be removed by the explicit tenant purge path.
CREATE FUNCTION hotel_mvp_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND NULLIF(current_setting('app.purging_organization_id',true),'')=OLD."organizationId" THEN RETURN OLD; END IF;
 RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='23514'; END $$;
CREATE TRIGGER hotel_reservation_events_immutable BEFORE UPDATE OR DELETE ON "hotel_reservation_events" FOR EACH ROW EXECUTE FUNCTION hotel_mvp_immutable_guard();
CREATE TRIGGER hotel_folio_postings_immutable BEFORE UPDATE OR DELETE ON "hotel_folio_postings" FOR EACH ROW EXECUTE FUNCTION hotel_mvp_immutable_guard();
CREATE TRIGGER hotel_folio_payments_immutable BEFORE UPDATE OR DELETE ON "hotel_folio_payments" FOR EACH ROW EXECUTE FUNCTION hotel_mvp_immutable_guard();
CREATE TRIGGER hotel_payment_events_immutable BEFORE UPDATE OR DELETE ON "hotel_payment_events" FOR EACH ROW EXECUTE FUNCTION hotel_mvp_immutable_guard();
CREATE TRIGGER hotel_daily_snapshots_immutable BEFORE UPDATE OR DELETE ON "hotel_daily_snapshots" FOR EACH ROW EXECUTE FUNCTION hotel_mvp_immutable_guard();

-- Standard tenant wall used by the other hospitality tables.
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['hotel_guests','hotel_reservations','hotel_reservation_stay_units','hotel_room_assignments','hotel_reservation_events','hotel_confirmation_number_sequences','hotel_operation_idempotency_keys','hotel_folios','hotel_folio_postings','hotel_payment_attempts','hotel_folio_payments','hotel_payment_events','hotel_receipt_number_sequences','hotel_night_audit_runs','hotel_night_audit_step_runs','hotel_daily_snapshots'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY %I ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),''''))',t||'_tenant_isolation',t);
 END LOOP; END $$;
