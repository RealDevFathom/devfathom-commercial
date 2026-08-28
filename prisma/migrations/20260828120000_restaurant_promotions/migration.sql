-- WHA-288 Promotions Lane A — the time-boxed checkout discount layer.
--
-- Additive only. No existing table, column, constraint, index, policy or trigger
-- is altered or dropped: price-list, tax, loyalty and insight semantics are
-- untouched, and no existing RLS policy is weakened. The CreateTable/CreateIndex/
-- AddForeignKey block below is the datamodel's own DDL (prisma migrate diff), so
-- schema and database stay drift-free; everything after it is the part Prisma
-- cannot express — CHECK invariants, the immutability triggers, and the forced
-- tenant RLS every restaurant table carries.

-- CreateEnum
CREATE TYPE "RestaurantPromotionTargetScope" AS ENUM ('ORDER', 'CATEGORY', 'PRODUCT');

-- CreateEnum
CREATE TYPE "RestaurantPromotionBenefitKind" AS ENUM ('PERCENTAGE_OFF', 'AMOUNT_OFF', 'FIXED_PRICE', 'FREE_ITEM', 'BUY_X_GET_Y');

-- CreateEnum
CREATE TYPE "RestaurantPromotionAuthority" AS ENUM ('AUTOMATIC', 'CUSTOMER_CODE', 'MANAGER_OVERRIDE');

-- CreateEnum
CREATE TYPE "RestaurantPromotionCapScope" AS ENUM ('PER_ORDER', 'PER_GUEST', 'TOTAL');

-- CreateEnum
CREATE TYPE "RestaurantPromotionStackingMode" AS ENUM ('EXCLUSIVE', 'STACKABLE');

-- CreateTable
CREATE TABLE "restaurant_promotions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "code" TEXT,
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
    "ruleCode" TEXT NOT NULL,
    "status" "RestaurantVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "startMinuteOfDay" INTEGER,
    "endMinuteOfDay" INTEGER,
    "dayMask" INTEGER NOT NULL DEFAULT 127,
    "targetScope" "RestaurantPromotionTargetScope" NOT NULL DEFAULT 'ORDER',
    "benefitKind" "RestaurantPromotionBenefitKind" NOT NULL,
    "benefitRate" DECIMAL(9,6),
    "benefitAmount" DECIMAL(12,2),
    "buyQuantity" INTEGER,
    "getQuantity" INTEGER,
    "minimumSubtotal" DECIMAL(12,2),
    "minimumItemQuantity" INTEGER,
    "maximumDiscountAmount" DECIMAL(12,2),
    "stacking" "RestaurantPromotionStackingMode" NOT NULL DEFAULT 'EXCLUSIVE',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_promotion_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_targets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "promotionVersionId" TEXT NOT NULL,
    "productId" TEXT,
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_channels" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "promotionVersionId" TEXT NOT NULL,
    "channel" "RestaurantOrderChannel" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_branches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "promotionVersionId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_caps" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "promotionVersionId" TEXT NOT NULL,
    "scope" "RestaurantPromotionCapScope" NOT NULL,
    "maxRedemptions" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_caps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_applications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "promotionId" TEXT NOT NULL,
    "promotionVersionId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "promotionCode" TEXT,
    "targetScope" "RestaurantPromotionTargetScope" NOT NULL,
    "benefitKind" "RestaurantPromotionBenefitKind" NOT NULL,
    "benefitRate" DECIMAL(9,6),
    "benefitAmount" DECIMAL(12,2),
    "authority" "RestaurantPromotionAuthority" NOT NULL,
    "authorizedByStaffProfileId" TEXT,
    "orderId" TEXT NOT NULL,
    "billId" TEXT,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT,
    "businessDate" DATE NOT NULL,
    "sequence" INTEGER NOT NULL,
    "discountAmount" DECIMAL(12,2) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_promotion_redemptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "promotionVersionId" TEXT NOT NULL,
    "capScope" "RestaurantPromotionCapScope" NOT NULL,
    "capKey" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "applicationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_promotion_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_promotions_organizationId_idx" ON "restaurant_promotions"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_promotions_organizationId_code_key" ON "restaurant_promotions"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_promotions_organizationId_id_key" ON "restaurant_promotions"("organizationId", "id");

