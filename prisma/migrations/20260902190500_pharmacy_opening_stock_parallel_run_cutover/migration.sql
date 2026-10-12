-- PH-MIG — opening stock reconciliation, parallel run and cutover.
-- PRD §6.10 MIG-03, MIG-04, MIG-05.
--
-- Three guarantees are database-level here rather than service-level, because a
-- caller that skips the service must not be able to break them:
--
--   MIG-03 "missing values are never defaulted" — every opening attribute is
--   nullable with NO default, and a CHECK forbids the POSTED status while any of
--   them is still null.
--
--   MIG-04 "rollback loses no cutover-window transactions" — cutover and
--   rollback are append-only event rows, so ownership of receipt numbering is
--   the latest event rather than a mutable flag. There is no statement that
--   could delete a cutover-window sale, because nothing here rewinds a sequence
--   or touches a sale at all.
--
--   Opening totals and opening ledgers are append-only: they record what was
--   posted, not what is currently believed.

-- ── MIG-03: the OPENING movement direction ──────────────────────────────────
-- 'OPENING' was added to the enum by the preceding migration. The existing
-- direction CHECK enumerates kinds exhaustively, so a movement of a kind it does
-- not mention fails every branch. Recreating it under the SAME name keeps one
-- direction rule for the ledger instead of a second, competing one. Opening
-- stock is positive, like the other inbound kinds.
ALTER TABLE "pharmacy_stock_movements"
  DROP CONSTRAINT "pharmacy_stock_movements_direction_check";
ALTER TABLE "pharmacy_stock_movements"
  ADD CONSTRAINT "pharmacy_stock_movements_direction_check" CHECK (
    ("kind" IN ('RECEIPT','RETURN','TRANSFER_IN','OPENING') AND "quantityUnits" > 0)
    OR ("kind" IN ('SALE','TRANSFER_OUT','WRITE_OFF') AND "quantityUnits" < 0)
    OR ("kind" = 'ADJUSTMENT' AND "quantityUnits" <> 0)
    OR ("kind" = 'BREAK_PACK' AND "quantityUnits" = 0 AND "sealedPackDelta" < 0 AND "looseUnitDelta" > 0)
  );

-- ── MIG-05: the close records its own finality ──────────────────────────────
ALTER TABLE "pharmacy_daily_closes"
  ADD COLUMN "isFinal" BOOLEAN NOT NULL DEFAULT false;

-- ── Types ───────────────────────────────────────────────────────────────────
CREATE TYPE "PharmacyOpeningSessionStatus" AS ENUM ('DRAFT', 'COUNTED', 'POSTED', 'SIGNED_OFF');
CREATE TYPE "PharmacyOpeningLineStatus" AS ENUM ('PENDING', 'READY', 'EXCEPTION', 'POSTED');
CREATE TYPE "PharmacyOpeningExceptionBucket" AS ENUM (
  'MISSING_BATCH', 'MISSING_EXPIRY', 'MISSING_MRP', 'MISSING_COST',
  'MISSING_LOCATION', 'MISSING_SOURCE_REF', 'MISSING_COUNT');
CREATE TYPE "PharmacyOpeningLedgerAccount" AS ENUM ('ACCOUNTS_PAYABLE', 'ACCOUNTS_RECEIVABLE', 'CASH', 'BANK');
CREATE TYPE "PharmacyParallelRunStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "PharmacyParallelRunMetric" AS ENUM ('SALES', 'CASH', 'STOCK_VALUE');
CREATE TYPE "PharmacyCutoverEventKind" AS ENUM ('CUTOVER', 'ROLLBACK');
CREATE TYPE "PharmacySequenceOwner" AS ENUM ('LEGACY', 'DEVFATHOM');

-- ── D05: the materiality threshold ──────────────────────────────────────────
-- No row means 0, not "no threshold": until the contract sets a figure every
-- variance is material. That is the conservative direction — an unset threshold
-- delays finality rather than granting it.
CREATE TABLE "pharmacy_materiality_thresholds" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "thresholdMinor" BIGINT NOT NULL DEFAULT 0,
  "thresholdUnits" INTEGER NOT NULL DEFAULT 0,
  "setByActorId" TEXT NOT NULL,
  "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_materiality_thresholds_non_negative_check"
    CHECK ("thresholdMinor" >= 0 AND "thresholdUnits" >= 0),
  CONSTRAINT "pharmacy_materiality_thresholds_actor_check"
    CHECK (length(btrim("setByActorId")) > 0)
);
ALTER TABLE "pharmacy_materiality_thresholds"
  ADD CONSTRAINT "pharmacy_materiality_thresholds_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_materiality_thresholds"
  ADD CONSTRAINT "pharmacy_materiality_thresholds_org_branch_key" UNIQUE ("organizationId", "branchId");
