-- WHA-1314 / AI-04 + RPT-03 — deterministic, review-only pharmacy anomalies.
-- §8 and §8A invariants 22/29: signals preserve exact evidence and estimate
-- metadata, and cannot point at or create orders, stock movements, or postings.

CREATE TYPE "PharmacyAnomalySignalKind" AS ENUM (
  'SHRINKAGE','DISCOUNT_OVERRIDE','GHOST_RETURN','CASH_VARIANCE','PURCHASE_PRICE_DRIFT'
);
CREATE TYPE "PharmacyAnomalySignalStatus" AS ENUM (
  'OPEN','ACKNOWLEDGED','SNOOZED','CLOSED','STALE'
);
CREATE TYPE "PharmacyAnomalySignalSeverity" AS ENUM ('NOTICE','REVIEW','URGENT');
CREATE TYPE "PharmacyAnomalySignalEventKind" AS ENUM (
  'RAISED','REFRESHED','ACKNOWLEDGED','SNOOZED','CLOSED','MARKED_STALE'
);

CREATE TABLE "pharmacy_anomaly_signals" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "kind" "PharmacyAnomalySignalKind" NOT NULL,
  "dedupKey" TEXT NOT NULL,
  "status" "PharmacyAnomalySignalStatus" NOT NULL DEFAULT 'OPEN',
  "severity" "PharmacyAnomalySignalSeverity" NOT NULL,
  "scope" JSONB NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "exactNumbers" JSONB NOT NULL,
  "explanation" TEXT NOT NULL,
  "dataWindowStart" TIMESTAMP(3) NOT NULL,
  "dataWindowEnd" TIMESTAMP(3) NOT NULL,
  "sourceObservedAt" TIMESTAMP(3) NOT NULL,
  "freshnessSeconds" INTEGER NOT NULL,
  "estimateMethod" TEXT,
  "estimateWindow" TEXT,
  "estimateExclusions" TEXT,
  "estimateConfidence" TEXT,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedByUserId" TEXT,
  "snoozedUntil" TIMESTAMP(3),
  "snoozeReason" TEXT,
  "closedAt" TIMESTAMP(3),
  "markedStaleAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_anomaly_signals_branch_fkey"
    FOREIGN KEY ("organizationId","branchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_anomaly_signals_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_anomaly_signals_org_branch_id_key" UNIQUE ("organizationId","branchId","id"),
  CONSTRAINT "pharmacy_anomaly_signals_text_check" CHECK (
    length(btrim("branchId"))>0 AND length(btrim("dedupKey"))>0
    AND length(btrim("policyVersion"))>0 AND length(btrim("explanation"))>0),
  CONSTRAINT "pharmacy_anomaly_signals_window_check" CHECK (
    "dataWindowStart"<="dataWindowEnd" AND "freshnessSeconds">0),
  CONSTRAINT "pharmacy_anomaly_signals_scope_check" CHECK (
    jsonb_typeof("scope")='object' AND "scope"->>'branchId'="branchId"),
  CONSTRAINT "pharmacy_anomaly_signals_numbers_check" CHECK (jsonb_typeof("exactNumbers")='object'),
  -- Invariant 22: an estimated comparison is either fully explained or absent.
  CONSTRAINT "pharmacy_anomaly_signals_estimate_check" CHECK (
    ("estimateMethod" IS NULL AND "estimateWindow" IS NULL AND "estimateExclusions" IS NULL AND "estimateConfidence" IS NULL)
    OR (length(btrim("estimateMethod"))>0 AND length(btrim("estimateWindow"))>0
        AND length(btrim("estimateExclusions"))>0 AND "estimateConfidence" IN ('LOW','MEDIUM','HIGH'))),
  CONSTRAINT "pharmacy_anomaly_signals_ack_check" CHECK (
    ("acknowledgedAt" IS NULL)=("acknowledgedByUserId" IS NULL)),
  CONSTRAINT "pharmacy_anomaly_signals_snooze_check" CHECK (
    ("status"='SNOOZED')=("snoozedUntil" IS NOT NULL AND "snoozeReason" IS NOT NULL AND length(btrim("snoozeReason"))>0)),
  CONSTRAINT "pharmacy_anomaly_signals_closed_check" CHECK (("status"='CLOSED')=("closedAt" IS NOT NULL)),
  CONSTRAINT "pharmacy_anomaly_signals_stale_check" CHECK (("status"='STALE')=("markedStaleAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "pharmacy_anomaly_signals_live_dedup_key"
  ON "pharmacy_anomaly_signals"("organizationId","branchId","dedupKey")
  WHERE "status" IN ('OPEN','ACKNOWLEDGED','SNOOZED','STALE');
CREATE INDEX "pharmacy_anomaly_signals_org_branch_status_idx"
  ON "pharmacy_anomaly_signals"("organizationId","branchId","status","computedAt" DESC);
CREATE INDEX "pharmacy_anomaly_signals_org_branch_kind_idx"
  ON "pharmacy_anomaly_signals"("organizationId","branchId","kind","status");

CREATE TABLE "pharmacy_anomaly_signal_events" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "signalId" TEXT NOT NULL,
  "kind" "PharmacyAnomalySignalEventKind" NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT,
  "detail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_anomaly_signal_events_signal_fkey"
    FOREIGN KEY ("organizationId","branchId","signalId") REFERENCES "pharmacy_anomaly_signals"("organizationId","branchId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_anomaly_signal_events_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_anomaly_signal_events_actor_check" CHECK (length(btrim("actorId"))>0),
  CONSTRAINT "pharmacy_anomaly_signal_events_reason_check" CHECK (
    "kind" NOT IN ('ACKNOWLEDGED','SNOOZED') OR ("reason" IS NOT NULL AND length(btrim("reason"))>0))
);
CREATE INDEX "pharmacy_anomaly_signal_events_org_signal_idx"
  ON "pharmacy_anomaly_signal_events"("organizationId","branchId","signalId","createdAt");

CREATE TRIGGER pharmacy_anomaly_signal_events_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_anomaly_signal_events"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_anomaly_signals_no_delete
  BEFORE DELETE ON "pharmacy_anomaly_signals"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_anomaly_signals','pharmacy_anomaly_signal_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_branch_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR ("organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''') AND (NULLIF(current_setting(''app.current_branch_id'',true),'''') IS NULL OR "branchId"=current_setting(''app.current_branch_id'',true)))) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR ("organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''') AND (NULLIF(current_setting(''app.current_branch_id'',true),'''') IS NULL OR "branchId"=current_setting(''app.current_branch_id'',true))))',
      t);
  END LOOP;
END $$;
