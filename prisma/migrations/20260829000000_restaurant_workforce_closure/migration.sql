CREATE TYPE "RestaurantShiftSwapStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED');

ALTER TABLE "restaurant_shifts"
  ADD COLUMN "clockedInAt" TIMESTAMP(3),
  ADD COLUMN "lateArrivalAt" TIMESTAMP(3),
  ADD COLUMN "clockedOutAt" TIMESTAMP(3),
  ADD CONSTRAINT "restaurant_shifts_attendance_ck" CHECK (
    ("lateArrivalAt" IS NULL OR "clockedInAt" IS NOT NULL) AND
    ("clockedOutAt" IS NULL OR "clockedInAt" IS NOT NULL) AND
    ("clockedOutAt" IS NULL OR "clockedOutAt" >= "clockedInAt")
  );

CREATE TABLE "restaurant_shift_breaks" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "shiftId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_shift_breaks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_shift_breaks_window_ck" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt")
);

CREATE TABLE "restaurant_shift_swap_requests" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "shiftId" TEXT NOT NULL,
  "requestedByStaffProfileId" TEXT NOT NULL,
  "replacementStaffProfileId" TEXT,
  "status" "RestaurantShiftSwapStatus" NOT NULL DEFAULT 'REQUESTED',
  "note" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_shift_swap_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_shift_swap_review_ck" CHECK (("status" = 'REQUESTED') = ("reviewedAt" IS NULL))
);

CREATE INDEX "restaurant_shift_breaks_organizationId_idx" ON "restaurant_shift_breaks"("organizationId");
CREATE INDEX "restaurant_shift_breaks_shiftId_startedAt_idx" ON "restaurant_shift_breaks"("shiftId", "startedAt");
CREATE INDEX "restaurant_shift_swap_requests_organizationId_idx" ON "restaurant_shift_swap_requests"("organizationId");
CREATE INDEX "restaurant_shift_swap_requests_shiftId_status_idx" ON "restaurant_shift_swap_requests"("shiftId", "status");
CREATE INDEX "restaurant_shift_swap_requests_requestedByStaffProfileId_status_idx" ON "restaurant_shift_swap_requests"("requestedByStaffProfileId", "status");

ALTER TABLE "restaurant_shift_breaks" ADD CONSTRAINT "restaurant_shift_breaks_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "restaurant_shift_swap_requests_organizationId_id_key" UNIQUE ("organizationId", "id");

ALTER TABLE "restaurant_shift_breaks" ADD CONSTRAINT "restaurant_shift_breaks_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "restaurant_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "restaurant_shift_swap_requests_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "restaurant_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "restaurant_shift_swap_requests_requestedByStaffProfileId_fkey" FOREIGN KEY ("requestedByStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "restaurant_shift_swap_requests_replacementStaffProfileId_fkey" FOREIGN KEY ("replacementStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_shift_breaks" ADD CONSTRAINT "tenant_shift_break_shiftId_fk" FOREIGN KEY ("organizationId", "shiftId") REFERENCES "restaurant_shifts"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "tenant_shift_swap_shiftId_fk" FOREIGN KEY ("organizationId", "shiftId") REFERENCES "restaurant_shifts"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "tenant_shift_swap_requester_fk" FOREIGN KEY ("organizationId", "requestedByStaffProfileId") REFERENCES "restaurant_staff_profiles"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "tenant_shift_swap_replacement_fk" FOREIGN KEY ("organizationId", "replacementStaffProfileId") REFERENCES "restaurant_staff_profiles"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_shift_breaks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_shift_breaks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_shift_breaks_tenant_isolation" ON "restaurant_shift_breaks" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_shift_swap_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_shift_swap_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_shift_swap_requests_tenant_isolation" ON "restaurant_shift_swap_requests" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