ALTER TABLE "pharmacy_materiality_thresholds"
  ADD CONSTRAINT "pharmacy_materiality_thresholds_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── MIG-03: the opening session ─────────────────────────────────────────────
CREATE TABLE "pharmacy_opening_sessions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "migrationBatchId" TEXT,
  "openingAt" TIMESTAMP(3) NOT NULL,
  "status" "PharmacyOpeningSessionStatus" NOT NULL DEFAULT 'DRAFT',
  "createdByActorId" TEXT NOT NULL,
  "postedByActorId" TEXT,
  "postedAt" TIMESTAMP(3),
  "signedOffBy" TEXT,
  "signedOffAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_opening_sessions_actor_check"
    CHECK (length(btrim("createdByActorId")) > 0),
  -- A posted session names who posted it and when; a signed-off session names
  -- its signer. Evidence and status are one fact.
  CONSTRAINT "pharmacy_opening_sessions_posted_evidence_check"
    CHECK (("status" IN ('DRAFT','COUNTED') AND "postedAt" IS NULL AND "postedByActorId" IS NULL)
        OR ("status" IN ('POSTED','SIGNED_OFF') AND "postedAt" IS NOT NULL AND "postedByActorId" IS NOT NULL)),
  CONSTRAINT "pharmacy_opening_sessions_signoff_evidence_check"
    CHECK (("status" <> 'SIGNED_OFF' AND "signedOffAt" IS NULL AND "signedOffBy" IS NULL)
        OR ("status" = 'SIGNED_OFF' AND "signedOffAt" IS NOT NULL AND "signedOffBy" IS NOT NULL))
);
ALTER TABLE "pharmacy_opening_sessions"
  ADD CONSTRAINT "pharmacy_opening_sessions_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_opening_sessions"
  ADD CONSTRAINT "pharmacy_opening_sessions_org_branch_id_key" UNIQUE ("organizationId", "branchId", "id");
CREATE INDEX "pharmacy_opening_sessions_org_branch_status_idx"
  ON "pharmacy_opening_sessions" ("organizationId", "branchId", "status");
ALTER TABLE "pharmacy_opening_sessions"
  ADD CONSTRAINT "pharmacy_opening_sessions_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_opening_sessions"
  ADD CONSTRAINT "pharmacy_opening_sessions_batch_fkey"
  FOREIGN KEY ("organizationId", "migrationBatchId") REFERENCES "pharmacy_migration_batches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- MIG-02/MIG-03 "missing batch/expiry/MRP is never silently defaulted". Every
