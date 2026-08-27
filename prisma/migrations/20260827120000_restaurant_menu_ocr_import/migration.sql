-- R-lane / WHA-194 — OCR menu import: upload -> extraction -> review queue ->
-- confirmed catalog import.
--
-- Three org-scoped tables under FORCE ROW LEVEL SECURITY. Every change is
-- additive: no existing table, column, constraint or policy is touched, so a
-- rollback loses only menu-import drafts.
--
-- Two deliberate integrity decisions, both load-bearing:
--
--  1. `mergeProductId` / `mergeVariantId` are LIVE review targets and carry
--     composite `(organizationId, id)` foreign keys. That is what makes
--     "merge into an existing product" impossible to point at another tenant's
--     catalog even if the application layer were bypassed.
--  2. Every `committed*` column is IDS-ONLY AUDIT EVIDENCE and deliberately has
--     NO foreign key. Evidence of what an import created must survive the later
--     deletion of that product or menu rather than block it — a retained import
--     record must never become a reason a restaurant cannot delete a dish.
--
-- Manual down migration (Prisma deploy has no down-runner):
-- BEGIN;
-- DROP TABLE "restaurant_menu_import_lines";
-- DROP TABLE "restaurant_menu_import_pages";
-- DROP TABLE "restaurant_menu_imports";
-- DROP TYPE "RestaurantMenuImportLineStatus";
-- DROP TYPE "RestaurantMenuImportAdapter";
-- DROP TYPE "RestaurantMenuImportStatus";
-- COMMIT;

-- CreateEnum
CREATE TYPE "RestaurantMenuImportStatus" AS ENUM ('PENDING_EXTRACTION', 'EXTRACTING', 'AWAITING_REVIEW', 'EXTRACTION_FAILED', 'COMMITTED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "RestaurantMenuImportAdapter" AS ENUM ('FIXTURE', 'VISION');

-- CreateEnum
CREATE TYPE "RestaurantMenuImportLineStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'MERGED');

-- CreateTable
CREATE TABLE "restaurant_menu_imports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "status" "RestaurantMenuImportStatus" NOT NULL DEFAULT 'PENDING_EXTRACTION',
    "adapter" "RestaurantMenuImportAdapter" NOT NULL,
    "adapterVersion" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageObjectName" TEXT,
    "sourceDeletedAt" TIMESTAMP(3),
    "defaultCurrency" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "extractionJobId" TEXT,
    "extractionStartedAt" TIMESTAMP(3),
    "extractionCompletedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdById" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3),
    "committedById" TEXT,
    "committedMenuId" TEXT,
    "committedPriceListVersionId" TEXT,
    "discardedAt" TIMESTAMP(3),
    "discardedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_menu_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menu_import_pages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "importId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "warnings" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_menu_import_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menu_import_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "importId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "extractedCategoryName" TEXT,
    "extractedProductName" TEXT,
    "extractedDescription" TEXT,
    "extractedIngredients" TEXT[],
    "extractedPriceAmount" DECIMAL(12,2),
    "extractedCurrency" TEXT,
    "extractedPriceRaw" TEXT,
    "extractedVariants" JSONB NOT NULL DEFAULT '[]',
    "extractedModifiers" JSONB NOT NULL DEFAULT '[]',
    "confidence" JSONB NOT NULL DEFAULT '{}',
    "flags" TEXT[],
    "matchKey" TEXT,
    "reviewStatus" "RestaurantMenuImportLineStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedCategoryName" TEXT,
    "reviewedProductName" TEXT,
    "reviewedDescription" TEXT,
    "reviewedPriceAmount" DECIMAL(12,2),
    "reviewedCurrency" TEXT,
    "reviewNote" TEXT,
    "mergeProductId" TEXT,
    "mergeVariantId" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "committedCategoryId" TEXT,
    "committedProductId" TEXT,
    "committedVariantId" TEXT,
    "committedMenuItemId" TEXT,
    "committedPriceEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_menu_import_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_menu_imports_organizationId_idempotencyKey_key" ON "restaurant_menu_imports"("organizationId", "idempotencyKey");
CREATE INDEX "restaurant_menu_imports_organizationId_idx" ON "restaurant_menu_imports"("organizationId");
CREATE INDEX "restaurant_menu_imports_status_createdAt_idx" ON "restaurant_menu_imports"("status", "createdAt");
CREATE INDEX "restaurant_menu_imports_organizationId_checksum_idx" ON "restaurant_menu_imports"("organizationId", "checksum");

CREATE UNIQUE INDEX "restaurant_menu_import_pages_importId_pageNumber_key" ON "restaurant_menu_import_pages"("importId", "pageNumber");
CREATE INDEX "restaurant_menu_import_pages_organizationId_idx" ON "restaurant_menu_import_pages"("organizationId");

CREATE INDEX "restaurant_menu_import_lines_organizationId_idx" ON "restaurant_menu_import_lines"("organizationId");
CREATE INDEX "restaurant_menu_import_lines_importId_sortOrder_idx" ON "restaurant_menu_import_lines"("importId", "sortOrder");
CREATE INDEX "restaurant_menu_import_lines_importId_reviewStatus_idx" ON "restaurant_menu_import_lines"("importId", "reviewStatus");
CREATE INDEX "restaurant_menu_import_lines_pageId_idx" ON "restaurant_menu_import_lines"("pageId");
CREATE INDEX "restaurant_menu_import_lines_organizationId_matchKey_idx" ON "restaurant_menu_import_lines"("organizationId", "matchKey");

