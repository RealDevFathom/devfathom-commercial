-- CAM-2 — vertical-neutral camera registry and counter evidence binding.
--
-- Additive: the restaurant_camera_* tables and their data are untouched, so the
-- restaurant camera surface keeps reading exactly what it read before. The new
-- tables mirror them without a vertical prefix, add the composite (tenant, id)
-- foreign keys the restaurant tables never had, and add camera_evidence: one
-- still bound to one money event (tender, refund, daily close).
--
-- The two PlatformJobType values are added but not used in this migration, so
-- ALTER TYPE ... ADD VALUE is safe inside the migration transaction.

-- CreateEnum
CREATE TYPE "CameraEvidenceSubject" AS ENUM ('PHARMACY_TENDER', 'PHARMACY_REFUND', 'PHARMACY_DAILY_CLOSE');

-- CreateEnum
CREATE TYPE "CameraEvidenceStatus" AS ENUM ('PENDING', 'CAPTURED', 'FAILED', 'PURGED');

-- AlterEnum
ALTER TYPE "PlatformJobType" ADD VALUE 'pharmacy.camera.snapshot.v1';
ALTER TYPE "PlatformJobType" ADD VALUE 'camera.evidence.retention.v1';

-- CreateTable
CREATE TABLE "camera_gateways" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gatewaySecretHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "baseUrl" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "camera_gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "camera_credentials" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "sealedValue" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "camera_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cameras" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "gatewayId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "counterEvidence" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cameras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "camera_stream_grants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "cameraId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "camera_stream_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "camera_evidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "subjectKind" "CameraEvidenceSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "saleId" TEXT,
    "cameraId" TEXT NOT NULL,
    "status" "CameraEvidenceStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT,
    "byteLength" INTEGER,
    "failureReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "camera_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "camera_gateways_gatewaySecretHash_key" ON "camera_gateways"("gatewaySecretHash");

-- CreateIndex
CREATE INDEX "camera_gateways_organizationId_branchId_idx" ON "camera_gateways"("organizationId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "camera_gateways_organizationId_id_key" ON "camera_gateways"("organizationId", "id");

-- CreateIndex
CREATE INDEX "camera_credentials_organizationId_idx" ON "camera_credentials"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "camera_credentials_organizationId_id_key" ON "camera_credentials"("organizationId", "id");

-- CreateIndex
CREATE INDEX "cameras_organizationId_branchId_idx" ON "cameras"("organizationId", "branchId");

-- CreateIndex
CREATE INDEX "cameras_organizationId_gatewayId_idx" ON "cameras"("organizationId", "gatewayId");

-- CreateIndex
CREATE UNIQUE INDEX "cameras_organizationId_id_key" ON "cameras"("organizationId", "id");

-- CreateIndex
CREATE INDEX "camera_stream_grants_organizationId_cameraId_viewerId_idx" ON "camera_stream_grants"("organizationId", "cameraId", "viewerId");

-- CreateIndex
CREATE INDEX "camera_stream_grants_expiresAt_idx" ON "camera_stream_grants"("expiresAt");

-- CreateIndex
CREATE INDEX "camera_evidence_organizationId_saleId_idx" ON "camera_evidence"("organizationId", "saleId");

-- CreateIndex
CREATE INDEX "camera_evidence_organizationId_branchId_subjectKind_idx" ON "camera_evidence"("organizationId", "branchId", "subjectKind");

-- CreateIndex
CREATE INDEX "camera_evidence_status_requestedAt_idx" ON "camera_evidence"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "camera_evidence_status_capturedAt_idx" ON "camera_evidence"("status", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "camera_evidence_organizationId_subjectKind_subjectId_key" ON "camera_evidence"("organizationId", "subjectKind", "subjectId");

-- AddForeignKey
ALTER TABLE "cameras" ADD CONSTRAINT "cameras_organizationId_gatewayId_fkey" FOREIGN KEY ("organizationId", "gatewayId") REFERENCES "camera_gateways"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cameras" ADD CONSTRAINT "cameras_organizationId_credentialId_fkey" FOREIGN KEY ("organizationId", "credentialId") REFERENCES "camera_credentials"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "camera_stream_grants" ADD CONSTRAINT "camera_stream_grants_organizationId_cameraId_fkey" FOREIGN KEY ("organizationId", "cameraId") REFERENCES "cameras"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "camera_evidence" ADD CONSTRAINT "camera_evidence_organizationId_cameraId_fkey" FOREIGN KEY ("organizationId", "cameraId") REFERENCES "cameras"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity the Prisma schema cannot express.
ALTER TABLE "camera_gateways"
  ADD CONSTRAINT "camera_gateways_retention_days_check" CHECK ("retentionDays" BETWEEN 1 AND 3650),
  ADD CONSTRAINT "camera_gateways_status_check" CHECK ("status" IN ('ACTIVE', 'REVOKED'));

ALTER TABLE "camera_evidence"
  ADD CONSTRAINT "camera_evidence_sale_binding_check"
    CHECK (("subjectKind" = 'PHARMACY_DAILY_CLOSE') = ("saleId" IS NULL)),
  ADD CONSTRAINT "camera_evidence_state_check" CHECK (
       ("status" = 'PENDING'  AND "storageKey" IS NULL     AND "capturedAt" IS NULL     AND "purgedAt" IS NULL)
    OR ("status" = 'CAPTURED' AND "storageKey" IS NOT NULL AND "capturedAt" IS NOT NULL AND "byteLength" > 0 AND "purgedAt" IS NULL)
    OR ("status" = 'FAILED'   AND "storageKey" IS NULL     AND "failureReason" IS NOT NULL AND "purgedAt" IS NULL)
    OR ("status" = 'PURGED'   AND "storageKey" IS NULL     AND "capturedAt" IS NOT NULL AND "purgedAt" IS NOT NULL)
  );

-- Evidence is only useful if it cannot be re-pointed or quietly rewritten. The
-- binding columns are immutable; status moves only PENDING -> CAPTURED | FAILED
-- and CAPTURED -> PURGED (retention clears the still, never the row). A row is
-- deleted only with its tenant: the sanctioned purge names the organization in
-- "app.purging_organization_id", exactly as for pharmacy onboarding events.
CREATE FUNCTION camera_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId" THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'camera evidence is retained; retention clears the still, not the row'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."subjectKind" IS DISTINCT FROM OLD."subjectKind"
     OR NEW."subjectId" IS DISTINCT FROM OLD."subjectId"
     OR NEW."saleId" IS DISTINCT FROM OLD."saleId"
     OR NEW."cameraId" IS DISTINCT FROM OLD."cameraId"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt" THEN
    RAISE EXCEPTION 'camera evidence binding is immutable' USING ERRCODE = '23514';
  END IF;

  IF NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('CAPTURED', 'FAILED'))
    OR (OLD."status" = 'CAPTURED' AND NEW."status" = 'PURGED'
        AND NEW."capturedAt" = OLD."capturedAt"
        AND NEW."byteLength" IS NOT DISTINCT FROM OLD."byteLength")
  ) THEN
    RAISE EXCEPTION 'camera evidence cannot move from % to %', OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER camera_evidence_guard BEFORE UPDATE OR DELETE ON "camera_evidence"
  FOR EACH ROW EXECUTE FUNCTION camera_evidence_guard();

DO $$ DECLARE camera_table TEXT; BEGIN
  FOREACH camera_table IN ARRAY ARRAY['camera_gateways','camera_credentials','cameras','camera_stream_grants','camera_evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', camera_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', camera_table);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', camera_table);
  END LOOP;
END $$;