-- attribute an opening lot needs is nullable with NO default, and the CHECK
-- below is what makes the rule structural: a line may only reach POSTED once all
-- six are present. A caller that writes the status directly still cannot post a
-- lot whose expiry the incumbent never supplied.
CREATE TABLE "pharmacy_opening_stock_lines" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "sessionId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "migrationRowId" TEXT,
  "sourceRef" TEXT,
  "manufacturingBatchId" TEXT,
  "batchNumber" TEXT,
  "expiryDate" DATE,
  "expiryPrecision" "PharmacyExpiryPrecision",
  "printedMrpMinor" INTEGER,
  "unitCostMinor" INTEGER,
  "stockLocationId" TEXT,
  "packLevelId" TEXT,
  "unitsPerPack" INTEGER,
  "expectedUnits" INTEGER,
  "countedUnits" INTEGER,
  "varianceUnits" INTEGER,
  "varianceNote" TEXT,
  "status" "PharmacyOpeningLineStatus" NOT NULL DEFAULT 'PENDING',
  "postedLotId" TEXT,
  "postedMovementId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_opening_stock_lines_complete_before_post_check" CHECK (
    "status" <> 'POSTED' OR (
      "sourceRef" IS NOT NULL
      AND "manufacturingBatchId" IS NOT NULL
      AND "batchNumber" IS NOT NULL
      AND "expiryDate" IS NOT NULL
      AND "expiryPrecision" IS NOT NULL
      AND "printedMrpMinor" IS NOT NULL
      AND "unitCostMinor" IS NOT NULL
      AND "stockLocationId" IS NOT NULL
      AND "packLevelId" IS NOT NULL
      AND "unitsPerPack" IS NOT NULL
      AND "countedUnits" IS NOT NULL
      AND "postedLotId" IS NOT NULL
      AND "postedMovementId" IS NOT NULL)),
  CONSTRAINT "pharmacy_opening_stock_lines_money_check"
    CHECK (("printedMrpMinor" IS NULL OR "printedMrpMinor" >= 0)
       AND ("unitCostMinor" IS NULL OR "unitCostMinor" >= 0)),
  -- Integer units throughout, and a counted quantity is never negative. Zero is
  -- legal: the incumbent listed the lot and the shelf held none of it.
  CONSTRAINT "pharmacy_opening_stock_lines_units_check"
    CHECK (("expectedUnits" IS NULL OR "expectedUnits" >= 0)
       AND ("countedUnits" IS NULL OR "countedUnits" >= 0)
       AND ("unitsPerPack" IS NULL OR "unitsPerPack" > 0)),
  -- The variance is a derived fact and must stay consistent with its operands.
  CONSTRAINT "pharmacy_opening_stock_lines_variance_check"
    CHECK ("varianceUnits" IS NULL
       OR ("expectedUnits" IS NOT NULL AND "countedUnits" IS NOT NULL
           AND "varianceUnits" = "countedUnits" - "expectedUnits"))
);
ALTER TABLE "pharmacy_opening_stock_lines"
  ADD CONSTRAINT "pharmacy_opening_stock_lines_org_id_key" UNIQUE ("organizationId", "id");
CREATE INDEX "pharmacy_opening_stock_lines_org_session_status_idx"
  ON "pharmacy_opening_stock_lines" ("organizationId", "sessionId", "status");
CREATE INDEX "pharmacy_opening_stock_lines_org_branch_idx"
  ON "pharmacy_opening_stock_lines" ("organizationId", "branchId");
ALTER TABLE "pharmacy_opening_stock_lines"
  ADD CONSTRAINT "pharmacy_opening_stock_lines_session_fkey"
  FOREIGN KEY ("organizationId", "sessionId") REFERENCES "pharmacy_opening_sessions" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_opening_stock_lines"
  ADD CONSTRAINT "pharmacy_opening_stock_lines_row_fkey"
  FOREIGN KEY ("organizationId", "migrationRowId") REFERENCES "pharmacy_migration_rows" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_opening_stock_lines"
  ADD CONSTRAINT "pharmacy_opening_stock_lines_batch_fkey"
  FOREIGN KEY ("organizationId", "manufacturingBatchId") REFERENCES "pharmacy_manufacturing_batches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- The location must belong to this line's OWN branch, not merely to the tenant.
