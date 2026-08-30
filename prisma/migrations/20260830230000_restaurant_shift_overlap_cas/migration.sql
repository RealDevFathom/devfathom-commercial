-- WHA-909 review amendment: database-arbitrated live-shift overlap protection
-- plus an integer compare-and-swap token for mutable schedule commands.
-- btree_gist is prepared by the existing extension migration; repeating the
-- idempotent declaration keeps this migration independently legible.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "restaurant_shifts"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "restaurant_shifts"
  ADD CONSTRAINT "restaurant_shifts_live_employee_no_overlap"
  EXCLUDE USING gist (
    "organizationId" WITH =,
    "staffProfileId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  ) WHERE ("status" = 'SCHEDULED');

