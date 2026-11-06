-- DEV-741 — Pharmacy thermal receipt print queue.
--
-- A branch-bound print bridge (one unattended host process, one receipt
-- printer) claims receipt jobs that the server built from a settled sale. The
-- server never dials a printer. Delivery state is honest: TRANSPORT_ACCEPTED
-- means the host transport took the bytes, never that paper came out.
--
-- Additive only: two new tables and one new enum. No existing table, policy or
-- grant changes.

CREATE TYPE "PharmacyPrintJobStatus" AS ENUM ('PENDING', 'FAILED', 'TRANSPORT_ACCEPTED');

-- ── Bridges ─────────────────────────────────────────────────────────────────
CREATE TABLE "pharmacy_print_bridges" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "printerId" TEXT NOT NULL,
  "deviceSecretHash" TEXT NOT NULL,
  "status" "PharmacyDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
  "revokedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "enrolledByActorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pharmacy_print_bridges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_print_bridges_name_check"
    CHECK (length(btrim("name")) BETWEEN 1 AND 80),
  -- Printable, no whitespace or control characters, bounded like the host bridge.
  CONSTRAINT "pharmacy_print_bridges_printer_check"
    CHECK ("printerId" ~ '^[\x21-\x7e]{1,128}$'),
  CONSTRAINT "pharmacy_print_bridges_actor_check"
    CHECK (length(btrim("enrolledByActorId")) > 0),
  CONSTRAINT "pharmacy_print_bridges_revocation_check"
    CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)),
  CONSTRAINT "pharmacy_print_bridges_secret_hash_check"
    CHECK ("deviceSecretHash" ~ '^[0-9a-f]{64}$')
);

-- Globally unique: the hash is the credential's identity.
CREATE UNIQUE INDEX "pharmacy_print_bridges_secret_hash_key"
  ON "pharmacy_print_bridges"("deviceSecretHash");
CREATE INDEX "pharmacy_print_bridges_org_branch_status_idx"
  ON "pharmacy_print_bridges"("organizationId", "branchId", "status");
CREATE UNIQUE INDEX "pharmacy_print_bridges_org_id_key"
  ON "pharmacy_print_bridges"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_print_bridges_org_branch_id_key"
  ON "pharmacy_print_bridges"("organizationId", "branchId", "id");

ALTER TABLE "pharmacy_print_bridges"
  ADD CONSTRAINT "pharmacy_print_bridges_organizationId_branchId_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Jobs ────────────────────────────────────────────────────────────────────