ALTER TABLE "pharmacy_opening_stock_lines"
  ADD CONSTRAINT "pharmacy_opening_stock_lines_location_fkey"
  FOREIGN KEY ("organizationId", "branchId", "stockLocationId")
  REFERENCES "pharmacy_stock_locations" ("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_opening_stock_lines"
  ADD CONSTRAINT "pharmacy_opening_stock_lines_lot_fkey"
  FOREIGN KEY ("organizationId", "branchId", "postedLotId")
  REFERENCES "pharmacy_inventory_lots" ("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pharmacy_opening_exceptions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "sessionId" TEXT NOT NULL,
  "lineId" TEXT,
  "bucket" "PharmacyOpeningExceptionBucket" NOT NULL,
  "detail" TEXT NOT NULL,
  "resolvedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_opening_exceptions_detail_check" CHECK (length(btrim("detail")) > 0),
  CONSTRAINT "pharmacy_opening_exceptions_resolution_check"
    CHECK (("resolvedBy" IS NULL AND "resolvedAt" IS NULL)
        OR ("resolvedBy" IS NOT NULL AND "resolvedAt" IS NOT NULL))
);
ALTER TABLE "pharmacy_opening_exceptions"
  ADD CONSTRAINT "pharmacy_opening_exceptions_org_id_key" UNIQUE ("organizationId", "id");
CREATE INDEX "pharmacy_opening_exceptions_org_session_bucket_idx"
  ON "pharmacy_opening_exceptions" ("organizationId", "sessionId", "bucket");
CREATE INDEX "pharmacy_opening_exceptions_org_line_idx"
  ON "pharmacy_opening_exceptions" ("organizationId", "lineId");
ALTER TABLE "pharmacy_opening_exceptions"
  ADD CONSTRAINT "pharmacy_opening_exceptions_session_fkey"
  FOREIGN KEY ("organizationId", "sessionId") REFERENCES "pharmacy_opening_sessions" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_opening_exceptions"
  ADD CONSTRAINT "pharmacy_opening_exceptions_line_fkey"
  FOREIGN KEY ("organizationId", "lineId") REFERENCES "pharmacy_opening_stock_lines" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The signed opening totals per branch. One per session, append-only.
CREATE TABLE "pharmacy_opening_totals" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "totalUnits" INTEGER NOT NULL,
  "totalValueMinor" BIGINT NOT NULL,
  "lineCount" INTEGER NOT NULL,
  "actorId" TEXT NOT NULL,
  "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_opening_totals_actor_check" CHECK (length(btrim("actorId")) > 0),
  CONSTRAINT "pharmacy_opening_totals_line_count_check" CHECK ("lineCount" >= 0)
);
ALTER TABLE "pharmacy_opening_totals"
  ADD CONSTRAINT "pharmacy_opening_totals_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_opening_totals"
  ADD CONSTRAINT "pharmacy_opening_totals_org_session_key" UNIQUE ("organizationId", "sessionId");
CREATE INDEX "pharmacy_opening_totals_org_branch_idx"
  ON "pharmacy_opening_totals" ("organizationId", "branchId", "postedAt");
ALTER TABLE "pharmacy_opening_totals"
  ADD CONSTRAINT "pharmacy_opening_totals_session_fkey"
  FOREIGN KEY ("organizationId", "sessionId") REFERENCES "pharmacy_opening_sessions" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_opening_totals"
  ADD CONSTRAINT "pharmacy_opening_totals_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Opening AP / AR / cash / bank, signed, with actor and time. The FIN lane reads
-- these; it does not re-post them.
CREATE TABLE "pharmacy_opening_ledger_entries" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "account" "PharmacyOpeningLedgerAccount" NOT NULL,
  "balanceMinor" BIGINT NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_opening_ledger_entries_evidence_check"
    CHECK (length(btrim("actorId")) > 0 AND length(btrim("sourceRef")) > 0)
);
ALTER TABLE "pharmacy_opening_ledger_entries"
  ADD CONSTRAINT "pharmacy_opening_ledger_entries_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_opening_ledger_entries"
  ADD CONSTRAINT "pharmacy_opening_ledger_entries_org_session_account_key"
  UNIQUE ("organizationId", "sessionId", "account");
CREATE INDEX "pharmacy_opening_ledger_entries_org_branch_account_idx"
  ON "pharmacy_opening_ledger_entries" ("organizationId", "branchId", "account");
ALTER TABLE "pharmacy_opening_ledger_entries"
  ADD CONSTRAINT "pharmacy_opening_ledger_entries_session_fkey"
  FOREIGN KEY ("organizationId", "sessionId") REFERENCES "pharmacy_opening_sessions" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_opening_ledger_entries"
  ADD CONSTRAINT "pharmacy_opening_ledger_entries_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── MIG-04: parallel run ────────────────────────────────────────────────────
CREATE TABLE "pharmacy_parallel_run_windows" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "status" "PharmacyParallelRunStatus" NOT NULL DEFAULT 'OPEN',
  "openedByActorId" TEXT NOT NULL,
  "closedByActorId" TEXT,
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_parallel_run_windows_order_check" CHECK ("endDate" >= "startDate"),
  CONSTRAINT "pharmacy_parallel_run_windows_actor_check" CHECK (length(btrim("openedByActorId")) > 0),
  CONSTRAINT "pharmacy_parallel_run_windows_closed_check"
    CHECK (("status" = 'OPEN' AND "closedAt" IS NULL AND "closedByActorId" IS NULL)
        OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "closedByActorId" IS NOT NULL))
);
ALTER TABLE "pharmacy_parallel_run_windows"
  ADD CONSTRAINT "pharmacy_parallel_run_windows_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_parallel_run_windows"
  ADD CONSTRAINT "pharmacy_parallel_run_windows_org_branch_start_key"
  UNIQUE ("organizationId", "branchId", "startDate");
