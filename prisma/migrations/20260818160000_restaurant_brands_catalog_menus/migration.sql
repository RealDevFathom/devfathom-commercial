-- M3-L1 — Brands, canonical catalog, recipes/BOM, effective-dated pricing,
-- brand-owned menus and branch-menu publications for the Restaurant vertical
-- (restaurant/m3).
--
-- Additive and org-scoped. Every new table carries a bare, RLS-guarded
-- organizationId (defaulting from the transaction-local setting so an INSERT
-- cannot omit or forge it) and gets forced org-level RLS with the exact clause
-- used by 20260728092000_row_level_security / M1-L1 / M2-L1 (including the
-- app.is_platform_admin control-plane escape). Cross-tenant-safe composite
-- foreign keys (matching 20260728091000_tenant_composite_integrity and the M1/M2
-- precedent) make a cross-organization reference impossible even inside the
-- platform scope.
--
-- Binding design constraints realised here:
--   C1  Forced org RLS on ALL 28 new tables.
--   C2  Structural shadow-copy prevention: no canonical table carries a branchId;
--       branch linkage lives only on restaurant_branch_menu_publications and its
--       owned window/exception/override rows. Override rows carry only an
--       availability flag and a nullable price override — never content columns.
--   C3  Versioned records are immutable once ACTIVE: a partial unique index keeps
--       at most one ACTIVE recipe version per recipe; the immutability/transition
--       primitives live in src/lib/restaurant/effective-dating.ts.
--   C4  All monetary columns are DECIMAL; no floating point in catalog pricing.
--   C5  Availability windows store branch-local wall-clock minutes plus a
--       day-of-week set; a CHECK bounds minutes to a single day. Exceptions store
--       a branch-local calendar DATE. Channel is an additive enum (D06 seam).
--   C6  A partial unique index enforces exactly one default RestaurantBrand per
--       organization; the default is ensured lazily by the catalog server (no
--       onboarding edit, no SQL backfill).
--
-- The CREATE TABLE / index / single-column FK section below is the exact output
-- of `prisma migrate diff` for these models; the security section that follows is
-- hand-authored because it uses migration-only constructs (deferred composite
-- tenant FKs, (organizationId, id) uniques, partial/expression unique indexes,
-- CHECKs, forced RLS) that Prisma cannot express, so an auto-generated diff would
-- try to DROP them as phantom drift.

-- CreateEnum
CREATE TYPE "RestaurantBrandStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RestaurantProductType" AS ENUM ('ITEM', 'COMBO');

-- CreateEnum
CREATE TYPE "RestaurantProductStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RestaurantVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RestaurantBranchMenuPublicationStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "RestaurantOrderChannel" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY');

