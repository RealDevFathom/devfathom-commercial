-- WHA-288 / promotions Lane A — the checkout discount layer.
-- Spec: docs/specs/restaurant-promotions.md (WHA-279), §3, §4, §5, §6, §10.
--
-- FORWARD-ONLY and strictly ADDITIVE (§14.1/§14.2): eleven new tenant-owned
-- tables and thirteen new enums. No existing table, column, constraint, index,
-- policy or trigger is altered or dropped, so an operational rollback loses
-- only promotion configuration and promotion evidence. Nothing in the legacy
-- checkout path reads these tables yet.
--
-- The DDL below the "-- GENERATED" marker is `prisma migrate diff` output over
-- the datamodel, so schema and migration cannot drift. Everything under
-- "-- INVARIANTS" is what Prisma cannot express and the spec requires:
--
--   I1  Benefit/target/schedule/authority compatibility CHECKs (§3.1 "publishing
--       validates ... benefit/target compatibility"). A row that the evaluator
--       could not interpret deterministically cannot be stored at all.
--   I2  At most ONE PUBLISHED version per promotion identity, as a partial
--       unique index — this is what makes publication "atomically supersede the
--       prior published version" (§3.1) rather than a two-step read-then-write.
--   I3  Immutability: published/superseded versions and their rule components
--       reject UPDATE/DELETE; every snapshot, allocation and audit table is
--       append-only at the DB layer (§3.1, §5.2 "snapshot rows reject
--       update/delete at the database layer").
--   I4  Cap counters can never be oversubscribed, as a CHECK
--       (consumed <= cap). §6 forbids a client-reported or asynchronously
--       decremented counter; the CHECK means even a buggy caller cannot commit
--       an over-cap consumption — the transaction aborts.
--   I5  Reservations are append-only except for the two legal state
--       transitions RESERVED -> CONSUMED and RESERVED -> RELEASED (§6).
--   I6  Same-tenant integrity for the SCALAR order/bill/branch references. This
--       lane owns promotion symbols only and may not add a back-relation field
--       to RestaurantOrder/RestaurantBill/RestaurantBranch, so the composite FK
--       §10 asks for is expressed as a fail-closed BEFORE INSERT trigger that
--       resolves the reference under the caller's own RLS. A cross-tenant id is
--       invisible to that lookup and therefore raises, which is the same
--       outcome a composite FK would produce.
--   I7  Forced RLS on all eleven tables, failing closed when
--       `app.current_organization_id` is absent (§10). The six append-only
--       tables get SELECT + INSERT policies ONLY — the repo's established
--       ledger pattern, where UPDATE/DELETE match zero rows for the app role.
--
-- Money scale is DECIMAL(12,2) everywhere except the deliberately retained
-- pre-rounding benefit, DECIMAL(18,6), so §5.1's "unrounded and rounded
-- benefit" is auditable rather than reconstructed.

-- GENERATED ------------------------------------------------------------------
-- CreateEnum
CREATE TYPE "RestaurantPromotionStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RestaurantPromotionVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RestaurantPromotionActivationMode" AS ENUM ('AUTOMATIC', 'COUPON_CODE', 'STAFF', 'MANAGER');

-- CreateEnum
CREATE TYPE "RestaurantPromotionTargetKind" AS ENUM ('ITEM', 'CATEGORY', 'ORDER');

-- CreateEnum
CREATE TYPE "RestaurantPromotionBenefitKind" AS ENUM ('PERCENT_OFF', 'AMOUNT_OFF', 'FIXED_PRICE', 'BUY_X_GET_Y_PERCENT', 'BUY_X_GET_Y_AMOUNT', 'BUY_X_GET_Y_FREE', 'BUNDLE_PRICE');

-- CreateEnum
CREATE TYPE "RestaurantPromotionApplicationBasis" AS ENUM ('LINE', 'UNIT', 'ORDER');

-- CreateEnum
CREATE TYPE "RestaurantPromotionStackingMode" AS ENUM ('EXCLUSIVE', 'GROUP_EXCLUSIVE', 'STACKABLE');

-- CreateEnum
CREATE TYPE "RestaurantPromotionOfflinePolicy" AS ENUM ('ALLOW', 'ONLINE_ONLY');

-- CreateEnum
CREATE TYPE "RestaurantPromotionEvaluationSource" AS ENUM ('ONLINE', 'OFFLINE_RECONCILED');

-- CreateEnum
CREATE TYPE "RestaurantPromotionCapScopeKind" AS ENUM ('GLOBAL', 'CUSTOMER', 'BUDGET');

-- CreateEnum
CREATE TYPE "RestaurantPromotionReservationState" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "RestaurantPromotionCandidateOutcome" AS ENUM ('ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RestaurantPromotionAuditAction" AS ENUM ('DRAFT_CREATED', 'DRAFT_EDITED', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED', 'EMERGENCY_DISABLED', 'EVALUATED', 'CAP_RESERVED', 'CAP_CONSUMED', 'CAP_RELEASED', 'OFFLINE_MISMATCH', 'REVERSED');

-- CreateTable
CREATE TABLE "restaurant_promotions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RestaurantPromotionStatus" NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "promotionId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "RestaurantPromotionVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "timezone" TEXT NOT NULL,
    "dayMask" INTEGER NOT NULL DEFAULT 127,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "activationMode" "RestaurantPromotionActivationMode" NOT NULL DEFAULT 'AUTOMATIC',
    "couponCodeHash" TEXT,
    "requiredPermission" TEXT,
    "requiresCoAuthorization" BOOLEAN NOT NULL DEFAULT false,
    "approvedByStaffId" TEXT,
    "approvalReference" TEXT,
    "publishedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "targetKind" "RestaurantPromotionTargetKind" NOT NULL,
    "targetProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetVariantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "includeDescendants" BOOLEAN NOT NULL DEFAULT false,
    "componentTargeting" BOOLEAN NOT NULL DEFAULT false,
    "allowedBranchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedChannels" "RestaurantOrderChannel"[] DEFAULT ARRAY[]::"RestaurantOrderChannel"[],
    "customerSegmentRef" TEXT,
    "minimumQuantity" INTEGER,
    "minimumAmount" DECIMAL(12,2),
    "benefitKind" "RestaurantPromotionBenefitKind" NOT NULL,
    "benefitBasisPoints" INTEGER,
    "benefitAmount" DECIMAL(12,2),
    "buyQuantity" INTEGER,
    "getQuantity" INTEGER,
    "applicationBasis" "RestaurantPromotionApplicationBasis" NOT NULL DEFAULT 'ORDER',
    "maxBenefitAmount" DECIMAL(12,2),
    "currency" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "stackingGroup" TEXT NOT NULL DEFAULT '',
    "stackingMode" "RestaurantPromotionStackingMode" NOT NULL DEFAULT 'STACKABLE',
    "stopFurtherProcessing" BOOLEAN NOT NULL DEFAULT false,
    "maxApplicationsPerOrder" INTEGER,
    "perOrderCap" INTEGER,
    "globalCap" INTEGER,
    "perCustomerCap" INTEGER,
    "budgetAmount" DECIMAL(12,2),
    "offlinePolicy" "RestaurantPromotionOfflinePolicy" NOT NULL DEFAULT 'ONLINE_ONLY',
    "ruleSnapshot" JSONB NOT NULL,
    "ruleHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_promotion_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_rule_components" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "promotionVersionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "variantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_rule_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_evaluation_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "orderId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "channel" "RestaurantOrderChannel" NOT NULL,
    "currency" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "localMinute" INTEGER NOT NULL,
    "utcOffsetMinutes" INTEGER NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "moneyVersion" TEXT NOT NULL,
    "setRevisionId" TEXT NOT NULL,
    "setRevisionHash" TEXT NOT NULL,
    "source" "RestaurantPromotionEvaluationSource" NOT NULL DEFAULT 'ONLINE',
    "terminalDeviceId" TEXT,
    "priceListVersionId" TEXT,
    "inputLines" JSONB NOT NULL,
    "evaluationContext" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL,
    "outputHash" TEXT NOT NULL,
    "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reversesSnapshotId" TEXT,
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_evaluation_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_candidate_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "evaluationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "promotionId" TEXT NOT NULL,
    "promotionVersionId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "ruleHash" TEXT NOT NULL,
    "ruleSnapshot" JSONB NOT NULL,
    "activationMode" "RestaurantPromotionActivationMode" NOT NULL,
    "authorityActorId" TEXT,
    "authorityReference" TEXT,
    "couponFingerprint" TEXT,
    "outcome" "RestaurantPromotionCandidateOutcome" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_candidate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_application_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "evaluationId" TEXT NOT NULL,
    "applicationOrdinal" INTEGER NOT NULL,
    "promotionId" TEXT NOT NULL,
    "promotionVersionId" TEXT NOT NULL,
    "ruleHash" TEXT NOT NULL,
    "benefitKind" "RestaurantPromotionBenefitKind" NOT NULL,
    "unroundedBenefit" DECIMAL(18,6) NOT NULL,
    "roundedBenefit" DECIMAL(12,2) NOT NULL,
    "qualifyingAmount" DECIMAL(12,2) NOT NULL,
    "discountedQuantity" INTEGER NOT NULL DEFAULT 0,
    "reservationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_application_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_unit_allocations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "applicationId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "unitOrdinal" INTEGER NOT NULL,
    "allocatedAmount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_unit_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_bill_application_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "billId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "promotionVersionId" TEXT NOT NULL,
    "ruleHash" TEXT NOT NULL,
    "authorityActorId" TEXT,
    "applicationOrdinal" INTEGER NOT NULL,
    "subtotalBasis" DECIMAL(12,2) NOT NULL,
    "computedAmount" DECIMAL(12,2) NOT NULL,
    "taxTreatment" TEXT,
    "reversesBillApplicationId" TEXT,
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_bill_application_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_cap_counters" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "promotionVersionId" TEXT NOT NULL,
    "scopeKind" "RestaurantPromotionCapScopeKind" NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "capCount" INTEGER,
    "capAmount" DECIMAL(12,2),
    "consumedCount" INTEGER NOT NULL DEFAULT 0,
    "consumedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_promotion_cap_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_cap_reservations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "counterId" TEXT NOT NULL,
    "promotionVersionId" TEXT NOT NULL,
    "scopeKind" "RestaurantPromotionCapScopeKind" NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "evaluationId" TEXT NOT NULL,
    "applicationOrdinal" INTEGER NOT NULL,
    "reservedCount" INTEGER NOT NULL DEFAULT 1,
    "reservedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "state" "RestaurantPromotionReservationState" NOT NULL DEFAULT 'RESERVED',
    "expiresAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_cap_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_audit_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "action" "RestaurantPromotionAuditAction" NOT NULL,
    "promotionId" TEXT,
    "promotionVersionId" TEXT,
    "evaluationId" TEXT,
    "reasonCode" TEXT,
    "actorUserId" TEXT,
    "actorStaffId" TEXT,
    "deviceId" TEXT,
    "payloadHash" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promo_org_idx" ON "restaurant_promotions"("organizationId");

-- CreateIndex
CREATE INDEX "promo_org_status_idx" ON "restaurant_promotions"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "promo_org_code_key" ON "restaurant_promotions"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "promo_org_id_key" ON "restaurant_promotions"("organizationId", "id");

-- CreateIndex
CREATE INDEX "promo_version_org_idx" ON "restaurant_promotion_versions"("organizationId");

-- CreateIndex
CREATE INDEX "promo_version_org_status_effective_idx" ON "restaurant_promotion_versions"("organizationId", "status", "effectiveFrom");

-- CreateIndex
CREATE INDEX "promo_version_org_promo_status_idx" ON "restaurant_promotion_versions"("organizationId", "promotionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "promo_version_org_promo_number_key" ON "restaurant_promotion_versions"("organizationId", "promotionId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "promo_version_org_id_key" ON "restaurant_promotion_versions"("organizationId", "id");

-- CreateIndex
CREATE INDEX "promo_component_org_idx" ON "restaurant_promotion_rule_components"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_component_org_version_ordinal_key" ON "restaurant_promotion_rule_components"("organizationId", "promotionVersionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "promo_component_org_id_key" ON "restaurant_promotion_rule_components"("organizationId", "id");

-- CreateIndex
CREATE INDEX "promo_eval_org_idx" ON "restaurant_promotion_evaluation_snapshots"("organizationId");

-- CreateIndex
CREATE INDEX "promo_eval_org_order_idx" ON "restaurant_promotion_evaluation_snapshots"("organizationId", "orderId");

-- CreateIndex
CREATE INDEX "promo_eval_org_branch_time_idx" ON "restaurant_promotion_evaluation_snapshots"("organizationId", "branchId", "evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "promo_eval_org_key_key" ON "restaurant_promotion_evaluation_snapshots"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "promo_eval_org_id_key" ON "restaurant_promotion_evaluation_snapshots"("organizationId", "id");

-- CreateIndex
CREATE INDEX "promo_candidate_org_idx" ON "restaurant_promotion_candidate_snapshots"("organizationId");

-- CreateIndex
CREATE INDEX "promo_candidate_org_version_idx" ON "restaurant_promotion_candidate_snapshots"("organizationId", "promotionVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_candidate_org_eval_ordinal_key" ON "restaurant_promotion_candidate_snapshots"("organizationId", "evaluationId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "promo_candidate_org_id_key" ON "restaurant_promotion_candidate_snapshots"("organizationId", "id");

-- CreateIndex
CREATE INDEX "promo_app_org_idx" ON "restaurant_promotion_application_snapshots"("organizationId");

-- CreateIndex
CREATE INDEX "promo_app_org_version_idx" ON "restaurant_promotion_application_snapshots"("organizationId", "promotionVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_app_org_eval_ordinal_key" ON "restaurant_promotion_application_snapshots"("organizationId", "evaluationId", "applicationOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "promo_app_org_id_key" ON "restaurant_promotion_application_snapshots"("organizationId", "id");

-- CreateIndex
CREATE INDEX "promo_alloc_org_idx" ON "restaurant_promotion_unit_allocations"("organizationId");

-- CreateIndex
CREATE INDEX "promo_alloc_org_item_idx" ON "restaurant_promotion_unit_allocations"("organizationId", "orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_alloc_org_app_item_unit_key" ON "restaurant_promotion_unit_allocations"("organizationId", "applicationId", "orderItemId", "unitOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "promo_alloc_org_id_key" ON "restaurant_promotion_unit_allocations"("organizationId", "id");

-- CreateIndex
CREATE INDEX "promo_bill_app_org_idx" ON "restaurant_promotion_bill_application_snapshots"("organizationId");

-- CreateIndex
CREATE INDEX "promo_bill_app_org_bill_idx" ON "restaurant_promotion_bill_application_snapshots"("organizationId", "billId");

-- CreateIndex
CREATE INDEX "promo_bill_app_org_order_idx" ON "restaurant_promotion_bill_application_snapshots"("organizationId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_bill_app_org_id_key" ON "restaurant_promotion_bill_application_snapshots"("organizationId", "id");

-- CreateIndex
CREATE INDEX "promo_cap_ctr_org_idx" ON "restaurant_promotion_cap_counters"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_cap_ctr_org_version_scope_scopekey_key" ON "restaurant_promotion_cap_counters"("organizationId", "promotionVersionId", "scopeKind", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "promo_cap_ctr_org_id_key" ON "restaurant_promotion_cap_counters"("organizationId", "id");

-- CreateIndex
CREATE INDEX "promo_cap_res_org_idx" ON "restaurant_promotion_cap_reservations"("organizationId");

-- CreateIndex
CREATE INDEX "promo_cap_res_org_counter_state_idx" ON "restaurant_promotion_cap_reservations"("organizationId", "counterId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "promo_cap_res_org_version_scope_scopekey_eval_ordinal_key" ON "restaurant_promotion_cap_reservations"("organizationId", "promotionVersionId", "scopeKind", "scopeKey", "evaluationId", "applicationOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "promo_cap_res_org_id_key" ON "restaurant_promotion_cap_reservations"("organizationId", "id");

-- CreateIndex
CREATE INDEX "promo_audit_org_idx" ON "restaurant_promotion_audit_events"("organizationId");

-- CreateIndex
CREATE INDEX "promo_audit_org_action_time_idx" ON "restaurant_promotion_audit_events"("organizationId", "action", "occurredAt");

-- CreateIndex
CREATE INDEX "promo_audit_org_version_idx" ON "restaurant_promotion_audit_events"("organizationId", "promotionVersionId");

-- AddForeignKey
ALTER TABLE "restaurant_promotion_versions" ADD CONSTRAINT "promo_version_promotion_fkey" FOREIGN KEY ("organizationId", "promotionId") REFERENCES "restaurant_promotions"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_rule_components" ADD CONSTRAINT "promo_component_version_fkey" FOREIGN KEY ("organizationId", "promotionVersionId") REFERENCES "restaurant_promotion_versions"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_evaluation_snapshots" ADD CONSTRAINT "promo_eval_reversedsnapshot_fkey" FOREIGN KEY ("organizationId", "reversesSnapshotId") REFERENCES "restaurant_promotion_evaluation_snapshots"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_candidate_snapshots" ADD CONSTRAINT "promo_candidate_evaluation_fkey" FOREIGN KEY ("organizationId", "evaluationId") REFERENCES "restaurant_promotion_evaluation_snapshots"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_candidate_snapshots" ADD CONSTRAINT "promo_candidate_version_fkey" FOREIGN KEY ("organizationId", "promotionVersionId") REFERENCES "restaurant_promotion_versions"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_application_snapshots" ADD CONSTRAINT "promo_app_evaluation_fkey" FOREIGN KEY ("organizationId", "evaluationId") REFERENCES "restaurant_promotion_evaluation_snapshots"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_application_snapshots" ADD CONSTRAINT "promo_app_version_fkey" FOREIGN KEY ("organizationId", "promotionVersionId") REFERENCES "restaurant_promotion_versions"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_unit_allocations" ADD CONSTRAINT "promo_alloc_application_fkey" FOREIGN KEY ("organizationId", "applicationId") REFERENCES "restaurant_promotion_application_snapshots"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_bill_application_snapshots" ADD CONSTRAINT "promo_bill_app_evaluation_fkey" FOREIGN KEY ("organizationId", "evaluationId") REFERENCES "restaurant_promotion_evaluation_snapshots"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_bill_application_snapshots" ADD CONSTRAINT "promo_bill_app_application_fkey" FOREIGN KEY ("organizationId", "applicationId") REFERENCES "restaurant_promotion_application_snapshots"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_bill_application_snapshots" ADD CONSTRAINT "promo_bill_app_reversedapplied_fkey" FOREIGN KEY ("organizationId", "reversesBillApplicationId") REFERENCES "restaurant_promotion_bill_application_snapshots"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_cap_counters" ADD CONSTRAINT "promo_cap_ctr_version_fkey" FOREIGN KEY ("organizationId", "promotionVersionId") REFERENCES "restaurant_promotion_versions"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_cap_reservations" ADD CONSTRAINT "promo_cap_res_counter_fkey" FOREIGN KEY ("organizationId", "counterId") REFERENCES "restaurant_promotion_cap_counters"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_cap_reservations" ADD CONSTRAINT "promo_cap_res_evaluation_fkey" FOREIGN KEY ("organizationId", "evaluationId") REFERENCES "restaurant_promotion_evaluation_snapshots"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- INVARIANTS -----------------------------------------------------------------

-- I1 §3.1/§3.3/§3.4: a stored version is always deterministically interpretable.
ALTER TABLE "restaurant_promotion_versions"
  ADD CONSTRAINT "promo_version_number_positive" CHECK ("versionNumber" > 0),
  ADD CONSTRAINT "promo_version_effective_range" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
  ADD CONSTRAINT "promo_version_day_mask" CHECK ("dayMask" BETWEEN 0 AND 127),
  -- §3.2: the minute window is present or absent as a PAIR; equal endpoints mean
  -- a full selected day and startMinute > endMinute is a legal overnight window,
  -- so neither ordering is constrained here.
  ADD CONSTRAINT "promo_version_minute_window" CHECK (
    ("startMinute" IS NULL) = ("endMinute" IS NULL)
    AND ("startMinute" IS NULL OR ("startMinute" BETWEEN 0 AND 1439 AND "endMinute" BETWEEN 0 AND 1439))
  ),
  ADD CONSTRAINT "promo_version_currency" CHECK (char_length("currency") = 3),
  -- §3.4: percentages above 100% are invalid.
  ADD CONSTRAINT "promo_version_basis_points" CHECK ("benefitBasisPoints" IS NULL OR ("benefitBasisPoints" BETWEEN 0 AND 10000)),
  -- §3.4: negative amounts are invalid.
  ADD CONSTRAINT "promo_version_money_non_negative" CHECK (
    ("benefitAmount" IS NULL OR "benefitAmount" >= 0)
    AND ("minimumAmount" IS NULL OR "minimumAmount" >= 0)
    AND ("maxBenefitAmount" IS NULL OR "maxBenefitAmount" >= 0)
    AND ("budgetAmount" IS NULL OR "budgetAmount" > 0)
  ),
  ADD CONSTRAINT "promo_version_counts_positive" CHECK (
    ("minimumQuantity" IS NULL OR "minimumQuantity" > 0)
    AND ("buyQuantity" IS NULL OR "buyQuantity" > 0)
    AND ("getQuantity" IS NULL OR "getQuantity" > 0)
    AND ("maxApplicationsPerOrder" IS NULL OR "maxApplicationsPerOrder" > 0)
    AND ("perOrderCap" IS NULL OR "perOrderCap" > 0)
    AND ("globalCap" IS NULL OR "globalCap" > 0)
    AND ("perCustomerCap" IS NULL OR "perCustomerCap" > 0)
  ),
  -- §3.4: each benefit kind carries exactly the operands its formula needs.
  ADD CONSTRAINT "promo_version_benefit_operands" CHECK (
    CASE "benefitKind"
      WHEN 'PERCENT_OFF' THEN "benefitBasisPoints" IS NOT NULL AND "benefitAmount" IS NULL AND "buyQuantity" IS NULL AND "getQuantity" IS NULL
      WHEN 'AMOUNT_OFF' THEN "benefitAmount" IS NOT NULL AND "benefitBasisPoints" IS NULL AND "buyQuantity" IS NULL AND "getQuantity" IS NULL
      WHEN 'FIXED_PRICE' THEN "benefitAmount" IS NOT NULL AND "benefitBasisPoints" IS NULL AND "buyQuantity" IS NULL AND "getQuantity" IS NULL
      WHEN 'BUY_X_GET_Y_PERCENT' THEN "buyQuantity" IS NOT NULL AND "getQuantity" IS NOT NULL AND "benefitBasisPoints" IS NOT NULL AND "benefitAmount" IS NULL
      WHEN 'BUY_X_GET_Y_AMOUNT' THEN "buyQuantity" IS NOT NULL AND "getQuantity" IS NOT NULL AND "benefitAmount" IS NOT NULL AND "benefitBasisPoints" IS NULL
      -- §3.4.6 is shorthand for BUY_X_GET_Y_PERCENT at 10000bp; it stores no rate.
      WHEN 'BUY_X_GET_Y_FREE' THEN "buyQuantity" IS NOT NULL AND "getQuantity" IS NOT NULL AND "benefitBasisPoints" IS NULL AND "benefitAmount" IS NULL
      WHEN 'BUNDLE_PRICE' THEN "benefitAmount" IS NOT NULL AND "benefitBasisPoints" IS NULL AND "buyQuantity" IS NULL AND "getQuantity" IS NULL
    END
  ),
  -- §3.3: the target expression names what it targets.
  ADD CONSTRAINT "promo_version_target_operands" CHECK (
    CASE "targetKind"
      WHEN 'ITEM' THEN array_length("targetProductIds", 1) IS NOT NULL AND array_length("targetCategoryIds", 1) IS NULL
      WHEN 'CATEGORY' THEN array_length("targetCategoryIds", 1) IS NOT NULL AND array_length("targetProductIds", 1) IS NULL
      WHEN 'ORDER' THEN array_length("targetProductIds", 1) IS NULL AND array_length("targetCategoryIds", 1) IS NULL AND array_length("targetVariantIds", 1) IS NULL
    END
  ),
  -- §3.1: a published version records its approval evidence and publish instant.
  ADD CONSTRAINT "promo_version_published_evidence" CHECK (
    "status" = 'DRAFT' OR ("publishedAt" IS NOT NULL AND "approvalReference" IS NOT NULL)
  ),
  ADD CONSTRAINT "promo_version_superseded_evidence" CHECK ("status" <> 'SUPERSEDED' OR "supersededAt" IS NOT NULL),
  -- §3.1/§10: a coupon rule stores its keyed hash, never plaintext.
  ADD CONSTRAINT "promo_version_coupon_hash" CHECK ("activationMode" <> 'COUPON_CODE' OR "couponCodeHash" IS NOT NULL),
  -- §7 fail-closed: a capped, segmented or manager-authorized rule can never be
  -- marked offline-eligible in the first place.
  ADD CONSTRAINT "promo_version_offline_is_uncapped" CHECK (
    "offlinePolicy" = 'ONLINE_ONLY'
    OR ("globalCap" IS NULL AND "perCustomerCap" IS NULL AND "budgetAmount" IS NULL
        AND "customerSegmentRef" IS NULL AND "activationMode" <> 'MANAGER')
  );

ALTER TABLE "restaurant_promotion_rule_components"
  ADD CONSTRAINT "promo_component_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "promo_component_names_a_target" CHECK (
    array_length("productIds", 1) IS NOT NULL OR array_length("categoryIds", 1) IS NOT NULL
  );

-- I2 §3.1: publication atomically supersedes. Two PUBLISHED versions of one
-- identity cannot coexist even for the duration of a botched two-statement
-- publish — the second INSERT/UPDATE aborts.
CREATE UNIQUE INDEX "promo_version_one_published_key"
  ON "restaurant_promotion_versions" ("organizationId", "promotionId")
  WHERE "status" = 'PUBLISHED';

-- §5.1 snapshot shape invariants.
ALTER TABLE "restaurant_promotion_evaluation_snapshots"
  ADD CONSTRAINT "promo_eval_local_minute" CHECK ("localMinute" BETWEEN 0 AND 1439),
  ADD CONSTRAINT "promo_eval_local_date" CHECK ("localDate" ~ '^\d{4}-\d{2}-\d{2}$'),
  ADD CONSTRAINT "promo_eval_currency" CHECK (char_length("currency") = 3),
  ADD CONSTRAINT "promo_eval_reversal_pair" CHECK (("reversesSnapshotId" IS NULL) = ("reversalReason" IS NULL)),
  -- A forward evaluation never discounts a negative amount; a reversal is the
  -- only row permitted to carry a negative total (§5.2).
  ADD CONSTRAINT "promo_eval_discount_sign" CHECK (
    ("reversesSnapshotId" IS NULL AND "discountTotal" >= 0)
    OR ("reversesSnapshotId" IS NOT NULL AND "discountTotal" <= 0)
  );

ALTER TABLE "restaurant_promotion_application_snapshots"
  ADD CONSTRAINT "promo_app_benefit_non_negative" CHECK ("roundedBenefit" >= 0 AND "unroundedBenefit" >= 0),
  ADD CONSTRAINT "promo_app_qualifying_non_negative" CHECK ("qualifyingAmount" >= 0),
  ADD CONSTRAINT "promo_app_quantity_non_negative" CHECK ("discountedQuantity" >= 0),
  ADD CONSTRAINT "promo_app_ordinal_non_negative" CHECK ("applicationOrdinal" >= 0);

ALTER TABLE "restaurant_promotion_unit_allocations"
  -- §4.2: no line becomes negative, so no allocation is negative.
  ADD CONSTRAINT "promo_alloc_non_negative" CHECK ("allocatedAmount" >= 0),
  ADD CONSTRAINT "promo_alloc_unit_ordinal" CHECK ("unitOrdinal" >= 0);

ALTER TABLE "restaurant_promotion_candidate_snapshots"
  ADD CONSTRAINT "promo_candidate_ordinal_non_negative" CHECK ("ordinal" >= 0),
  ADD CONSTRAINT "promo_candidate_reason_present" CHECK (char_length("reasonCode") > 0);

ALTER TABLE "restaurant_promotion_bill_application_snapshots"
  ADD CONSTRAINT "promo_bill_app_reversal_pair" CHECK (("reversesBillApplicationId" IS NULL) = ("reversalReason" IS NULL)),
  ADD CONSTRAINT "promo_bill_app_tax_treatment" CHECK ("taxTreatment" IS NULL OR "taxTreatment" IN ('BEFORE_TAX', 'AFTER_TAX')),
  ADD CONSTRAINT "promo_bill_app_basis_non_negative" CHECK ("subtotalBasis" >= 0),
  ADD CONSTRAINT "promo_bill_app_amount_sign" CHECK (
    ("reversesBillApplicationId" IS NULL AND "computedAmount" >= 0)
    OR ("reversesBillApplicationId" IS NOT NULL AND "computedAmount" <= 0)
  );

-- I4 §6: the cap is a database invariant, not a convention. Committed
-- consumption can never exceed the cap the version declared.
ALTER TABLE "restaurant_promotion_cap_counters"
  ADD CONSTRAINT "promo_cap_ctr_non_negative" CHECK ("consumedCount" >= 0 AND "consumedAmount" >= 0),
  ADD CONSTRAINT "promo_cap_ctr_caps_positive" CHECK (
    ("capCount" IS NULL OR "capCount" > 0) AND ("capAmount" IS NULL OR "capAmount" > 0)
  ),
  ADD CONSTRAINT "promo_cap_ctr_within_cap" CHECK (
    ("capCount" IS NULL OR "consumedCount" <= "capCount")
    AND ("capAmount" IS NULL OR "consumedAmount" <= "capAmount")
  );

ALTER TABLE "restaurant_promotion_cap_reservations"
  ADD CONSTRAINT "promo_cap_res_non_negative" CHECK ("reservedCount" >= 0 AND "reservedAmount" >= 0),
  ADD CONSTRAINT "promo_cap_res_ordinal_non_negative" CHECK ("applicationOrdinal" >= 0),
  ADD CONSTRAINT "promo_cap_res_settlement_evidence" CHECK (
    ("state" <> 'CONSUMED' OR "settledAt" IS NOT NULL)
    AND ("state" <> 'RELEASED' OR "releasedAt" IS NOT NULL)
  );

-- I3 §3.1/§5.2 immutability.
CREATE FUNCTION reject_promotion_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'promotion evidence is append-only' USING ERRCODE = '55000'; END; $$;

CREATE FUNCTION guard_promotion_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only drafts update or delete. The publish and supersede transitions are the
  -- two exceptions, and each may only move the row FORWARD along the lifecycle.
  IF OLD."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published promotion version cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED'
     AND NEW."ruleHash" = OLD."ruleHash" AND NEW."versionNumber" = OLD."versionNumber"
     AND NEW."effectiveFrom" = OLD."effectiveFrom" AND NEW."promotionId" = OLD."promotionId"
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'published promotion version is immutable' USING ERRCODE = '55000';
END; $$;

CREATE FUNCTION guard_promotion_component_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status "RestaurantPromotionVersionStatus";
BEGIN
  SELECT v."status" INTO parent_status FROM "restaurant_promotion_versions" v
   WHERE v."organizationId" = OLD."organizationId" AND v."id" = OLD."promotionVersionId";
  -- A vanished parent means the cascade is running; let it through.
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF;
  IF parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'published promotion rule component is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$;

-- I5 §6: the ledger is append-only apart from the two legal settlements.
CREATE FUNCTION guard_promotion_reservation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'promotion cap reservation is append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD."state" <> 'RESERVED' THEN
    RAISE EXCEPTION 'promotion cap reservation is already settled' USING ERRCODE = '55000';
  END IF;
  IF NEW."state" NOT IN ('CONSUMED', 'RELEASED') THEN
    RAISE EXCEPTION 'illegal promotion cap reservation transition' USING ERRCODE = '55000';
  END IF;
  -- Settlement moves the state only; it can never restate the amount it holds.
  IF NEW."counterId" <> OLD."counterId" OR NEW."evaluationId" <> OLD."evaluationId"
     OR NEW."promotionVersionId" <> OLD."promotionVersionId"
     OR NEW."scopeKind" <> OLD."scopeKind" OR NEW."scopeKey" <> OLD."scopeKey"
     OR NEW."applicationOrdinal" <> OLD."applicationOrdinal"
     OR NEW."reservedCount" <> OLD."reservedCount" OR NEW."reservedAmount" <> OLD."reservedAmount"
  THEN
    RAISE EXCEPTION 'promotion cap reservation payload is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$;

-- I6 §10: same-tenant integrity for the scalar order/bill/branch references.
-- The lookups run as the CALLING role under its own RLS, so a cross-tenant id
-- is simply invisible and the insert fails closed with a foreign-key error.
CREATE FUNCTION guard_promotion_evaluation_refs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "restaurant_orders" o
                  WHERE o."id" = NEW."orderId" AND o."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'promotion evaluation order must belong to the same organization' USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "restaurant_branches" b
                  WHERE b."id" = NEW."branchId" AND b."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'promotion evaluation branch must belong to the same organization' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION guard_promotion_bill_application_refs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "restaurant_bills" b
                  WHERE b."id" = NEW."billId" AND b."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'promotion bill application bill must belong to the same organization' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "promo_version_immutable"
  BEFORE UPDATE OR DELETE ON "restaurant_promotion_versions"
  FOR EACH ROW EXECUTE FUNCTION guard_promotion_version_mutation();
CREATE TRIGGER "promo_component_immutable"
  BEFORE UPDATE OR DELETE ON "restaurant_promotion_rule_components"
  FOR EACH ROW EXECUTE FUNCTION guard_promotion_component_mutation();
CREATE TRIGGER "promo_eval_immutable"
  BEFORE UPDATE OR DELETE ON "restaurant_promotion_evaluation_snapshots"
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_immutable_mutation();
CREATE TRIGGER "promo_candidate_immutable"
  BEFORE UPDATE OR DELETE ON "restaurant_promotion_candidate_snapshots"
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_immutable_mutation();
CREATE TRIGGER "promo_app_immutable"
  BEFORE UPDATE OR DELETE ON "restaurant_promotion_application_snapshots"
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_immutable_mutation();
CREATE TRIGGER "promo_alloc_immutable"
  BEFORE UPDATE OR DELETE ON "restaurant_promotion_unit_allocations"
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_immutable_mutation();
CREATE TRIGGER "promo_bill_app_immutable"
  BEFORE UPDATE OR DELETE ON "restaurant_promotion_bill_application_snapshots"
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_immutable_mutation();
CREATE TRIGGER "promo_audit_immutable"
  BEFORE UPDATE OR DELETE ON "restaurant_promotion_audit_events"
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_immutable_mutation();
CREATE TRIGGER "promo_cap_res_transition"
  BEFORE UPDATE OR DELETE ON "restaurant_promotion_cap_reservations"
  FOR EACH ROW EXECUTE FUNCTION guard_promotion_reservation_transition();
CREATE TRIGGER "promo_eval_tenant_refs"
  BEFORE INSERT ON "restaurant_promotion_evaluation_snapshots"
  FOR EACH ROW EXECUTE FUNCTION guard_promotion_evaluation_refs();
CREATE TRIGGER "promo_bill_app_tenant_refs"
  BEFORE INSERT ON "restaurant_promotion_bill_application_snapshots"
  FOR EACH ROW EXECUTE FUNCTION guard_promotion_bill_application_refs();

-- I7 §10 forced RLS, failing closed without app.current_organization_id.
ALTER TABLE "restaurant_promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_promotions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_promotion_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotion_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_promotion_versions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_promotion_rule_components" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotion_rule_components" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_promotion_rule_components" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_promotion_cap_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotion_cap_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_promotion_cap_counters" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- The reservation ledger: SELECT + INSERT + UPDATE (the guarded settlement
-- transition), never DELETE.
ALTER TABLE "restaurant_promotion_cap_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotion_cap_reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_promotion_cap_reservations" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_promotion_cap_reservations" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_update" ON "restaurant_promotion_cap_reservations" FOR UPDATE USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- §5.2 the six append-only evidence tables: SELECT + INSERT policies ONLY, so
-- UPDATE/DELETE match zero rows for the app role even before the trigger fires.
ALTER TABLE "restaurant_promotion_evaluation_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotion_evaluation_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_promotion_evaluation_snapshots" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_promotion_evaluation_snapshots" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_promotion_candidate_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotion_candidate_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_promotion_candidate_snapshots" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_promotion_candidate_snapshots" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_promotion_application_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotion_application_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_promotion_application_snapshots" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_promotion_application_snapshots" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_promotion_unit_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotion_unit_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_promotion_unit_allocations" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_promotion_unit_allocations" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_promotion_bill_application_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotion_bill_application_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_promotion_bill_application_snapshots" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_promotion_bill_application_snapshots" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_promotion_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_promotion_audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_promotion_audit_events" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_promotion_audit_events" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