-- CreateIndex
CREATE INDEX "restaurant_promotion_versions_organizationId_idx" ON "restaurant_promotion_versions"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_versions_promotionId_idx" ON "restaurant_promotion_versions"("promotionId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_versions_status_effectiveFrom_idx" ON "restaurant_promotion_versions"("status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_promotion_versions_promotionId_versionNumber_key" ON "restaurant_promotion_versions"("promotionId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_promotion_versions_organizationId_id_key" ON "restaurant_promotion_versions"("organizationId", "id");

-- CreateIndex
CREATE INDEX "restaurant_promotion_targets_organizationId_idx" ON "restaurant_promotion_targets"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_targets_promotionVersionId_idx" ON "restaurant_promotion_targets"("promotionVersionId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_targets_productId_idx" ON "restaurant_promotion_targets"("productId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_targets_categoryId_idx" ON "restaurant_promotion_targets"("categoryId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_channels_organizationId_idx" ON "restaurant_promotion_channels"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_promotion_channels_promotionVersionId_channel_key" ON "restaurant_promotion_channels"("promotionVersionId", "channel");

-- CreateIndex
CREATE INDEX "restaurant_promotion_branches_organizationId_idx" ON "restaurant_promotion_branches"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_branches_branchId_idx" ON "restaurant_promotion_branches"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_promotion_branches_promotionVersionId_branchId_key" ON "restaurant_promotion_branches"("promotionVersionId", "branchId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_caps_organizationId_idx" ON "restaurant_promotion_caps"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_promotion_caps_promotionVersionId_scope_key" ON "restaurant_promotion_caps"("promotionVersionId", "scope");

-- CreateIndex
CREATE INDEX "restaurant_promotion_applications_organizationId_idx" ON "restaurant_promotion_applications"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_applications_promotionVersionId_idx" ON "restaurant_promotion_applications"("promotionVersionId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_applications_orderId_idx" ON "restaurant_promotion_applications"("orderId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_applications_billId_idx" ON "restaurant_promotion_applications"("billId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_applications_branchId_businessDate_idx" ON "restaurant_promotion_applications"("branchId", "businessDate");

-- CreateIndex
CREATE INDEX "restaurant_promotion_applications_customerId_idx" ON "restaurant_promotion_applications"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_promotion_applications_orderId_sequence_key" ON "restaurant_promotion_applications"("orderId", "sequence");

-- CreateIndex
CREATE INDEX "restaurant_promotion_redemptions_organizationId_idx" ON "restaurant_promotion_redemptions"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_promotion_redemptions_applicationId_idx" ON "restaurant_promotion_redemptions"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_promotion_redemptions_promotionVersionId_capScop_key" ON "restaurant_promotion_redemptions"("promotionVersionId", "capScope", "capKey", "ordinal");

-- AddForeignKey
ALTER TABLE "restaurant_promotion_versions" ADD CONSTRAINT "restaurant_promotion_version_promotion_fkey" FOREIGN KEY ("organizationId", "promotionId") REFERENCES "restaurant_promotions"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_targets" ADD CONSTRAINT "restaurant_promotion_target_version_fkey" FOREIGN KEY ("organizationId", "promotionVersionId") REFERENCES "restaurant_promotion_versions"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_targets" ADD CONSTRAINT "restaurant_promotion_target_product_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_targets" ADD CONSTRAINT "restaurant_promotion_target_category_fkey" FOREIGN KEY ("categoryId") REFERENCES "restaurant_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_channels" ADD CONSTRAINT "restaurant_promotion_channel_version_fkey" FOREIGN KEY ("organizationId", "promotionVersionId") REFERENCES "restaurant_promotion_versions"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_branches" ADD CONSTRAINT "restaurant_promotion_branch_version_fkey" FOREIGN KEY ("organizationId", "promotionVersionId") REFERENCES "restaurant_promotion_versions"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_branches" ADD CONSTRAINT "restaurant_promotion_branch_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_caps" ADD CONSTRAINT "restaurant_promotion_cap_version_fkey" FOREIGN KEY ("organizationId", "promotionVersionId") REFERENCES "restaurant_promotion_versions"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_applications" ADD CONSTRAINT "restaurant_promotion_application_promotion_fkey" FOREIGN KEY ("organizationId", "promotionId") REFERENCES "restaurant_promotions"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_applications" ADD CONSTRAINT "restaurant_promotion_application_version_fkey" FOREIGN KEY ("organizationId", "promotionVersionId") REFERENCES "restaurant_promotion_versions"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_applications" ADD CONSTRAINT "restaurant_promotion_application_order_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_applications" ADD CONSTRAINT "restaurant_promotion_application_bill_fkey" FOREIGN KEY ("billId") REFERENCES "restaurant_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_applications" ADD CONSTRAINT "restaurant_promotion_application_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_redemptions" ADD CONSTRAINT "restaurant_promotion_redemption_version_fkey" FOREIGN KEY ("organizationId", "promotionVersionId") REFERENCES "restaurant_promotion_versions"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_promotion_redemptions" ADD CONSTRAINT "restaurant_promotion_redemption_application_fkey" FOREIGN KEY ("applicationId") REFERENCES "restaurant_promotion_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK invariants (not expressible in the Prisma datamodel).
-- ---------------------------------------------------------------------------

ALTER TABLE "restaurant_promotion_versions"
  ADD CONSTRAINT "promotion_version_effective_range" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
  -- A daily window is both-or-neither; start > end is legal and wraps midnight.
  ADD CONSTRAINT "promotion_version_daily_window_pair" CHECK (("startMinuteOfDay" IS NULL) = ("endMinuteOfDay" IS NULL)),
  ADD CONSTRAINT "promotion_version_daily_window_range" CHECK (
    ("startMinuteOfDay" IS NULL OR ("startMinuteOfDay" >= 0 AND "startMinuteOfDay" <= 1439))
    AND ("endMinuteOfDay" IS NULL OR ("endMinuteOfDay" >= 0 AND "endMinuteOfDay" <= 1439))
  ),
  -- A 7-bit mask with at least one day set; 0 would be an unreachable rule.
  ADD CONSTRAINT "promotion_version_day_mask" CHECK ("dayMask" >= 1 AND "dayMask" <= 127),
  -- Each benefit kind carries exactly the operands it uses, and no others.
  ADD CONSTRAINT "promotion_version_benefit_operands" CHECK (
    CASE "benefitKind"
      WHEN 'PERCENTAGE_OFF' THEN "benefitRate" IS NOT NULL AND "benefitAmount" IS NULL AND "buyQuantity" IS NULL AND "getQuantity" IS NULL
      WHEN 'AMOUNT_OFF' THEN "benefitAmount" IS NOT NULL AND "benefitRate" IS NULL AND "buyQuantity" IS NULL AND "getQuantity" IS NULL
      WHEN 'FIXED_PRICE' THEN "benefitAmount" IS NOT NULL AND "benefitRate" IS NULL AND "buyQuantity" IS NULL AND "getQuantity" IS NULL
      WHEN 'FREE_ITEM' THEN "getQuantity" IS NOT NULL AND "buyQuantity" IS NULL AND "benefitRate" IS NULL AND "benefitAmount" IS NULL
      WHEN 'BUY_X_GET_Y' THEN "buyQuantity" IS NOT NULL AND "getQuantity" IS NOT NULL AND "benefitRate" IS NULL AND "benefitAmount" IS NULL
    END
  ),
  ADD CONSTRAINT "promotion_version_benefit_rate_range" CHECK ("benefitRate" IS NULL OR ("benefitRate" >= 0 AND "benefitRate" <= 1)),
  ADD CONSTRAINT "promotion_version_benefit_amount_sign" CHECK ("benefitAmount" IS NULL OR "benefitAmount" >= 0),
  ADD CONSTRAINT "promotion_version_quantities" CHECK (
    ("buyQuantity" IS NULL OR "buyQuantity" >= 1) AND ("getQuantity" IS NULL OR "getQuantity" >= 1)
  ),
  ADD CONSTRAINT "promotion_version_minimums" CHECK (
    ("minimumSubtotal" IS NULL OR "minimumSubtotal" >= 0)
    AND ("minimumItemQuantity" IS NULL OR "minimumItemQuantity" >= 1)
    AND ("maximumDiscountAmount" IS NULL OR "maximumDiscountAmount" >= 0)
  ),
  -- The lifecycle timestamps must agree with the recorded status: a version that
  -- never activated cannot be superseded.
  ADD CONSTRAINT "promotion_version_lifecycle" CHECK (
    CASE "status"
      WHEN 'DRAFT' THEN "activatedAt" IS NULL AND "supersededAt" IS NULL
      WHEN 'ACTIVE' THEN "activatedAt" IS NOT NULL AND "supersededAt" IS NULL
      WHEN 'SUPERSEDED' THEN "activatedAt" IS NOT NULL AND "supersededAt" IS NOT NULL
    END
  );

ALTER TABLE "restaurant_promotion_targets"
  ADD CONSTRAINT "promotion_target_exactly_one" CHECK (("productId" IS NULL) <> ("categoryId" IS NULL));

ALTER TABLE "restaurant_promotion_caps"
  ADD CONSTRAINT "promotion_cap_max_positive" CHECK ("maxRedemptions" >= 1);

ALTER TABLE "restaurant_promotion_applications"
  ADD CONSTRAINT "promotion_application_sequence_positive" CHECK ("sequence" >= 1),
  -- A discount is a non-negative reduction; a promotion never adds money.
  ADD CONSTRAINT "promotion_application_discount_sign" CHECK ("discountAmount" >= 0),
  -- A manager override always names the operator who authorized it; the
  -- automatic and code paths never carry one.
  ADD CONSTRAINT "promotion_application_override_operator" CHECK (
    ("authority" = 'MANAGER_OVERRIDE') = ("authorizedByStaffProfileId" IS NOT NULL)
  ),
  -- The code path always snapshots the code that was presented.
  ADD CONSTRAINT "promotion_application_code_present" CHECK (
    "authority" <> 'CUSTOMER_CODE' OR "promotionCode" IS NOT NULL
  ),
  ADD CONSTRAINT "promotion_application_rate_range" CHECK ("benefitRate" IS NULL OR ("benefitRate" >= 0 AND "benefitRate" <= 1));

ALTER TABLE "restaurant_promotion_redemptions"
  ADD CONSTRAINT "promotion_redemption_ordinal_positive" CHECK ("ordinal" >= 1);

-- ---------------------------------------------------------------------------
-- Immutability. Applications and cap claims are financial history; an activated
-- promotion version and everything it owns are frozen.
-- ---------------------------------------------------------------------------

CREATE FUNCTION reject_promotion_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'promotion record is immutable' USING ERRCODE = '55000'; END; $$;

-- The DRAFT -> ACTIVE -> SUPERSEDED lifecycle transitions are the ONLY permitted
-- updates once a version leaves DRAFT, and they may not carry a rule edit along
-- with them: every rule column must be unchanged.
CREATE FUNCTION guard_promotion_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'activated promotion version is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED'
     AND NEW."id" = OLD."id" AND NEW."promotionId" = OLD."promotionId"
     AND NEW."versionNumber" = OLD."versionNumber" AND NEW."ruleCode" = OLD."ruleCode"
     AND NEW."effectiveFrom" = OLD."effectiveFrom" AND NEW."effectiveTo" IS NOT DISTINCT FROM OLD."effectiveTo"
     AND NEW."dayMask" = OLD."dayMask"
     AND NEW."startMinuteOfDay" IS NOT DISTINCT FROM OLD."startMinuteOfDay"
     AND NEW."endMinuteOfDay" IS NOT DISTINCT FROM OLD."endMinuteOfDay"
     AND NEW."targetScope" = OLD."targetScope" AND NEW."benefitKind" = OLD."benefitKind"
     AND NEW."benefitRate" IS NOT DISTINCT FROM OLD."benefitRate"
     AND NEW."benefitAmount" IS NOT DISTINCT FROM OLD."benefitAmount"
     AND NEW."buyQuantity" IS NOT DISTINCT FROM OLD."buyQuantity"
     AND NEW."getQuantity" IS NOT DISTINCT FROM OLD."getQuantity"
     AND NEW."minimumSubtotal" IS NOT DISTINCT FROM OLD."minimumSubtotal"
     AND NEW."minimumItemQuantity" IS NOT DISTINCT FROM OLD."minimumItemQuantity"
     AND NEW."maximumDiscountAmount" IS NOT DISTINCT FROM OLD."maximumDiscountAmount"
     AND NEW."stacking" = OLD."stacking" AND NEW."priority" = OLD."priority"
     AND NEW."activatedAt" = OLD."activatedAt"
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'activated promotion version is immutable' USING ERRCODE = '55000';
END; $$;

-- Targets, channels, branch scopes and caps follow their version's freeze: once
-- the version is ACTIVE they can be neither added, edited nor removed.
CREATE FUNCTION guard_promotion_version_child_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status "RestaurantVersionStatus";
BEGIN
  SELECT v."status" INTO parent_status FROM "restaurant_promotion_versions" v
   WHERE v."id" = COALESCE(NEW."promotionVersionId", OLD."promotionVersionId");
  IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'activated promotion version is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$;

CREATE TRIGGER promotion_version_immutable BEFORE UPDATE OR DELETE ON "restaurant_promotion_versions"
  FOR EACH ROW EXECUTE FUNCTION guard_promotion_version_mutation();
CREATE TRIGGER promotion_target_frozen BEFORE INSERT OR UPDATE OR DELETE ON "restaurant_promotion_targets"
  FOR EACH ROW EXECUTE FUNCTION guard_promotion_version_child_mutation();
CREATE TRIGGER promotion_channel_frozen BEFORE INSERT OR UPDATE OR DELETE ON "restaurant_promotion_channels"
  FOR EACH ROW EXECUTE FUNCTION guard_promotion_version_child_mutation();
CREATE TRIGGER promotion_branch_frozen BEFORE INSERT OR UPDATE OR DELETE ON "restaurant_promotion_branches"
  FOR EACH ROW EXECUTE FUNCTION guard_promotion_version_child_mutation();
CREATE TRIGGER promotion_cap_frozen BEFORE INSERT OR UPDATE OR DELETE ON "restaurant_promotion_caps"
  FOR EACH ROW EXECUTE FUNCTION guard_promotion_version_child_mutation();
CREATE TRIGGER promotion_application_immutable BEFORE UPDATE OR DELETE ON "restaurant_promotion_applications"
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_immutable_mutation();
CREATE TRIGGER promotion_redemption_immutable BEFORE UPDATE OR DELETE ON "restaurant_promotion_redemptions"
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_immutable_mutation();

-- ---------------------------------------------------------------------------
-- Forced tenant RLS, identical in shape to every other restaurant table.
-- ---------------------------------------------------------------------------

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['restaurant_promotions','restaurant_promotion_versions','restaurant_promotion_targets',
                           'restaurant_promotion_channels','restaurant_promotion_branches','restaurant_promotion_caps',
                           'restaurant_promotion_applications','restaurant_promotion_redemptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))', t || '_tenant', t);
  END LOOP;
END $$;