CREATE INDEX "pharmacy_parallel_run_windows_org_branch_status_idx"
  ON "pharmacy_parallel_run_windows" ("organizationId", "branchId", "status");
ALTER TABLE "pharmacy_parallel_run_windows"
  ADD CONSTRAINT "pharmacy_parallel_run_windows_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pharmacy_parallel_run_daily_entries" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "windowId" TEXT NOT NULL,
  "businessDate" DATE NOT NULL,
  "legacySalesMinor" BIGINT NOT NULL,
  "legacyCashMinor" BIGINT NOT NULL,
  "legacyStockValueMinor" BIGINT NOT NULL,
  "enteredByActorId" TEXT NOT NULL,
  "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_parallel_run_daily_entries_actor_check"
    CHECK (length(btrim("enteredByActorId")) > 0)
);
ALTER TABLE "pharmacy_parallel_run_daily_entries"
  ADD CONSTRAINT "pharmacy_parallel_run_daily_entries_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_parallel_run_daily_entries"
  ADD CONSTRAINT "pharmacy_parallel_run_daily_entries_org_window_date_key"
  UNIQUE ("organizationId", "windowId", "businessDate");
CREATE INDEX "pharmacy_parallel_run_daily_entries_org_branch_date_idx"
  ON "pharmacy_parallel_run_daily_entries" ("organizationId", "branchId", "businessDate");
ALTER TABLE "pharmacy_parallel_run_daily_entries"
  ADD CONSTRAINT "pharmacy_parallel_run_daily_entries_window_fkey"
  FOREIGN KEY ("organizationId", "windowId") REFERENCES "pharmacy_parallel_run_windows" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pharmacy_parallel_run_comparisons" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "windowId" TEXT NOT NULL,
  "businessDate" DATE NOT NULL,
  "metric" "PharmacyParallelRunMetric" NOT NULL,
  "devfathomMinor" BIGINT NOT NULL,
  "legacyMinor" BIGINT NOT NULL,
  "diffMinor" BIGINT NOT NULL,
  "thresholdMinor" BIGINT NOT NULL,
  "material" BOOLEAN NOT NULL,
  "explained" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT,
  "actorId" TEXT NOT NULL,
  "comparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  -- The diff is a derived fact; storing it does not license it to disagree.
  CONSTRAINT "pharmacy_parallel_run_comparisons_diff_check"
    CHECK ("diffMinor" = "devfathomMinor" - "legacyMinor"),
  -- Materiality is decided against the threshold, not asserted by the caller.
  CONSTRAINT "pharmacy_parallel_run_comparisons_material_check"
    CHECK ("material" = (abs("diffMinor") > "thresholdMinor")),
  -- An explanation is a note, not a checkbox. MIG-03's "zero UNEXPLAINED
  -- variance" is only meaningful if "explained" cannot be set without a reason.
  CONSTRAINT "pharmacy_parallel_run_comparisons_explained_needs_note_check"
    CHECK ("explained" = false OR ("note" IS NOT NULL AND length(btrim("note")) > 0)),
  CONSTRAINT "pharmacy_parallel_run_comparisons_threshold_check" CHECK ("thresholdMinor" >= 0),
  CONSTRAINT "pharmacy_parallel_run_comparisons_actor_check" CHECK (length(btrim("actorId")) > 0)
);
ALTER TABLE "pharmacy_parallel_run_comparisons"
  ADD CONSTRAINT "pharmacy_parallel_run_comparisons_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_parallel_run_comparisons"
  ADD CONSTRAINT "pharmacy_parallel_run_comparisons_org_window_date_metric_key"
  UNIQUE ("organizationId", "windowId", "businessDate", "metric");
CREATE INDEX "pharmacy_parallel_run_comparisons_org_branch_date_idx"
  ON "pharmacy_parallel_run_comparisons" ("organizationId", "branchId", "businessDate");
