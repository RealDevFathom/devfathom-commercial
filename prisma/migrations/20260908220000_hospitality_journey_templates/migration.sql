-- H1-14 / UPS-04 (04 §5.17, 05 §1.3–§1.4) — the guest journey template model.
--
-- One row is one *version* of one message: a moment, a channel, a language. The
-- table is versioned rather than editable-in-place because UPS-04's acceptance
-- is "template approval before use": once a property has approved the words it
-- sends a guest, changing them must produce a new version to approve, not a
-- silent rewrite of the approved one.
--
-- Sending is H4's lane. Nothing here sends; this migration only makes the
-- approved wording addressable and provable.

-- The eight journeys of §5.17. BOOKING_CONFIRMED..REVIEW_REQUEST is the order a
-- stay actually runs in, so a list rendered in enum order reads correctly.
CREATE TYPE "HotelJourneyMoment" AS ENUM (
  'BOOKING_CONFIRMED',
  'PRE_ARRIVAL_UPSELL',
  'SELF_CHECKIN',
  'WELCOME',
  'IN_STAY',
  'EXPRESS_CHECKOUT',
  'INVOICE',
  'REVIEW_REQUEST'
);

CREATE TYPE "HotelJourneyChannel" AS ENUM ('WHATSAPP', 'EMAIL', 'SMS');

-- EN/UR only. The property's `languages` column defaults to ["en","ur"] and the
-- pack is explicit that the guest journey is Urdu/English; no other script is
-- offered here.
CREATE TYPE "HotelJourneyLanguage" AS ENUM ('EN', 'UR');

CREATE TYPE "HotelJourneyTemplateStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

CREATE TABLE "hotel_journey_templates" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  -- In hospitality the branch IS the property (H1-01), so this is the property.
  "branchId" TEXT NOT NULL,
  "moment" "HotelJourneyMoment" NOT NULL,
  "channel" "HotelJourneyChannel" NOT NULL,
  "language" "HotelJourneyLanguage" NOT NULL,
  -- Only an e-mail has a subject line; the CHECK below refuses one on WhatsApp
  -- and SMS rather than letting a surface decide to ignore it.
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "HotelJourneyTemplateStatus" NOT NULL DEFAULT 'DRAFT',
  "approvedByUserId" TEXT,
  "approvedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_journey_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_journey_templates_version_ck" CHECK ("version" >= 1),
  CONSTRAINT "hotel_journey_templates_body_ck" CHECK (length(btrim("body")) > 0),
  -- A subject is an e-mail fact. Present or absent, it is never blank.
  CONSTRAINT "hotel_journey_templates_subject_ck" CHECK (
    ("channel" = 'EMAIL' OR "subject" IS NULL)
    AND ("subject" IS NULL OR length(btrim("subject")) > 0)
  ),
  -- The approval facts and the status cannot disagree: an APPROVED row names
  -- its approver and the moment of approval, a DRAFT names neither, and a
  -- RETIRED row keeps whatever it had (a retired template that was once
  -- approved must still show who approved it).
  CONSTRAINT "hotel_journey_templates_approval_ck" CHECK (
    (("approvedByUserId" IS NULL) = ("approvedAt" IS NULL))
    AND ("status" <> 'APPROVED' OR "approvedByUserId" IS NOT NULL)
    AND ("status" <> 'DRAFT' OR "approvedByUserId" IS NULL)
  ),
  CONSTRAINT "hotel_journey_templates_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "hotel_journey_templates_org_id_key"
  ON "hotel_journey_templates"("organizationId", "id");

-- One version number per message per property. A second draft of the same
-- moment/channel/language is version N+1, never a second version N.
CREATE UNIQUE INDEX "hotel_journey_templates_version_key"
  ON "hotel_journey_templates"("organizationId", "branchId", "moment", "channel", "language", "version");

-- UPS-04: at most one APPROVED version of a message may exist at a time, so
-- "which wording did we send?" has exactly one answer without the sender
-- picking. Approving a new version retires the old one in the same transaction.
CREATE UNIQUE INDEX "hotel_journey_templates_approved_key"
  ON "hotel_journey_templates"("organizationId", "branchId", "moment", "channel", "language")
  WHERE "status" = 'APPROVED';

CREATE INDEX "hotel_journey_templates_board_idx"
  ON "hotel_journey_templates"("organizationId", "branchId", "moment", "status");

-- Tenant isolation is the database's job and is forced for the table owner too,
-- so a migration or a job running as the owner cannot read across tenants.
ALTER TABLE "hotel_journey_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_journey_templates" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hotel_journey_templates_tenant_isolation" ON "hotel_journey_templates"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