-- AddForeignKey
ALTER TABLE "restaurant_menu_import_pages" ADD CONSTRAINT "restaurant_menu_import_pages_importId_fkey" FOREIGN KEY ("importId") REFERENCES "restaurant_menu_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_menu_import_lines" ADD CONSTRAINT "restaurant_menu_import_lines_importId_fkey" FOREIGN KEY ("importId") REFERENCES "restaurant_menu_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_menu_import_lines" ADD CONSTRAINT "restaurant_menu_import_lines_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "restaurant_menu_import_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-composite keys. The parent uniques back the child FKs; the child FKs
-- carry `organizationId` so a row can never be parented across tenants.
ALTER TABLE "restaurant_menu_imports" ADD CONSTRAINT "restaurant_menu_imports_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_menu_import_pages" ADD CONSTRAINT "restaurant_menu_import_pages_organizationId_id_key" UNIQUE ("organizationId", "id");

ALTER TABLE "restaurant_menu_import_pages" ADD CONSTRAINT "tenant_menu_import_page_importId_fk" FOREIGN KEY ("organizationId", "importId") REFERENCES "restaurant_menu_imports"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menu_import_lines" ADD CONSTRAINT "tenant_menu_import_line_importId_fk" FOREIGN KEY ("organizationId", "importId") REFERENCES "restaurant_menu_imports"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menu_import_lines" ADD CONSTRAINT "tenant_menu_import_line_pageId_fk" FOREIGN KEY ("organizationId", "pageId") REFERENCES "restaurant_menu_import_pages"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- Live merge targets are tenant-checked against the canonical catalog. The
-- committed* evidence columns deliberately get no FK (see the header note).
ALTER TABLE "restaurant_menu_import_lines" ADD CONSTRAINT "tenant_menu_import_line_mergeProductId_fk" FOREIGN KEY ("organizationId", "mergeProductId") REFERENCES "restaurant_products"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menu_import_lines" ADD CONSTRAINT "tenant_menu_import_line_mergeVariantId_fk" FOREIGN KEY ("organizationId", "mergeVariantId") REFERENCES "restaurant_product_variants"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- Value constraints. Uploads are bounded at the application edge too; these are
-- the fail-closed floor, so a bypassed validator still cannot store a 2 GB blob
-- or an 800-page import.
ALTER TABLE "restaurant_menu_imports" ADD CONSTRAINT "restaurant_menu_imports_byteSize_ck" CHECK ("byteSize" > 0 AND "byteSize" <= 26214400);
ALTER TABLE "restaurant_menu_imports" ADD CONSTRAINT "restaurant_menu_imports_pageCount_ck" CHECK ("pageCount" >= 1 AND "pageCount" <= 10);
ALTER TABLE "restaurant_menu_imports" ADD CONSTRAINT "restaurant_menu_imports_values_ck" CHECK (btrim("fileName") <> '' AND btrim("checksum") <> '' AND btrim("idempotencyKey") <> '' AND btrim("createdById") <> '');
ALTER TABLE "restaurant_menu_imports" ADD CONSTRAINT "restaurant_menu_imports_mimeType_ck" CHECK ("mimeType" IN ('image/png', 'image/jpeg', 'image/webp', 'application/pdf'));
-- A committed import must record who committed it and when: the audit trail for
-- "a human approved this" cannot be half-written.
ALTER TABLE "restaurant_menu_imports" ADD CONSTRAINT "restaurant_menu_imports_commit_ck" CHECK (("status" <> 'COMMITTED') OR ("committedAt" IS NOT NULL AND "committedById" IS NOT NULL));
ALTER TABLE "restaurant_menu_import_pages" ADD CONSTRAINT "restaurant_menu_import_pages_pageNumber_ck" CHECK ("pageNumber" >= 1);
ALTER TABLE "restaurant_menu_import_lines" ADD CONSTRAINT "restaurant_menu_import_lines_price_ck" CHECK (("extractedPriceAmount" IS NULL OR "extractedPriceAmount" >= 0) AND ("reviewedPriceAmount" IS NULL OR "reviewedPriceAmount" >= 0));
-- A reviewed line records its reviewer. PENDING lines have no reviewer yet.
ALTER TABLE "restaurant_menu_import_lines" ADD CONSTRAINT "restaurant_menu_import_lines_review_ck" CHECK (("reviewStatus" = 'PENDING') OR ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL));
-- MERGED means "fold into this existing product", so the target is required;
-- every other decision must not carry one.
ALTER TABLE "restaurant_menu_import_lines" ADD CONSTRAINT "restaurant_menu_import_lines_merge_ck" CHECK (("reviewStatus" = 'MERGED') = ("mergeProductId" IS NOT NULL));
ALTER TABLE "restaurant_menu_import_lines" ADD CONSTRAINT "restaurant_menu_import_lines_variant_ck" CHECK ("mergeVariantId" IS NULL OR "mergeProductId" IS NOT NULL);

-- Row level security. FORCE so the table owner is bound by the policy too.
ALTER TABLE "restaurant_menu_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_menu_imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_menu_imports" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_menu_import_pages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_menu_import_pages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_menu_import_pages" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_menu_import_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_menu_import_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_menu_import_lines" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