CREATE TABLE "pharmacy_print_jobs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "bridgeId" TEXT NOT NULL,
  "printerId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "receiptNumber" INTEGER NOT NULL,
  "reprint" BOOLEAN NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "document" JSONB NOT NULL,
  "byteCount" INTEGER NOT NULL,
  "paperWidth" INTEGER NOT NULL,
  "status" "PharmacyPrintJobStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "requestedByActorId" TEXT NOT NULL,
  "retriedByActorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pharmacy_print_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_print_jobs_receipt_number_check" CHECK ("receiptNumber" > 0),
  CONSTRAINT "pharmacy_print_jobs_key_check"
    CHECK (length(btrim("idempotencyKey")) BETWEEN 8 AND 260),
  CONSTRAINT "pharmacy_print_jobs_bytes_check" CHECK ("byteCount" BETWEEN 1 AND 1048576),
  CONSTRAINT "pharmacy_print_jobs_paper_width_check" CHECK ("paperWidth" IN (58, 80)),
  CONSTRAINT "pharmacy_print_jobs_attempts_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "pharmacy_print_jobs_actor_check"
    CHECK (length(btrim("requestedByActorId")) > 0),
  CONSTRAINT "pharmacy_print_jobs_failure_code_check"
    CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z_]{1,40}$'),
  -- Each state names exactly its own evidence.
  CONSTRAINT "pharmacy_print_jobs_state_check" CHECK (
    ("status" = 'PENDING' AND "acceptedAt" IS NULL AND "failureCode" IS NULL)
    OR ("status" = 'FAILED' AND "acceptedAt" IS NULL AND "failureCode" IS NOT NULL
        AND "lastAttemptAt" IS NOT NULL)
    OR ("status" = 'TRANSPORT_ACCEPTED' AND "acceptedAt" IS NOT NULL AND "failureCode" IS NULL
        AND "lastAttemptAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "pharmacy_print_jobs_org_id_key"
  ON "pharmacy_print_jobs"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_print_jobs_idempotency_key"
  ON "pharmacy_print_jobs"("organizationId", "branchId", "idempotencyKey");
CREATE INDEX "pharmacy_print_jobs_claim_idx"
  ON "pharmacy_print_jobs"("organizationId", "bridgeId", "status", "queuedAt");
CREATE INDEX "pharmacy_print_jobs_sale_idx"
  ON "pharmacy_print_jobs"("organizationId", "branchId", "saleId");
-- Duplicate-print guard: a sale has at most one ORIGINAL receipt job, whatever
-- the idempotency key. Every further paper copy is an explicit, marked reprint.
CREATE UNIQUE INDEX "pharmacy_print_jobs_one_original_per_sale"
  ON "pharmacy_print_jobs"("organizationId", "branchId", "saleId")
  WHERE "reprint" = false;

ALTER TABLE "pharmacy_print_jobs"
  ADD CONSTRAINT "pharmacy_print_jobs_organizationId_branchId_bridgeId_fkey"
  FOREIGN KEY ("organizationId", "branchId", "bridgeId")
  REFERENCES "pharmacy_print_bridges"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_print_jobs"
  ADD CONSTRAINT "pharmacy_print_jobs_organizationId_branchId_saleId_fkey"
  FOREIGN KEY ("organizationId", "branchId", "saleId")
  REFERENCES "pharmacy_sales"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_print_jobs"
  ADD CONSTRAINT "pharmacy_print_jobs_organizationId_branchId_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Guards ──────────────────────────────────────────────────────────────────
-- A bridge's tenant, branch, printer and enrolling actor are fixed; a revoked
-- bridge stays revoked. Re-pointing a printer is a new enrollment.
CREATE FUNCTION guard_pharmacy_print_bridge_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."organizationId", NEW."branchId", NEW."printerId", NEW."enrolledByActorId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."printerId", OLD."enrolledByActorId", OLD."createdAt") THEN
    RAISE EXCEPTION 'PRINT_BRIDGE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'REVOKED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'PRINT_BRIDGE_REVOKED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pharmacy_print_bridges_update_guard"
  BEFORE UPDATE ON "pharmacy_print_bridges"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_print_bridge_update();
CREATE TRIGGER "pharmacy_print_bridges_no_delete"
  BEFORE DELETE ON "pharmacy_print_bridges"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

-- A job's identity and payload never change. Attempts only rise, and an
-- accepted job is final: nothing may turn transport evidence into a retry.
CREATE FUNCTION guard_pharmacy_print_job_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."organizationId", NEW."branchId", NEW."bridgeId", NEW."printerId", NEW."saleId",
      NEW."receiptNumber", NEW."reprint", NEW."idempotencyKey", NEW."document",
      NEW."byteCount", NEW."paperWidth", NEW."requestedByActorId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."bridgeId", OLD."printerId", OLD."saleId",
      OLD."receiptNumber", OLD."reprint", OLD."idempotencyKey", OLD."document",
      OLD."byteCount", OLD."paperWidth", OLD."requestedByActorId", OLD."createdAt") THEN
    RAISE EXCEPTION 'PRINT_JOB_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW."attemptCount" < OLD."attemptCount" THEN
    RAISE EXCEPTION 'PRINT_JOB_ATTEMPTS_MONOTONIC' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'TRANSPORT_ACCEPTED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'PRINT_JOB_ALREADY_ACCEPTED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pharmacy_print_jobs_update_guard"
  BEFORE UPDATE ON "pharmacy_print_jobs"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_print_job_update();
CREATE TRIGGER "pharmacy_print_jobs_no_delete"
  BEFORE DELETE ON "pharmacy_print_jobs"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

-- ── Row level security ──────────────────────────────────────────────────────
-- FORCE, tenant-only, the same contract as pharmacy_registered_devices. No
-- DELETE policy: rows are kept for reconciliation and audit.
DO $$
DECLARE
  mutable_table text;
BEGIN
  FOREACH mutable_table IN ARRAY ARRAY[
    'pharmacy_print_bridges',
    'pharmacy_print_jobs'
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
END $$;