-- CreateTable
CREATE TABLE "restaurant_brands" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "status" "RestaurantBrandStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_categories" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_products" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "categoryId" TEXT,
    "type" "RestaurantProductType" NOT NULL DEFAULT 'ITEM',
    "status" "RestaurantProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "description" TEXT,
    "descriptionLocalized" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_product_variants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_modifier_groups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_modifier_options" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "modifierGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "priceDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_modifier_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_product_modifier_groups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "productId" TEXT NOT NULL,
    "modifierGroupId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_product_modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_combo_component_groups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "comboProductId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "minChoose" INTEGER NOT NULL DEFAULT 1,
    "maxChoose" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_combo_component_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_combo_component_options" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "componentGroupId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "priceDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_combo_component_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_units" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "abbreviation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_unit_conversions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "fromUnitId" TEXT NOT NULL,
    "toUnitId" TEXT NOT NULL,
    "factor" DECIMAL(18,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_unit_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_allergens" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_allergens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_product_allergens" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "productId" TEXT NOT NULL,
    "allergenId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_product_allergens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_ingredient_allergens" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "ingredientId" TEXT NOT NULL,
    "allergenId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_ingredient_allergens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_ingredients" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "baseUnitId" TEXT NOT NULL,
    "referenceCost" DECIMAL(12,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_recipes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_recipe_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "recipeId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "RestaurantVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "yieldQuantity" DECIMAL(12,3),
    "yieldUnitId" TEXT,
    "portionCount" INTEGER,
    "notes" TEXT,
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_recipe_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_recipe_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "recipeVersionId" TEXT NOT NULL,
    "ingredientId" TEXT,
    "subRecipeId" TEXT,
    "quantity" DECIMAL(12,4) NOT NULL,
    "unitId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_recipe_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_price_lists" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_price_list_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "priceListId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "status" "RestaurantVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_price_list_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_price_list_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "priceListVersionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_price_list_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menus" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menu_sections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "menuId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameLocalized" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_menu_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menu_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "sectionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "displayName" TEXT,
    "nameLocalized" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_branch_menu_publications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "priceListId" TEXT,
    "status" "RestaurantBranchMenuPublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "channels" "RestaurantOrderChannel"[] DEFAULT ARRAY[]::"RestaurantOrderChannel"[],
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_branch_menu_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menu_availability_windows" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "publicationId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "label" TEXT,
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "startMinutes" INTEGER NOT NULL,
    "endMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_menu_availability_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menu_availability_exceptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "publicationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_menu_availability_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_branch_menu_item_overrides" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "publicationId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "priceOverride" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_branch_menu_item_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_brands_organizationId_idx" ON "restaurant_brands"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_categories_organizationId_idx" ON "restaurant_categories"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_categories_parentId_idx" ON "restaurant_categories"("parentId");

-- CreateIndex
CREATE INDEX "restaurant_products_organizationId_idx" ON "restaurant_products"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_products_categoryId_idx" ON "restaurant_products"("categoryId");

-- CreateIndex
CREATE INDEX "restaurant_products_type_idx" ON "restaurant_products"("type");

-- CreateIndex
CREATE INDEX "restaurant_products_status_idx" ON "restaurant_products"("status");

-- CreateIndex
CREATE INDEX "restaurant_product_variants_organizationId_idx" ON "restaurant_product_variants"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_product_variants_productId_idx" ON "restaurant_product_variants"("productId");

-- CreateIndex
CREATE INDEX "restaurant_modifier_groups_organizationId_idx" ON "restaurant_modifier_groups"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_modifier_options_organizationId_idx" ON "restaurant_modifier_options"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_modifier_options_modifierGroupId_idx" ON "restaurant_modifier_options"("modifierGroupId");

-- CreateIndex
CREATE INDEX "restaurant_product_modifier_groups_organizationId_idx" ON "restaurant_product_modifier_groups"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_product_modifier_groups_modifierGroupId_idx" ON "restaurant_product_modifier_groups"("modifierGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_product_modifier_groups_productId_modifierGroupI_key" ON "restaurant_product_modifier_groups"("productId", "modifierGroupId");

-- CreateIndex
CREATE INDEX "restaurant_combo_component_groups_organizationId_idx" ON "restaurant_combo_component_groups"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_combo_component_groups_comboProductId_idx" ON "restaurant_combo_component_groups"("comboProductId");

-- CreateIndex
CREATE INDEX "restaurant_combo_component_options_organizationId_idx" ON "restaurant_combo_component_options"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_combo_component_options_componentGroupId_idx" ON "restaurant_combo_component_options"("componentGroupId");

-- CreateIndex
CREATE INDEX "restaurant_combo_component_options_productId_idx" ON "restaurant_combo_component_options"("productId");

-- CreateIndex
CREATE INDEX "restaurant_units_organizationId_idx" ON "restaurant_units"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_unit_conversions_organizationId_idx" ON "restaurant_unit_conversions"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_unit_conversions_toUnitId_idx" ON "restaurant_unit_conversions"("toUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_unit_conversions_fromUnitId_toUnitId_key" ON "restaurant_unit_conversions"("fromUnitId", "toUnitId");

-- CreateIndex
CREATE INDEX "restaurant_allergens_organizationId_idx" ON "restaurant_allergens"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_product_allergens_organizationId_idx" ON "restaurant_product_allergens"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_product_allergens_allergenId_idx" ON "restaurant_product_allergens"("allergenId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_product_allergens_productId_allergenId_key" ON "restaurant_product_allergens"("productId", "allergenId");

-- CreateIndex
CREATE INDEX "restaurant_ingredient_allergens_organizationId_idx" ON "restaurant_ingredient_allergens"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_ingredient_allergens_allergenId_idx" ON "restaurant_ingredient_allergens"("allergenId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_ingredient_allergens_ingredientId_allergenId_key" ON "restaurant_ingredient_allergens"("ingredientId", "allergenId");

-- CreateIndex
CREATE INDEX "restaurant_ingredients_organizationId_idx" ON "restaurant_ingredients"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_ingredients_baseUnitId_idx" ON "restaurant_ingredients"("baseUnitId");

-- CreateIndex
CREATE INDEX "restaurant_recipes_organizationId_idx" ON "restaurant_recipes"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_recipes_productId_idx" ON "restaurant_recipes"("productId");

-- CreateIndex
CREATE INDEX "restaurant_recipes_variantId_idx" ON "restaurant_recipes"("variantId");

-- CreateIndex
CREATE INDEX "restaurant_recipe_versions_organizationId_idx" ON "restaurant_recipe_versions"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_recipe_versions_recipeId_idx" ON "restaurant_recipe_versions"("recipeId");

-- CreateIndex
CREATE INDEX "restaurant_recipe_versions_status_idx" ON "restaurant_recipe_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_recipe_versions_recipeId_versionNumber_key" ON "restaurant_recipe_versions"("recipeId", "versionNumber");

-- CreateIndex
CREATE INDEX "restaurant_recipe_lines_organizationId_idx" ON "restaurant_recipe_lines"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_recipe_lines_recipeVersionId_idx" ON "restaurant_recipe_lines"("recipeVersionId");

-- CreateIndex
CREATE INDEX "restaurant_recipe_lines_ingredientId_idx" ON "restaurant_recipe_lines"("ingredientId");

-- CreateIndex
CREATE INDEX "restaurant_recipe_lines_subRecipeId_idx" ON "restaurant_recipe_lines"("subRecipeId");

-- CreateIndex
CREATE INDEX "restaurant_price_lists_organizationId_idx" ON "restaurant_price_lists"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_price_list_versions_organizationId_idx" ON "restaurant_price_list_versions"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_price_list_versions_priceListId_idx" ON "restaurant_price_list_versions"("priceListId");

-- CreateIndex
CREATE INDEX "restaurant_price_list_versions_status_idx" ON "restaurant_price_list_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_price_list_versions_priceListId_effectiveFrom_key" ON "restaurant_price_list_versions"("priceListId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "restaurant_price_list_entries_organizationId_idx" ON "restaurant_price_list_entries"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_price_list_entries_priceListVersionId_idx" ON "restaurant_price_list_entries"("priceListVersionId");

-- CreateIndex
CREATE INDEX "restaurant_price_list_entries_productId_idx" ON "restaurant_price_list_entries"("productId");

-- CreateIndex
CREATE INDEX "restaurant_menus_organizationId_idx" ON "restaurant_menus"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_menus_brandId_idx" ON "restaurant_menus"("brandId");

-- CreateIndex
CREATE INDEX "restaurant_menu_sections_organizationId_idx" ON "restaurant_menu_sections"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_menu_sections_menuId_idx" ON "restaurant_menu_sections"("menuId");

-- CreateIndex
CREATE INDEX "restaurant_menu_items_organizationId_idx" ON "restaurant_menu_items"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_menu_items_sectionId_idx" ON "restaurant_menu_items"("sectionId");

-- CreateIndex
CREATE INDEX "restaurant_menu_items_productId_idx" ON "restaurant_menu_items"("productId");

-- CreateIndex
CREATE INDEX "restaurant_branch_menu_publications_organizationId_idx" ON "restaurant_branch_menu_publications"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_branch_menu_publications_branchId_idx" ON "restaurant_branch_menu_publications"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_branch_menu_publications_menuId_idx" ON "restaurant_branch_menu_publications"("menuId");

-- CreateIndex
CREATE INDEX "restaurant_branch_menu_publications_status_idx" ON "restaurant_branch_menu_publications"("status");

-- CreateIndex
CREATE INDEX "restaurant_menu_availability_windows_organizationId_idx" ON "restaurant_menu_availability_windows"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_menu_availability_windows_publicationId_idx" ON "restaurant_menu_availability_windows"("publicationId");

-- CreateIndex
CREATE INDEX "restaurant_menu_availability_windows_menuItemId_idx" ON "restaurant_menu_availability_windows"("menuItemId");

-- CreateIndex
CREATE INDEX "restaurant_menu_availability_exceptions_organizationId_idx" ON "restaurant_menu_availability_exceptions"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_menu_availability_exceptions_publicationId_idx" ON "restaurant_menu_availability_exceptions"("publicationId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_menu_availability_exceptions_publicationId_date_key" ON "restaurant_menu_availability_exceptions"("publicationId", "date");

-- CreateIndex
CREATE INDEX "restaurant_branch_menu_item_overrides_organizationId_idx" ON "restaurant_branch_menu_item_overrides"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_branch_menu_item_overrides_publicationId_idx" ON "restaurant_branch_menu_item_overrides"("publicationId");

-- CreateIndex
CREATE INDEX "restaurant_branch_menu_item_overrides_menuItemId_idx" ON "restaurant_branch_menu_item_overrides"("menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_branch_menu_item_overrides_publicationId_menuIte_key" ON "restaurant_branch_menu_item_overrides"("publicationId", "menuItemId");

-- AddForeignKey
ALTER TABLE "restaurant_categories" ADD CONSTRAINT "restaurant_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "restaurant_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_products" ADD CONSTRAINT "restaurant_products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "restaurant_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_product_variants" ADD CONSTRAINT "restaurant_product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_modifier_options" ADD CONSTRAINT "restaurant_modifier_options_modifierGroupId_fkey" FOREIGN KEY ("modifierGroupId") REFERENCES "restaurant_modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_product_modifier_groups" ADD CONSTRAINT "restaurant_product_modifier_groups_productId_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_product_modifier_groups" ADD CONSTRAINT "restaurant_product_modifier_groups_modifierGroupId_fkey" FOREIGN KEY ("modifierGroupId") REFERENCES "restaurant_modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_combo_component_groups" ADD CONSTRAINT "restaurant_combo_component_groups_comboProductId_fkey" FOREIGN KEY ("comboProductId") REFERENCES "restaurant_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_combo_component_options" ADD CONSTRAINT "restaurant_combo_component_options_componentGroupId_fkey" FOREIGN KEY ("componentGroupId") REFERENCES "restaurant_combo_component_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_combo_component_options" ADD CONSTRAINT "restaurant_combo_component_options_productId_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_combo_component_options" ADD CONSTRAINT "restaurant_combo_component_options_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "restaurant_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_unit_conversions" ADD CONSTRAINT "restaurant_unit_conversions_fromUnitId_fkey" FOREIGN KEY ("fromUnitId") REFERENCES "restaurant_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_unit_conversions" ADD CONSTRAINT "restaurant_unit_conversions_toUnitId_fkey" FOREIGN KEY ("toUnitId") REFERENCES "restaurant_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_product_allergens" ADD CONSTRAINT "restaurant_product_allergens_productId_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_product_allergens" ADD CONSTRAINT "restaurant_product_allergens_allergenId_fkey" FOREIGN KEY ("allergenId") REFERENCES "restaurant_allergens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_ingredient_allergens" ADD CONSTRAINT "restaurant_ingredient_allergens_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "restaurant_ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_ingredient_allergens" ADD CONSTRAINT "restaurant_ingredient_allergens_allergenId_fkey" FOREIGN KEY ("allergenId") REFERENCES "restaurant_allergens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_ingredients" ADD CONSTRAINT "restaurant_ingredients_baseUnitId_fkey" FOREIGN KEY ("baseUnitId") REFERENCES "restaurant_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_recipes" ADD CONSTRAINT "restaurant_recipes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_recipes" ADD CONSTRAINT "restaurant_recipes_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "restaurant_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_recipe_versions" ADD CONSTRAINT "restaurant_recipe_versions_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "restaurant_recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_recipe_versions" ADD CONSTRAINT "restaurant_recipe_versions_yieldUnitId_fkey" FOREIGN KEY ("yieldUnitId") REFERENCES "restaurant_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_recipe_lines" ADD CONSTRAINT "restaurant_recipe_lines_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "restaurant_recipe_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_recipe_lines" ADD CONSTRAINT "restaurant_recipe_lines_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "restaurant_ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_recipe_lines" ADD CONSTRAINT "restaurant_recipe_lines_subRecipeId_fkey" FOREIGN KEY ("subRecipeId") REFERENCES "restaurant_recipes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_recipe_lines" ADD CONSTRAINT "restaurant_recipe_lines_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "restaurant_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_price_list_versions" ADD CONSTRAINT "restaurant_price_list_versions_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "restaurant_price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_price_list_entries" ADD CONSTRAINT "restaurant_price_list_entries_priceListVersionId_fkey" FOREIGN KEY ("priceListVersionId") REFERENCES "restaurant_price_list_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_price_list_entries" ADD CONSTRAINT "restaurant_price_list_entries_productId_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_price_list_entries" ADD CONSTRAINT "restaurant_price_list_entries_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "restaurant_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menus" ADD CONSTRAINT "restaurant_menus_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "restaurant_brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menu_sections" ADD CONSTRAINT "restaurant_menu_sections_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "restaurant_menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menu_items" ADD CONSTRAINT "restaurant_menu_items_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "restaurant_menu_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menu_items" ADD CONSTRAINT "restaurant_menu_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menu_items" ADD CONSTRAINT "restaurant_menu_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "restaurant_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_branch_menu_publications" ADD CONSTRAINT "restaurant_branch_menu_publications_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_branch_menu_publications" ADD CONSTRAINT "restaurant_branch_menu_publications_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "restaurant_menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_branch_menu_publications" ADD CONSTRAINT "restaurant_branch_menu_publications_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "restaurant_price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menu_availability_windows" ADD CONSTRAINT "restaurant_menu_availability_windows_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "restaurant_branch_menu_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menu_availability_windows" ADD CONSTRAINT "restaurant_menu_availability_windows_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "restaurant_menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_menu_availability_exceptions" ADD CONSTRAINT "restaurant_menu_availability_exceptions_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "restaurant_branch_menu_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_branch_menu_item_overrides" ADD CONSTRAINT "restaurant_branch_menu_item_overrides_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "restaurant_branch_menu_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_branch_menu_item_overrides" ADD CONSTRAINT "restaurant_branch_menu_item_overrides_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "restaurant_menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Cross-tenant-safe composite integrity (matches 20260728091000 / M1-L1 / M2-L1):
-- the (organizationId, id) unique on every table referenced by a composite FK,
-- so a child can only reference a parent inside its OWN organization.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_brands" ADD CONSTRAINT "restaurant_brands_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_categories" ADD CONSTRAINT "restaurant_categories_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_products" ADD CONSTRAINT "restaurant_products_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_product_variants" ADD CONSTRAINT "restaurant_product_variants_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_modifier_groups" ADD CONSTRAINT "restaurant_modifier_groups_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_combo_component_groups" ADD CONSTRAINT "restaurant_combo_component_groups_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_units" ADD CONSTRAINT "restaurant_units_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_allergens" ADD CONSTRAINT "restaurant_allergens_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_ingredients" ADD CONSTRAINT "restaurant_ingredients_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_recipes" ADD CONSTRAINT "restaurant_recipes_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_recipe_versions" ADD CONSTRAINT "restaurant_recipe_versions_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_price_lists" ADD CONSTRAINT "restaurant_price_lists_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_price_list_versions" ADD CONSTRAINT "restaurant_price_list_versions_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_menus" ADD CONSTRAINT "restaurant_menus_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_menu_sections" ADD CONSTRAINT "restaurant_menu_sections_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_menu_items" ADD CONSTRAINT "restaurant_menu_items_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_branch_menu_publications" ADD CONSTRAINT "restaurant_branch_menu_publications_organizationId_id_key" UNIQUE ("organizationId", "id");

-- ---------------------------------------------------------------------------
-- Business uniqueness / integrity the Prisma schema cannot express.
-- ---------------------------------------------------------------------------
-- C6: exactly one default brand per organization.
CREATE UNIQUE INDEX "restaurant_brands_organizationId_default_key" ON "restaurant_brands"("organizationId") WHERE "isDefault";
-- One base (default) price list per organization — the fallback in the winning-
-- price precedence (item override > publication price list > base list).
CREATE UNIQUE INDEX "restaurant_price_lists_organizationId_default_key" ON "restaurant_price_lists"("organizationId") WHERE "isDefault";
-- C3: at most one ACTIVE version per recipe (a new active version supersedes the
-- prior one via effective-dating.ts). Superseded versions stay readable.
CREATE UNIQUE INDEX "restaurant_recipe_versions_active_key" ON "restaurant_recipe_versions"("recipeId") WHERE "status" = 'ACTIVE';
-- C4: one price entry per (version, product, variant). COALESCE folds the nullable
-- variant so the null-variant (base) row is still singular per (version, product).
CREATE UNIQUE INDEX "restaurant_price_list_entries_version_product_variant_key" ON "restaurant_price_list_entries"("priceListVersionId", "productId", COALESCE("variantId", ''));
-- C3: a recipe line references an ingredient XOR a sub-recipe — never both, never
-- neither. Encodes the lane's ingredient-XOR-sub-recipe rule at the DB level.
ALTER TABLE "restaurant_recipe_lines" ADD CONSTRAINT "restaurant_recipe_lines_ingredient_xor_subrecipe_ck" CHECK (("ingredientId" IS NOT NULL) <> ("subRecipeId" IS NOT NULL));
-- C5: availability-window wall-clock minutes are within a single day [0,1439]. A
-- cross-midnight window is expressed as endMinutes <= startMinutes, evaluated in
-- server code against the branch timezone.
ALTER TABLE "restaurant_menu_availability_windows" ADD CONSTRAINT "restaurant_menu_availability_windows_minutes_range_ck" CHECK ("startMinutes" BETWEEN 0 AND 1439 AND "endMinutes" BETWEEN 0 AND 1439);

-- ---------------------------------------------------------------------------
-- Deferred composite tenant foreign keys. Every single-column FK above is also
-- expressed as a (organizationId, <fk>) composite so a cross-organization
-- reference is impossible even inside the platform scope. Nullable FK columns
-- use MATCH SIMPLE (the default), so the composite is checked only when present.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_categories" ADD CONSTRAINT "tenant_cat_parentId_fk" FOREIGN KEY ("organizationId", "parentId") REFERENCES "restaurant_categories" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_products" ADD CONSTRAINT "tenant_prod_categoryId_fk" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "restaurant_categories" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_product_variants" ADD CONSTRAINT "tenant_variant_productId_fk" FOREIGN KEY ("organizationId", "productId") REFERENCES "restaurant_products" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_modifier_options" ADD CONSTRAINT "tenant_modopt_modifierGroupId_fk" FOREIGN KEY ("organizationId", "modifierGroupId") REFERENCES "restaurant_modifier_groups" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_product_modifier_groups" ADD CONSTRAINT "tenant_prodmod_productId_fk" FOREIGN KEY ("organizationId", "productId") REFERENCES "restaurant_products" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_product_modifier_groups" ADD CONSTRAINT "tenant_prodmod_modifierGroupId_fk" FOREIGN KEY ("organizationId", "modifierGroupId") REFERENCES "restaurant_modifier_groups" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_combo_component_groups" ADD CONSTRAINT "tenant_combogrp_comboProductId_fk" FOREIGN KEY ("organizationId", "comboProductId") REFERENCES "restaurant_products" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_combo_component_options" ADD CONSTRAINT "tenant_comboopt_componentGroupId_fk" FOREIGN KEY ("organizationId", "componentGroupId") REFERENCES "restaurant_combo_component_groups" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_combo_component_options" ADD CONSTRAINT "tenant_comboopt_productId_fk" FOREIGN KEY ("organizationId", "productId") REFERENCES "restaurant_products" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_combo_component_options" ADD CONSTRAINT "tenant_comboopt_variantId_fk" FOREIGN KEY ("organizationId", "variantId") REFERENCES "restaurant_product_variants" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_unit_conversions" ADD CONSTRAINT "tenant_uconv_fromUnitId_fk" FOREIGN KEY ("organizationId", "fromUnitId") REFERENCES "restaurant_units" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_unit_conversions" ADD CONSTRAINT "tenant_uconv_toUnitId_fk" FOREIGN KEY ("organizationId", "toUnitId") REFERENCES "restaurant_units" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_product_allergens" ADD CONSTRAINT "tenant_prodallg_productId_fk" FOREIGN KEY ("organizationId", "productId") REFERENCES "restaurant_products" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_product_allergens" ADD CONSTRAINT "tenant_prodallg_allergenId_fk" FOREIGN KEY ("organizationId", "allergenId") REFERENCES "restaurant_allergens" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_ingredient_allergens" ADD CONSTRAINT "tenant_ingallg_ingredientId_fk" FOREIGN KEY ("organizationId", "ingredientId") REFERENCES "restaurant_ingredients" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_ingredient_allergens" ADD CONSTRAINT "tenant_ingallg_allergenId_fk" FOREIGN KEY ("organizationId", "allergenId") REFERENCES "restaurant_allergens" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_ingredients" ADD CONSTRAINT "tenant_ingr_baseUnitId_fk" FOREIGN KEY ("organizationId", "baseUnitId") REFERENCES "restaurant_units" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_recipes" ADD CONSTRAINT "tenant_recipe_productId_fk" FOREIGN KEY ("organizationId", "productId") REFERENCES "restaurant_products" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_recipes" ADD CONSTRAINT "tenant_recipe_variantId_fk" FOREIGN KEY ("organizationId", "variantId") REFERENCES "restaurant_product_variants" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_recipe_versions" ADD CONSTRAINT "tenant_recipever_recipeId_fk" FOREIGN KEY ("organizationId", "recipeId") REFERENCES "restaurant_recipes" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_recipe_versions" ADD CONSTRAINT "tenant_recipever_yieldUnitId_fk" FOREIGN KEY ("organizationId", "yieldUnitId") REFERENCES "restaurant_units" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_recipe_lines" ADD CONSTRAINT "tenant_recipeline_recipeVersionId_fk" FOREIGN KEY ("organizationId", "recipeVersionId") REFERENCES "restaurant_recipe_versions" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_recipe_lines" ADD CONSTRAINT "tenant_recipeline_ingredientId_fk" FOREIGN KEY ("organizationId", "ingredientId") REFERENCES "restaurant_ingredients" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_recipe_lines" ADD CONSTRAINT "tenant_recipeline_subRecipeId_fk" FOREIGN KEY ("organizationId", "subRecipeId") REFERENCES "restaurant_recipes" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_recipe_lines" ADD CONSTRAINT "tenant_recipeline_unitId_fk" FOREIGN KEY ("organizationId", "unitId") REFERENCES "restaurant_units" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_price_list_versions" ADD CONSTRAINT "tenant_plver_priceListId_fk" FOREIGN KEY ("organizationId", "priceListId") REFERENCES "restaurant_price_lists" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_price_list_entries" ADD CONSTRAINT "tenant_plentry_priceListVersionId_fk" FOREIGN KEY ("organizationId", "priceListVersionId") REFERENCES "restaurant_price_list_versions" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_price_list_entries" ADD CONSTRAINT "tenant_plentry_productId_fk" FOREIGN KEY ("organizationId", "productId") REFERENCES "restaurant_products" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_price_list_entries" ADD CONSTRAINT "tenant_plentry_variantId_fk" FOREIGN KEY ("organizationId", "variantId") REFERENCES "restaurant_product_variants" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menus" ADD CONSTRAINT "tenant_menu_brandId_fk" FOREIGN KEY ("organizationId", "brandId") REFERENCES "restaurant_brands" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menu_sections" ADD CONSTRAINT "tenant_menusec_menuId_fk" FOREIGN KEY ("organizationId", "menuId") REFERENCES "restaurant_menus" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menu_items" ADD CONSTRAINT "tenant_menuitem_sectionId_fk" FOREIGN KEY ("organizationId", "sectionId") REFERENCES "restaurant_menu_sections" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menu_items" ADD CONSTRAINT "tenant_menuitem_productId_fk" FOREIGN KEY ("organizationId", "productId") REFERENCES "restaurant_products" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menu_items" ADD CONSTRAINT "tenant_menuitem_variantId_fk" FOREIGN KEY ("organizationId", "variantId") REFERENCES "restaurant_product_variants" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_branch_menu_publications" ADD CONSTRAINT "tenant_pub_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_branch_menu_publications" ADD CONSTRAINT "tenant_pub_menuId_fk" FOREIGN KEY ("organizationId", "menuId") REFERENCES "restaurant_menus" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_branch_menu_publications" ADD CONSTRAINT "tenant_pub_priceListId_fk" FOREIGN KEY ("organizationId", "priceListId") REFERENCES "restaurant_price_lists" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menu_availability_windows" ADD CONSTRAINT "tenant_availwin_publicationId_fk" FOREIGN KEY ("organizationId", "publicationId") REFERENCES "restaurant_branch_menu_publications" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menu_availability_windows" ADD CONSTRAINT "tenant_availwin_menuItemId_fk" FOREIGN KEY ("organizationId", "menuItemId") REFERENCES "restaurant_menu_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_menu_availability_exceptions" ADD CONSTRAINT "tenant_availexc_publicationId_fk" FOREIGN KEY ("organizationId", "publicationId") REFERENCES "restaurant_branch_menu_publications" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_branch_menu_item_overrides" ADD CONSTRAINT "tenant_itemovr_publicationId_fk" FOREIGN KEY ("organizationId", "publicationId") REFERENCES "restaurant_branch_menu_publications" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_branch_menu_item_overrides" ADD CONSTRAINT "tenant_itemovr_menuItemId_fk" FOREIGN KEY ("organizationId", "menuItemId") REFERENCES "restaurant_menu_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Forced org-level RLS on every new table, identical clause to
-- 20260728092000_row_level_security / M1-L1 / M2-L1 (including the
-- app.is_platform_admin control-plane escape). No branch-level DB policy is
-- invented here (D12 seam); branch scope is enforced in server code above the
-- organization boundary.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_brands" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_brands" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_categories" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_products" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_products" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_product_variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_product_variants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_product_variants" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_modifier_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_modifier_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_modifier_groups" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_modifier_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_modifier_options" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_modifier_options" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_product_modifier_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_product_modifier_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_product_modifier_groups" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_combo_component_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_combo_component_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_combo_component_groups" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_combo_component_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_combo_component_options" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_combo_component_options" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_units" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_units" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_unit_conversions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_unit_conversions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_unit_conversions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_allergens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_allergens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_allergens" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_product_allergens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_product_allergens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_product_allergens" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_ingredient_allergens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_ingredient_allergens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_ingredient_allergens" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_ingredients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_ingredients" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_ingredients" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_recipes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_recipes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_recipes" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_recipe_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_recipe_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_recipe_versions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_recipe_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_recipe_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_recipe_lines" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_price_lists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_price_lists" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_price_lists" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_price_list_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_price_list_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_price_list_versions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_price_list_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_price_list_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_price_list_entries" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_menus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_menus" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_menus" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_menu_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_menu_sections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_menu_sections" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_menu_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_menu_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_menu_items" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_branch_menu_publications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_branch_menu_publications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_branch_menu_publications" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_menu_availability_windows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_menu_availability_windows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_menu_availability_windows" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_menu_availability_exceptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_menu_availability_exceptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_menu_availability_exceptions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_branch_menu_item_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_branch_menu_item_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_branch_menu_item_overrides" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

