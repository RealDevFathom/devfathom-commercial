-- WHA-909: Restaurant Workforce v1. Additive only: the existing roster stays
-- authoritative for scheduled work; server-timestamped attendance, breaks,
-- immutable swap decisions, transition events, corrections and retry receipts
-- extend it without introducing payroll or a financial source of truth.

CREATE TYPE "RestaurantShiftSwapDecisionKind" AS ENUM ('APPROVED', 'REJECTED');
CREATE TYPE "RestaurantShiftEventKind" AS ENUM (
  'PUBLISHED', 'UPDATED', 'CANCELLED', 'SWAP_REQUESTED', 'SWAP_APPROVED', 'SWAP_REJECTED'
);
CREATE TYPE "RestaurantTimeAdjustmentKind" AS ENUM ('CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END');
CREATE TYPE "RestaurantWorkforceCommandKind" AS ENUM (
  'CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END',
  'SWAP_REQUEST', 'SWAP_APPROVE', 'SWAP_REJECT'
);

ALTER TABLE "restaurant_shifts"
  ADD COLUMN "clockedInAt" TIMESTAMP(3),
  ADD COLUMN "clockedOutAt" TIMESTAMP(3),
  ADD CONSTRAINT "restaurant_shifts_timekeeping_ck" CHECK (
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
  "replacementStaffProfileId" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_shift_swap_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_shift_swap_distinct_staff_ck" CHECK ("requestedByStaffProfileId" <> "replacementStaffProfileId")
);

CREATE TABLE "restaurant_shift_swap_decisions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "requestId" TEXT NOT NULL,
  "decision" "RestaurantShiftSwapDecisionKind" NOT NULL,
  "decidedByUserId" TEXT NOT NULL,
  "decidedByStaffProfileId" TEXT,
  "reason" TEXT,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_shift_swap_decisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_shift_events" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "shiftId" TEXT NOT NULL,
  "kind" "RestaurantShiftEventKind" NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "fromStaffProfileId" TEXT,
  "toStaffProfileId" TEXT,
  "reason" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_shift_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restaurant_time_adjustments" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "shiftId" TEXT NOT NULL,
  "breakId" TEXT,
  "kind" "RestaurantTimeAdjustmentKind" NOT NULL,
  "originalAt" TIMESTAMP(3) NOT NULL,
  "correctedAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "adjustedByUserId" TEXT NOT NULL,
  "adjustedByStaffProfileId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_time_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_time_adjustment_target_ck" CHECK (
    (("kind" IN ('BREAK_START', 'BREAK_END')) = ("breakId" IS NOT NULL))
  )
);

CREATE TABLE "restaurant_workforce_commands" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "idempotencyKey" TEXT NOT NULL,
  "kind" "RestaurantWorkforceCommandKind" NOT NULL,
  "shiftId" TEXT NOT NULL,
  "breakId" TEXT,
  "swapRequestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_workforce_commands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_shift_breaks_organizationId_id_key" ON "restaurant_shift_breaks"("organizationId", "id");
CREATE INDEX "restaurant_shift_breaks_organizationId_idx" ON "restaurant_shift_breaks"("organizationId");
CREATE INDEX "restaurant_shift_breaks_shiftId_startedAt_idx" ON "restaurant_shift_breaks"("shiftId", "startedAt");
CREATE UNIQUE INDEX "restaurant_shift_breaks_one_open_idx" ON "restaurant_shift_breaks"("organizationId", "shiftId") WHERE "endedAt" IS NULL;

CREATE UNIQUE INDEX "restaurant_shift_swap_requests_organizationId_id_key" ON "restaurant_shift_swap_requests"("organizationId", "id");
CREATE INDEX "restaurant_shift_swap_requests_organizationId_idx" ON "restaurant_shift_swap_requests"("organizationId");
CREATE INDEX "restaurant_shift_swap_requests_shiftId_createdAt_idx" ON "restaurant_shift_swap_requests"("shiftId", "createdAt");
CREATE INDEX "restaurant_shift_swap_requests_requester_createdAt_idx" ON "restaurant_shift_swap_requests"("requestedByStaffProfileId", "createdAt");