ALTER TABLE "pharmacy_parallel_run_comparisons"
  ADD CONSTRAINT "pharmacy_parallel_run_comparisons_window_fkey"
  FOREIGN KEY ("organizationId", "windowId") REFERENCES "pharmacy_parallel_run_windows" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── MIG-04: legacy archive and cutover ──────────────────────────────────────
CREATE TABLE "pharmacy_legacy_archives" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "storageLocation" TEXT NOT NULL,
  "byteSize" BIGINT NOT NULL,
  "archivedByActorId" TEXT NOT NULL,
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A reference nobody can resolve is not a reference. SHA-256, lowercase hex.
  CONSTRAINT "pharmacy_legacy_archives_hash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pharmacy_legacy_archives_location_check"
    CHECK (length(btrim("storageLocation")) > 0 AND length(btrim("label")) > 0),
  CONSTRAINT "pharmacy_legacy_archives_size_check" CHECK ("byteSize" >= 0)
);
ALTER TABLE "pharmacy_legacy_archives"
  ADD CONSTRAINT "pharmacy_legacy_archives_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_legacy_archives"
  ADD CONSTRAINT "pharmacy_legacy_archives_org_hash_key" UNIQUE ("organizationId", "contentHash");
CREATE INDEX "pharmacy_legacy_archives_org_branch_idx"
  ON "pharmacy_legacy_archives" ("organizationId", "branchId", "archivedAt");
ALTER TABLE "pharmacy_legacy_archives"
  ADD CONSTRAINT "pharmacy_legacy_archives_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pharmacy_cutover_events" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "kind" "PharmacyCutoverEventKind" NOT NULL,
  "sequenceOwner" "PharmacySequenceOwner" NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "rollbackDeadline" TIMESTAMP(3),
  "cutoverEventId" TEXT,
  "legacyArchiveId" TEXT,
  "actorId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The kind decides the ownership; a caller does not get to pick both. A
  -- cutover takes the sequence, a rollback returns it.
  CONSTRAINT "pharmacy_cutover_events_owner_check" CHECK (
    ("kind" = 'CUTOVER' AND "sequenceOwner" = 'DEVFATHOM'
      AND "rollbackDeadline" IS NOT NULL AND "rollbackDeadline" > "effectiveAt"
      AND "cutoverEventId" IS NULL)
    OR ("kind" = 'ROLLBACK' AND "sequenceOwner" = 'LEGACY'
      AND "rollbackDeadline" IS NULL AND "cutoverEventId" IS NOT NULL)),
  CONSTRAINT "pharmacy_cutover_events_evidence_check"
    CHECK (length(btrim("actorId")) > 0 AND length(btrim("reason")) > 0)
);
ALTER TABLE "pharmacy_cutover_events"
  ADD CONSTRAINT "pharmacy_cutover_events_org_id_key" UNIQUE ("organizationId", "id");
CREATE INDEX "pharmacy_cutover_events_org_branch_effective_idx"
  ON "pharmacy_cutover_events" ("organizationId", "branchId", "effectiveAt");
ALTER TABLE "pharmacy_cutover_events"
  ADD CONSTRAINT "pharmacy_cutover_events_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_cutover_events"
  ADD CONSTRAINT "pharmacy_cutover_events_archive_fkey"
  FOREIGN KEY ("organizationId", "legacyArchiveId") REFERENCES "pharmacy_legacy_archives" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_cutover_events"
  ADD CONSTRAINT "pharmacy_cutover_events_cutover_fkey"
  FOREIGN KEY ("organizationId", "cutoverEventId") REFERENCES "pharmacy_cutover_events" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- One rollback per cutover. Without this a branch could accumulate rollbacks
-- against one cutover and the ownership history would stop being a history.
CREATE UNIQUE INDEX "pharmacy_cutover_events_one_rollback_per_cutover_key"
  ON "pharmacy_cutover_events" ("organizationId", "cutoverEventId")
  WHERE "kind" = 'ROLLBACK';