CREATE UNIQUE INDEX "restaurant_shift_swap_decisions_organizationId_id_key" ON "restaurant_shift_swap_decisions"("organizationId", "id");
CREATE UNIQUE INDEX "restaurant_shift_swap_decisions_requestId_key" ON "restaurant_shift_swap_decisions"("requestId");
CREATE INDEX "restaurant_shift_swap_decisions_organizationId_idx" ON "restaurant_shift_swap_decisions"("organizationId");
CREATE INDEX "restaurant_shift_swap_decisions_decidedAt_idx" ON "restaurant_shift_swap_decisions"("decidedAt");

CREATE UNIQUE INDEX "restaurant_shift_events_organizationId_id_key" ON "restaurant_shift_events"("organizationId", "id");
CREATE INDEX "restaurant_shift_events_organizationId_idx" ON "restaurant_shift_events"("organizationId");
CREATE INDEX "restaurant_shift_events_shiftId_occurredAt_idx" ON "restaurant_shift_events"("shiftId", "occurredAt");

CREATE UNIQUE INDEX "restaurant_time_adjustments_organizationId_id_key" ON "restaurant_time_adjustments"("organizationId", "id");
CREATE INDEX "restaurant_time_adjustments_organizationId_idx" ON "restaurant_time_adjustments"("organizationId");
CREATE INDEX "restaurant_time_adjustments_shift_kind_created_idx" ON "restaurant_time_adjustments"("shiftId", "kind", "createdAt");
CREATE INDEX "restaurant_time_adjustments_break_kind_created_idx" ON "restaurant_time_adjustments"("breakId", "kind", "createdAt");

CREATE UNIQUE INDEX "restaurant_workforce_commands_organizationId_id_key" ON "restaurant_workforce_commands"("organizationId", "id");
CREATE UNIQUE INDEX "restaurant_workforce_commands_org_idempotency_key" ON "restaurant_workforce_commands"("organizationId", "idempotencyKey");
CREATE INDEX "restaurant_workforce_commands_shift_created_idx" ON "restaurant_workforce_commands"("shiftId", "createdAt");

ALTER TABLE "restaurant_shift_breaks" ADD CONSTRAINT "restaurant_shift_breaks_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "restaurant_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "restaurant_shift_swap_requests_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "restaurant_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "restaurant_shift_swap_requests_requester_fkey" FOREIGN KEY ("requestedByStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "restaurant_shift_swap_requests_replacement_fkey" FOREIGN KEY ("replacementStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_shift_swap_decisions" ADD CONSTRAINT "restaurant_shift_swap_decisions_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "restaurant_shift_swap_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_shift_events" ADD CONSTRAINT "restaurant_shift_events_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "restaurant_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_time_adjustments" ADD CONSTRAINT "restaurant_time_adjustments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "restaurant_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_time_adjustments" ADD CONSTRAINT "restaurant_time_adjustments_breakId_fkey" FOREIGN KEY ("breakId") REFERENCES "restaurant_shift_breaks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_workforce_commands" ADD CONSTRAINT "restaurant_workforce_commands_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "restaurant_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_workforce_commands" ADD CONSTRAINT "restaurant_workforce_commands_breakId_fkey" FOREIGN KEY ("breakId") REFERENCES "restaurant_shift_breaks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_workforce_commands" ADD CONSTRAINT "restaurant_workforce_commands_swapRequestId_fkey" FOREIGN KEY ("swapRequestId") REFERENCES "restaurant_shift_swap_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite tenant FKs prevent platform-scope writes from binding children to a
-- parent in another organization. Deferred form matches the established Restaurant pattern.
ALTER TABLE "restaurant_shift_breaks" ADD CONSTRAINT "tenant_shift_break_shift_fk" FOREIGN KEY ("organizationId", "shiftId") REFERENCES "restaurant_shifts"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "tenant_shift_swap_shift_fk" FOREIGN KEY ("organizationId", "shiftId") REFERENCES "restaurant_shifts"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "tenant_shift_swap_requester_fk" FOREIGN KEY ("organizationId", "requestedByStaffProfileId") REFERENCES "restaurant_staff_profiles"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_shift_swap_requests" ADD CONSTRAINT "tenant_shift_swap_replacement_fk" FOREIGN KEY ("organizationId", "replacementStaffProfileId") REFERENCES "restaurant_staff_profiles"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_shift_swap_decisions" ADD CONSTRAINT "tenant_shift_swap_decision_request_fk" FOREIGN KEY ("organizationId", "requestId") REFERENCES "restaurant_shift_swap_requests"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_shift_events" ADD CONSTRAINT "tenant_shift_event_shift_fk" FOREIGN KEY ("organizationId", "shiftId") REFERENCES "restaurant_shifts"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_time_adjustments" ADD CONSTRAINT "tenant_time_adjustment_shift_fk" FOREIGN KEY ("organizationId", "shiftId") REFERENCES "restaurant_shifts"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_time_adjustments" ADD CONSTRAINT "tenant_time_adjustment_break_fk" FOREIGN KEY ("organizationId", "breakId") REFERENCES "restaurant_shift_breaks"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_workforce_commands" ADD CONSTRAINT "tenant_workforce_command_shift_fk" FOREIGN KEY ("organizationId", "shiftId") REFERENCES "restaurant_shifts"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_workforce_commands" ADD CONSTRAINT "tenant_workforce_command_break_fk" FOREIGN KEY ("organizationId", "breakId") REFERENCES "restaurant_shift_breaks"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_workforce_commands" ADD CONSTRAINT "tenant_workforce_command_swap_fk" FOREIGN KEY ("organizationId", "swapRequestId") REFERENCES "restaurant_shift_swap_requests"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION reject_restaurant_workforce_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'restaurant workforce history is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION guard_restaurant_shift_time_observations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."clockedInAt" IS NOT NULL AND NEW."clockedInAt" IS DISTINCT FROM OLD."clockedInAt" THEN
    RAISE EXCEPTION 'restaurant shift time observations are append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD."clockedOutAt" IS NOT NULL AND NEW."clockedOutAt" IS DISTINCT FROM OLD."clockedOutAt" THEN
    RAISE EXCEPTION 'restaurant shift time observations are append-only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_restaurant_break_time_observations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" OR
     (OLD."endedAt" IS NOT NULL AND NEW."endedAt" IS DISTINCT FROM OLD."endedAt") THEN
    RAISE EXCEPTION 'restaurant break time observations are append-only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER restaurant_shift_swap_request_immutable BEFORE UPDATE OR DELETE ON "restaurant_shift_swap_requests" FOR EACH ROW EXECUTE FUNCTION reject_restaurant_workforce_history_mutation();
CREATE TRIGGER restaurant_shift_swap_decision_immutable BEFORE UPDATE OR DELETE ON "restaurant_shift_swap_decisions" FOR EACH ROW EXECUTE FUNCTION reject_restaurant_workforce_history_mutation();
CREATE TRIGGER restaurant_shift_event_immutable BEFORE UPDATE OR DELETE ON "restaurant_shift_events" FOR EACH ROW EXECUTE FUNCTION reject_restaurant_workforce_history_mutation();
CREATE TRIGGER restaurant_time_adjustment_immutable BEFORE UPDATE OR DELETE ON "restaurant_time_adjustments" FOR EACH ROW EXECUTE FUNCTION reject_restaurant_workforce_history_mutation();
CREATE TRIGGER restaurant_workforce_command_immutable BEFORE UPDATE OR DELETE ON "restaurant_workforce_commands" FOR EACH ROW EXECUTE FUNCTION reject_restaurant_workforce_history_mutation();
CREATE TRIGGER restaurant_shift_time_observation_guard BEFORE UPDATE ON "restaurant_shifts" FOR EACH ROW EXECUTE FUNCTION guard_restaurant_shift_time_observations();
CREATE TRIGGER restaurant_break_time_observation_guard BEFORE UPDATE OR DELETE ON "restaurant_shift_breaks" FOR EACH ROW EXECUTE FUNCTION guard_restaurant_break_time_observations();

-- Mutable break state needs SELECT/INSERT/UPDATE; append-only history receives
-- SELECT/INSERT only. All tables are forced through tenant RLS.
ALTER TABLE "restaurant_shift_breaks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_shift_breaks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_shift_breaks" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'restaurant_shift_swap_requests', 'restaurant_shift_swap_decisions',
    'restaurant_shift_events', 'restaurant_time_adjustments', 'restaurant_workforce_commands'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_select ON %I FOR SELECT USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      table_name
    );
  END LOOP;
END;
$$;