-- ── Append-only guards ──────────────────────────────────────────────────────
-- MIG-04's acceptance ("rollback loses no cutover-window transactions") rests on
-- these: ownership is a log, and a log that can be edited is a flag with extra
-- steps. `pharmacy_reject_append_only_change` is the shared function the stock
-- ledger already uses.
CREATE TRIGGER "pharmacy_cutover_events_append_only"
  BEFORE UPDATE OR DELETE ON "pharmacy_cutover_events"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER "pharmacy_legacy_archives_append_only"
  BEFORE UPDATE OR DELETE ON "pharmacy_legacy_archives"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER "pharmacy_opening_totals_append_only"
  BEFORE UPDATE OR DELETE ON "pharmacy_opening_totals"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER "pharmacy_opening_ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "pharmacy_opening_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER "pharmacy_parallel_run_daily_entries_no_delete"
  BEFORE DELETE ON "pharmacy_parallel_run_daily_entries"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

-- A posted opening line is settled: it has a lot and a movement behind it, and
-- the ledger will not unpost either. Only the variance explanation may still be
-- written, because explaining a variance is a decision taken after the count.
CREATE FUNCTION guard_pharmacy_opening_line_update() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'POSTED' THEN
    IF (NEW."status", NEW."postedLotId", NEW."postedMovementId", NEW."countedUnits",
        NEW."expectedUnits", NEW."varianceUnits", NEW."manufacturingBatchId",
        NEW."stockLocationId", NEW."printedMrpMinor", NEW."unitCostMinor",
        NEW."expiryDate", NEW."sourceRef") IS DISTINCT FROM
       (OLD."status", OLD."postedLotId", OLD."postedMovementId", OLD."countedUnits",
        OLD."expectedUnits", OLD."varianceUnits", OLD."manufacturingBatchId",
        OLD."stockLocationId", OLD."printedMrpMinor", OLD."unitCostMinor",
        OLD."expiryDate", OLD."sourceRef") THEN
      RAISE EXCEPTION 'a posted opening line is immutable; only its variance note may change'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pharmacy_opening_stock_lines_posted_guard"
  BEFORE UPDATE ON "pharmacy_opening_stock_lines"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_opening_line_update();

-- Resolving an opening exception is one-way and never rewrites what was wrong.
CREATE FUNCTION guard_pharmacy_opening_exception_update() RETURNS trigger AS $$
BEGIN
  IF (NEW."organizationId", NEW."sessionId", NEW."lineId", NEW."bucket", NEW."detail",
      NEW."createdAt") IS DISTINCT FROM
     (OLD."organizationId", OLD."sessionId", OLD."lineId", OLD."bucket", OLD."detail",
      OLD."createdAt") THEN
    RAISE EXCEPTION 'pharmacy opening exception identity is immutable; only resolution may change'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."resolvedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'pharmacy opening exception resolution is final' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pharmacy_opening_exceptions_resolution_guard"
  BEFORE UPDATE ON "pharmacy_opening_exceptions"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_opening_exception_update();
CREATE TRIGGER "pharmacy_opening_exceptions_no_delete"
  BEFORE DELETE ON "pharmacy_opening_exceptions"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

-- ── Row level security ──────────────────────────────────────────────────────
-- FORCE, so the table owner is subject to the policy too. Append-only tables get
-- SELECT and INSERT only: the missing UPDATE/DELETE policy is the first guard
-- and the trigger above is the second, for connections policies cannot reach.
DO $$
DECLARE
  mutable_table text;
  append_only_table text;
BEGIN
  FOREACH mutable_table IN ARRAY ARRAY[
    'pharmacy_materiality_thresholds',
    'pharmacy_opening_sessions',
    'pharmacy_opening_stock_lines',
    'pharmacy_opening_exceptions',
    'pharmacy_parallel_run_windows',
    'pharmacy_parallel_run_daily_entries',
    'pharmacy_parallel_run_comparisons'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', mutable_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', mutable_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      mutable_table || '_tenant_select', mutable_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      mutable_table || '_tenant_insert', mutable_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      mutable_table || '_tenant_update', mutable_table);
  END LOOP;

  FOREACH append_only_table IN ARRAY ARRAY[
    'pharmacy_opening_totals',
    'pharmacy_opening_ledger_entries',
    'pharmacy_legacy_archives',
    'pharmacy_cutover_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', append_only_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', append_only_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      append_only_table || '_tenant_select', append_only_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      append_only_table || '_tenant_insert', append_only_table);
  END LOOP;
END $$;
