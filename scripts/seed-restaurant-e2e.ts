import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { hashSync } from 'bcryptjs';
import 'dotenv/config';
import pg from 'pg';

import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import {
  seedRestaurantDemoControlPlane,
  seedRestaurantDemoTenant,
} from './seed-restaurant-demo.js';
import { seedRestaurantInsightsCompletionFixtures } from './seed-restaurant-insights-completion-fixtures.js';
import {
  BACK_OFFICE_STOCK,
  BACK_OFFICE_STOCK_OWNED_FIXTURES,
  RECIPE_PROFITABILITY_OWNED_FIXTURES,
  seedBackOfficeStockFixture,
  seedRecipeProfitabilityFixture,
} from './seed-restaurant-acceptance-fixtures.js';
import {
  roleTemplatesForVertical,
  adminDepartmentKeyForVertical,
  defaultDepartmentRowsForVertical,
} from '../src/lib/vertical-catalog.js';
import { businessDateToUtcDate, resolveBusinessDate } from '../src/lib/restaurant/business-date.js';
import {
  RESTAURANT_E2E_BRANCH_COUNT,
  RESTAURANT_E2E_ASCII_RECEIPT_DEVICE_SECRET,
  RESTAURANT_E2E_REVOKED_BRIDGE_DEVICE_SECRET,
  resolveRestaurantE2eDatabaseUrl,
} from './restaurant-e2e-database.js';

export const RESTAURANT_E2E = {
  organizationId: 'org_chai_chowk',
  branchId: 'branch_restaurant_e2e',
  branchA2Id: 'branch_restaurant_e2e_a2',
  posDeviceId: 'device_restaurant_e2e_pos',
  kdsDeviceId: 'device_restaurant_e2e_kds',
  deliveryPosDeviceId: 'device_restaurant_e2e_delivery_pos',
  deliveryKdsDeviceId: 'device_restaurant_e2e_delivery_kds',
  deliveryOperatorId: 'staff_restaurant_e2e_delivery_operator',
  deliveryDeniedOperatorId: 'staff_restaurant_e2e_delivery_capability_denied',
  operatorId: 'staff_restaurant_e2e_operator',
  deniedOperatorId: 'staff_restaurant_e2e_delivery_denied',
  managerId: 'staff_restaurant_e2e_manager',
  operatorPin: '424242',
  deniedOperatorPin: '626262',
  managerPin: '848484',
  posDeviceSecret: 'rdk_restaurant_e2e_pos_local_ci_only',
  kdsDeviceSecret: 'rdk_restaurant_e2e_kds_local_ci_only',
  deliveryPosDeviceSecret: 'rdk_restaurant_e2e_delivery_pos_local_ci_only',
  deliveryKdsDeviceSecret: 'rdk_restaurant_e2e_delivery_kds_local_ci_only',
  deliveryOperatorPin: '737373',
  deliveryDeniedOperatorPin: '515151',
  /**
   * WHA-1542 — one enrolled register (and one kitchen display) per acceptance
   * case that binds an operator.
   *
   * `POST /api/restaurant/terminal/unlock` fronts the durable credential lockout
   * with a burst gate keyed `terminal:cred:<deviceId>:<staffProfileId>`, 10 per
   * 60 s fixed window (src/app/api/restaurant/terminal/unlock/route.ts). That key
   * carries NO client address, so presenting a distinct `x-forwarded-for` per
   * case — which is what the pre-auth gate in `terminal-auth.ts` keys on — cannot
   * relieve it. A serial lane that unlocks ONE seeded register with ONE operator
   * spends that bucket inside a minute, and every later case is refused 429 from
   * `establishTerminal`, which surfaces as an unrelated-looking assertion failure.
   *
   * A room of real tablets is a room of separate enrolments, so the fixture
   * enrols one register per case. The guard itself is untouched — same limit,
   * window and key — and each enrolment still gets only its own ten attempts.
   *
   * Only the REGISTER is pooled. The seeded kitchen display binds an operator
   * twice across the whole corpus (the two KDS tablet cases), which is inside
   * one bucket. The count is held below `pos.registeredDevices.max` (25 for this
   * package) so the fixture cannot put the tenant over its own device licence:
   * 6 shipped enrolments + 12 here = 18.
   */
  caseTerminalCount: 12,
} as const;

/** The per-case register enrolment for a zero-based case index. */
export function caseRegisterDevice(index: number) {
  return {
    deviceId: `device_restaurant_e2e_pos_case_${index}`,
    secret: `rdk_restaurant_e2e_pos_case_${index}_local_ci_only`,
  };
}

const CASE_TERMINAL_INDEXES = Array.from(
  { length: RESTAURANT_E2E.caseTerminalCount },
  (_unused, index) => index
);

/**
 * Branches this fixture creates: `branchId`, `branchA2Id` and WHA-1567's
 * ASCII-receipt branch. The seeded `restaurant.locations.max` is held equal to
 * it so the tenant is licensed for exactly what it owns and no more.
 */

/** `AUDIT_EVIDENCE_RETENTION_DAYS` in src/lib/module-catalog.ts. */
const SOP_EVIDENCE_RETENTION_DAYS = 365;

const IDS = {
  reportsOperationalUser: 'user_restaurant_e2e_reports_operational',
  reportsOperationalRole: 'role_restaurant_e2e_reports_operational',
  reportsOperationalStaff: 'staff_restaurant_e2e_reports_operational',
  alexUser: 'user_chai_chowk_alex',
  alexStaff: 'staff_chai_chowk_alex',
  operatorUser: 'user_restaurant_e2e_operator',
  deniedOperatorUser: 'user_restaurant_e2e_delivery_denied',
  managerUser: 'user_restaurant_e2e_manager',
  deliveryOperatorUser: 'user_restaurant_e2e_delivery_operator',
  deliveryDeniedOperatorUser: 'user_restaurant_e2e_delivery_capability_denied',
  locationsLimit: 'limit_restaurant_e2e_locations',
  sopEvidenceRetentionLimit: 'limit_restaurant_e2e_sop_evidence_retention',
  operatorRole: 'role_restaurant_e2e_operator',
  deniedOperatorRole: 'role_restaurant_e2e_delivery_denied',
  managerRole: 'role_restaurant_e2e_manager',
  operatorCredential: 'credential_restaurant_e2e_operator',
  deniedOperatorCredential: 'credential_restaurant_e2e_delivery_denied',
  managerCredential: 'credential_restaurant_e2e_manager',
  deliveryOperatorCredential: 'credential_restaurant_e2e_delivery_operator',
  deliveryDeniedOperatorCredential: 'credential_restaurant_e2e_delivery_capability_denied',
  drawer: 'drawer_restaurant_e2e',
  grillStation: 'station_restaurant_e2e_grill',
  expoStation: 'station_restaurant_e2e_expo',
  deliveryStation: 'station_restaurant_e2e_delivery',
  brand: 'brand_restaurant_e2e',
  category: 'category_restaurant_e2e_mains',
  product: 'product_restaurant_e2e_burger',
  priceList: 'price_list_restaurant_e2e',
  priceVersion: 'price_version_restaurant_e2e_v1',
  priceEntry: 'price_entry_restaurant_e2e_burger',
  menu: 'menu_restaurant_e2e',
  menuSection: 'menu_section_restaurant_e2e_mains',
  menuItem: 'menu_item_restaurant_e2e_burger',
  publication: 'menu_publication_restaurant_e2e',
  deliveryPublication: 'menu_publication_restaurant_e2e_delivery',
  availability: 'availability_restaurant_e2e_always',
  deliveryAvailability: 'availability_restaurant_e2e_delivery_always',
  routingRule: 'routing_restaurant_e2e_burger',
  deliveryRoutingRule: 'routing_restaurant_e2e_delivery_burger',
  customer: 'customer_restaurant_e2e',
  customerAddress: 'customer_address_restaurant_e2e',
  deliveryZone: 'delivery_zone_restaurant_e2e',
  isolatedDeliveryZone: 'delivery_zone_restaurant_e2e_isolated',
  deliveryTaxSource: 'tax_source_restaurant_e2e_delivery',
  deliveryTaxProfile: 'tax_profile_restaurant_e2e_delivery',
  deliveryTaxRuleCash: 'tax_rule_restaurant_e2e_delivery_cash',
  deliveryTaxRuleCard: 'tax_rule_restaurant_e2e_delivery_card',
  deliveryTaxRuleOther: 'tax_rule_restaurant_e2e_delivery_other',
  coreTaxProfile: 'tax_profile_restaurant_e2e_core',
  coreTaxRuleCash: 'tax_rule_restaurant_e2e_core_cash',
  coreTaxRuleCard: 'tax_rule_restaurant_e2e_core_card',
  coreTaxRuleOther: 'tax_rule_restaurant_e2e_core_other',
  loyaltyProgram: 'loyalty_program_restaurant_e2e_v1',
  loyaltyAccount: 'loyalty_account_restaurant_e2e',
  loyaltyEntry: 'loyalty_entry_restaurant_e2e_opening',
  floor: 'floor_restaurant_e2e_a1',
  table: 'table_restaurant_e2e_a1_12',
  modifierGroup: 'modifier_group_restaurant_e2e_heat',
  modifierOption: 'modifier_option_restaurant_e2e_spicy',
  productModifier: 'product_modifier_restaurant_e2e_heat',
  unit: 'unit_restaurant_e2e_each',
  ingredient: 'ingredient_restaurant_e2e_bun',
  recipe: 'recipe_restaurant_e2e_burger',
  recipeVersion: 'recipe_version_restaurant_e2e_burger_v1',
  recipeLine: 'recipe_line_restaurant_e2e_bun',
  sopTemplate: 'sop_template_restaurant_e2e_opening',
  sopVersion: 'sop_version_restaurant_e2e_opening_v1',
  sopStep: 'sop_step_restaurant_e2e_opening_1',
  sopAssignment: 'sop_assignment_restaurant_e2e_opening',
  sopOccurrence: 'sop_occurrence_restaurant_e2e_opening',
  sopOccurrenceStep: 'sop_occurrence_step_restaurant_e2e_opening_1',
  revokedBridgeDevice: 'device_restaurant_e2e_print_bridge_revoked',
  // WHA-1567 — the isolated ASCII-printable receipt branch. Both shipped E2E
  // branches are named with an 'é', and `validateRawPrintDocument` rejects any
  // receipt fact outside [\x20-\x7e\n], so `facts.businessName` (which is
  // `bill.branch.name`) made EVERY queued receipt a 422 in this tenant. That
  // validation is correct and is left alone; queued-receipt acceptance gets a
  // branch whose name is ASCII instead.
  asciiReceiptBranch: 'branch_restaurant_e2e_ascii_receipt',
  asciiReceiptStation: 'station_restaurant_e2e_ascii_receipt_main',
  asciiReceiptPublication: 'menu_publication_restaurant_e2e_ascii_receipt',
  asciiReceiptAvailability: 'availability_restaurant_e2e_ascii_receipt_always',
  asciiReceiptDevice: 'device_restaurant_e2e_ascii_receipt_pos',
  asciiReceiptUser: 'user_restaurant_e2e_ascii_receipt_operator',
  asciiReceiptStaffProfile: 'staff_restaurant_e2e_ascii_receipt_operator',
  asciiReceiptCredential: 'credential_restaurant_e2e_ascii_receipt_operator',
  asciiReceiptTaxProfile: 'tax_profile_restaurant_e2e_ascii_receipt',
  asciiReceiptTaxRuleCash: 'tax_rule_restaurant_e2e_ascii_receipt_cash',
  asciiReceiptTaxRuleCard: 'tax_rule_restaurant_e2e_ascii_receipt_card',
  asciiReceiptTaxRuleOther: 'tax_rule_restaurant_e2e_ascii_receipt_other',
} as const;

/** ASCII-printable on purpose: the accent is exactly what this branch removes. */
const ASCII_RECEIPT_BRANCH_NAME = 'Gulberg Cafe Receipt Lab';
const ASCII_RECEIPT_OPERATOR_NAME = 'E2E ASCII Receipt Operator';
const ASCII_RECEIPT_OPERATOR_EMAIL = 'ascii-receipt-operator@restaurant-e2e.test';
const ASCII_RECEIPT_OPERATOR_PIN = '353535';

export const RESTAURANT_E2E_OWNED_FIXTURES = [
  ['organizations', [RESTAURANT_E2E.organizationId]],
  ['organization_limits', [IDS.locationsLimit, IDS.sopEvidenceRetentionLimit]],
  [
    'organization_departments',
    ['department_restaurant_e2e_kitchen', 'department_restaurant_e2e_front_of_house'],
  ],
  [
    'organization_roles',
    [IDS.operatorRole, IDS.deniedOperatorRole, IDS.managerRole, IDS.reportsOperationalRole],
  ],
  [
    'organization_role_permissions',
    [
      'permission_restaurant_e2e_operator_0',
      'permission_restaurant_e2e_operator_1',
      'permission_restaurant_e2e_operator_2',
      'permission_restaurant_e2e_operator_3',
      'permission_restaurant_e2e_operator_4',
      'permission_restaurant_e2e_operator_5',
      'permission_restaurant_e2e_operator_6',
      'permission_restaurant_e2e_delivery_denied',
      'permission_restaurant_e2e_manager_all',
      'permission_restaurant_e2e_reports_operational',
    ],
  ],
  [
    'users',
    [
      IDS.reportsOperationalUser,
      IDS.alexUser,
      IDS.operatorUser,
      IDS.deniedOperatorUser,
      IDS.managerUser,
      IDS.deliveryOperatorUser,
      IDS.deliveryDeniedOperatorUser,
      IDS.asciiReceiptUser,
    ],
  ],
  [
    'restaurant_branch_assignments',
    [
      `assignment_${IDS.reportsOperationalUser}`,
      `assignment_${IDS.alexUser}`,
      `assignment_${IDS.operatorUser}`,
      `assignment_${IDS.deniedOperatorUser}`,
      `assignment_${IDS.managerUser}`,
      `assignment_delivery_${IDS.alexUser}`,
      `assignment_${IDS.deliveryOperatorUser}`,
      `assignment_${IDS.deliveryDeniedOperatorUser}`,
      `assignment_${IDS.asciiReceiptUser}`,
      `assignment_ascii_receipt_${IDS.alexUser}`,
    ],
  ],
  [
    'restaurant_staff_profiles',
    [
      IDS.reportsOperationalStaff,
      IDS.alexStaff,
      RESTAURANT_E2E.operatorId,
      RESTAURANT_E2E.deniedOperatorId,
      RESTAURANT_E2E.managerId,
      RESTAURANT_E2E.deliveryOperatorId,
      RESTAURANT_E2E.deliveryDeniedOperatorId,
      IDS.asciiReceiptStaffProfile,
    ],
  ],
  [
    'restaurant_operator_credentials',
    [
      'credential_chai_chowk_alex',
      IDS.operatorCredential,
      IDS.deniedOperatorCredential,
      IDS.managerCredential,
      IDS.deliveryOperatorCredential,
      IDS.deliveryDeniedOperatorCredential,
      IDS.asciiReceiptCredential,
    ],
  ],
  [
    'restaurant_branches',
    [RESTAURANT_E2E.branchId, RESTAURANT_E2E.branchA2Id, IDS.asciiReceiptBranch],
  ],
  ['restaurant_floors', [IDS.floor]],
  ['restaurant_tables', [IDS.table]],
  [
    'restaurant_kitchen_stations',
    [IDS.grillStation, IDS.expoStation, IDS.deliveryStation, IDS.asciiReceiptStation],
  ],
  [
    'restaurant_registered_devices',
    [
      RESTAURANT_E2E.posDeviceId,
      RESTAURANT_E2E.kdsDeviceId,
      RESTAURANT_E2E.deliveryPosDeviceId,
      RESTAURANT_E2E.deliveryKdsDeviceId,
      IDS.revokedBridgeDevice,
      IDS.asciiReceiptDevice,
      ...CASE_TERMINAL_INDEXES.map((index) => caseRegisterDevice(index).deviceId),
    ],
  ],
  ['restaurant_drawer_sessions', [IDS.drawer]],
  ['restaurant_brands', [IDS.brand]],
  ['restaurant_categories', [IDS.category]],
  ['restaurant_products', [IDS.product]],
  ['restaurant_modifier_groups', [IDS.modifierGroup]],
  ['restaurant_modifier_options', [IDS.modifierOption]],
  ['restaurant_product_modifier_groups', [IDS.productModifier]],
  ['restaurant_units', [IDS.unit]],
  ['restaurant_ingredients', [IDS.ingredient]],
  ['restaurant_recipes', [IDS.recipe]],
  ['restaurant_recipe_versions', [IDS.recipeVersion]],
  ['restaurant_recipe_lines', [IDS.recipeLine]],
  ['restaurant_price_lists', [IDS.priceList]],
  ['restaurant_price_list_versions', [IDS.priceVersion]],
  ['restaurant_price_list_entries', [IDS.priceEntry]],
  ['restaurant_menus', [IDS.menu]],
  ['restaurant_menu_sections', [IDS.menuSection]],
  ['restaurant_menu_items', [IDS.menuItem]],
  [
    'restaurant_branch_menu_publications',
    [IDS.publication, IDS.deliveryPublication, IDS.asciiReceiptPublication],
  ],
  [
    'restaurant_menu_availability_windows',
    [IDS.availability, IDS.deliveryAvailability, IDS.asciiReceiptAvailability],
  ],
  ['restaurant_station_routing_rules', [IDS.routingRule, IDS.deliveryRoutingRule]],
  ['restaurant_customers', [IDS.customer]],
  ['restaurant_customer_addresses', [IDS.customerAddress]],
  ['restaurant_delivery_zones', [IDS.deliveryZone, IDS.isolatedDeliveryZone]],
  ['restaurant_tax_official_sources', [IDS.deliveryTaxSource]],
  [
    'restaurant_tax_profile_versions',
    [IDS.deliveryTaxProfile, IDS.coreTaxProfile, IDS.asciiReceiptTaxProfile],
  ],
  [
    'restaurant_tax_rule_versions',
    [
      IDS.deliveryTaxRuleCash,
      IDS.deliveryTaxRuleCard,
      IDS.deliveryTaxRuleOther,
      IDS.coreTaxRuleCash,
      IDS.coreTaxRuleCard,
      IDS.coreTaxRuleOther,
      IDS.asciiReceiptTaxRuleCash,
      IDS.asciiReceiptTaxRuleCard,
      IDS.asciiReceiptTaxRuleOther,
    ],
  ],
  ['restaurant_loyalty_program_versions', [IDS.loyaltyProgram]],
  ['restaurant_loyalty_accounts', [IDS.loyaltyAccount]],
  ['restaurant_loyalty_points_entries', [IDS.loyaltyEntry]],
  ['restaurant_sop_templates', [IDS.sopTemplate]],
  ['restaurant_sop_template_versions', [IDS.sopVersion]],
  ['restaurant_sop_template_steps', [IDS.sopStep]],
  ['restaurant_sop_assignments', [IDS.sopAssignment]],
  ['restaurant_sop_occurrences', [IDS.sopOccurrence]],
  ['restaurant_sop_occurrence_steps', [IDS.sopOccurrenceStep]],
  // WHA-1542: the acceptance fixtures below live in this same tenant, so they are
  // verified by the same exact-row / no-leak check rather than trusted.
  ...BACK_OFFICE_STOCK_OWNED_FIXTURES,
  ...RECIPE_PROFITABILITY_OWNED_FIXTURES,
] as const;

export const RESTAURANT_E2E_OWNED_ROW_COUNT = RESTAURANT_E2E_OWNED_FIXTURES.reduce(
  (count, [, ids]) => count + ids.length,
  0
);

const FIXED_AT = new Date('2026-08-27T00:00:00.000Z');
const BUSINESS_DATE = new Date('2026-08-27T00:00:00.000Z');
const FIXED_DELIVERY_TAX_BUSINESS_DATE = businessDateToUtcDate(
  resolveBusinessDate(FIXED_AT, 'Asia/Karachi', '00:00')
);
const CURRENT_BUSINESS_DATE = businessDateToUtcDate(
  resolveBusinessDate(new Date(), 'Asia/Karachi', '00:00')
);
const PIN_BCRYPT_SALT = '$2b$12$abcdefghijklmnopqrstuu';
const DEVFATHOM_ORGANIZATION_ID = 'org_devfathom';
const ALEX_EMAIL = 'alex@company.com';
const OPERATOR_EMAIL = 'operator@restaurant-e2e.test';

function deviceSecretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

async function requirePristineDeliveryLane(tx: Prisma.TransactionClient) {
  const [state] = await tx.$queryRaw<Array<{ rows: bigint }>>(Prisma.sql`
    SELECT (
      (SELECT count(*) FROM restaurant_orders WHERE "branchId" = ${RESTAURANT_E2E.branchA2Id}) +
      (SELECT count(*) FROM restaurant_drawer_sessions WHERE "branchId" = ${RESTAURANT_E2E.branchA2Id}) +
      (SELECT count(*) FROM restaurant_daily_closes WHERE "branchId" = ${RESTAURANT_E2E.branchA2Id}) +
      (SELECT count(*) FROM restaurant_insight_daily_rollups WHERE "branchId" = ${RESTAURANT_E2E.branchA2Id})
    )::bigint AS rows
  `);
  if ((state?.rows ?? 0n) !== 0n) {
    throw new Error(
      'Restaurant Delivery E2E requires a fresh disposable database; isolated A2 runtime state already exists.'
    );
  }
}

async function seedDeliveryTaxProfile(tx: Prisma.TransactionClient) {
  const sourceContent = 'restaurant-e2e synthetic zero-rate tax fixture v1';
  const sourceContentHash = createHash('sha256').update(sourceContent).digest('hex');
  const approvalReference = 'TEST_ONLY · SYNTHETIC_ZERO_RATE';
  const activationIdempotencyKey = `restaurant-e2e-delivery-tax:${FIXED_DELIVERY_TAX_BUSINESS_DATE.toISOString()}`;
  const activationPayloadHash = createHash('sha256').update(activationIdempotencyKey).digest('hex');
  const eligibilityEvidence = { fixture: true, synthetic: true, productionTaxAdvice: false };
  const rules = [
    { id: IDS.deliveryTaxRuleCash, paymentCategory: 'CASH', ruleCode: 'TEST_ZERO_CASH' },
    { id: IDS.deliveryTaxRuleCard, paymentCategory: 'CARD', ruleCode: 'TEST_ZERO_CARD' },
    { id: IDS.deliveryTaxRuleOther, paymentCategory: 'OTHER', ruleCode: 'TEST_ZERO_OTHER' },
  ] as const;
  const [existingSource, existingProfile, existingRules] = await Promise.all([
    tx.restaurantTaxOfficialSource.findUnique({ where: { id: IDS.deliveryTaxSource } }),
    tx.restaurantTaxProfileVersion.findUnique({ where: { id: IDS.deliveryTaxProfile } }),
    tx.restaurantTaxRuleVersion.findMany({
      where: { id: { in: rules.map(({ id }) => id) } },
      orderBy: { id: 'asc' },
    }),
  ]);
  const existingCount =
    Number(Boolean(existingSource)) + Number(Boolean(existingProfile)) + existingRules.length;
  if (existingCount > 0) {
    const actual = {
      source: existingSource && {
        id: existingSource.id,
        organizationId: existingSource.organizationId,
        authorityCode: existingSource.authorityCode,
        documentTitle: existingSource.documentTitle,
        sourceUrl: existingSource.sourceUrl,
        contentHash: existingSource.contentHash,
        retrievedAt: existingSource.retrievedAt.toISOString(),
        expiresAt: existingSource.expiresAt?.toISOString() ?? null,
        createdAt: existingSource.createdAt.toISOString(),
      },
      profile: existingProfile && {
        id: existingProfile.id,
        organizationId: existingProfile.organizationId,
        branchId: existingProfile.branchId,
        versionNumber: existingProfile.versionNumber,
        status: existingProfile.status,
        effectiveFrom: existingProfile.effectiveFrom.toISOString(),
        effectiveTo: existingProfile.effectiveTo?.toISOString() ?? null,
        approvalReference: existingProfile.approvalReference,
        approvedAt: existingProfile.approvedAt?.toISOString() ?? null,
        publishedAt: existingProfile.publishedAt?.toISOString() ?? null,
        presetId: existingProfile.presetId,
        activationIdempotencyKey: existingProfile.activationIdempotencyKey,
        activationPayloadHash: existingProfile.activationPayloadHash,
        eligibilityEvidence: existingProfile.eligibilityEvidence,
        profileName: existingProfile.profileName,
        jurisdictionCode: existingProfile.jurisdictionCode,
        priceMode: existingProfile.priceMode,
        evidenceKind: existingProfile.evidenceKind,
        createdAt: existingProfile.createdAt.toISOString(),
        updatedAt: existingProfile.updatedAt.toISOString(),
      },
      rules: existingRules.map((rule) => ({
        id: rule.id,
        organizationId: rule.organizationId,
        profileVersionId: rule.profileVersionId,
        officialSourceId: rule.officialSourceId,
        ruleCode: rule.ruleCode,
        paymentCategory: rule.paymentCategory,
        priceMode: rule.priceMode,
        discountTreatment: rule.discountTreatment,
        rate: rule.rate.toString(),
        status: rule.status,
        effectiveFrom: rule.effectiveFrom.toISOString(),
        effectiveTo: rule.effectiveTo?.toISOString() ?? null,
        approvalReference: rule.approvalReference,
        approvedAt: rule.approvedAt?.toISOString() ?? null,
        publishedAt: rule.publishedAt?.toISOString() ?? null,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString(),
      })),
    };
    const at = FIXED_DELIVERY_TAX_BUSINESS_DATE.toISOString();
    const expected = {
      source: {
        id: IDS.deliveryTaxSource,
        organizationId: RESTAURANT_E2E.organizationId,
        authorityCode: 'TEST-E2E',
        documentTitle: 'Synthetic zero-rate Restaurant Delivery fixture',
        sourceUrl: 'https://example.invalid/restaurant-e2e/synthetic-zero-rate-tax',
        contentHash: sourceContentHash,
        retrievedAt: at,
        expiresAt: null,
        createdAt: at,
      },
      profile: {
        id: IDS.deliveryTaxProfile,
        organizationId: RESTAURANT_E2E.organizationId,
        branchId: RESTAURANT_E2E.branchA2Id,
        versionNumber: 1,
        status: 'PUBLISHED',
        effectiveFrom: at,
        effectiveTo: null,
        approvalReference,
        approvedAt: at,
        publishedAt: at,
        presetId: 'TEST-ONLY-ZERO-RATE',
        activationIdempotencyKey,
        activationPayloadHash,
        eligibilityEvidence,
        profileName: 'Synthetic zero-rate Delivery fixture',
        jurisdictionCode: null,
        priceMode: 'INCLUSIVE',
        evidenceKind: null,
        createdAt: at,
        updatedAt: at,
      },
      rules: rules
        .map((rule) => ({
          id: rule.id,
          organizationId: RESTAURANT_E2E.organizationId,
          profileVersionId: IDS.deliveryTaxProfile,
          officialSourceId: IDS.deliveryTaxSource,
          ruleCode: rule.ruleCode,
          paymentCategory: rule.paymentCategory,
          priceMode: 'INCLUSIVE',
          discountTreatment: 'BEFORE_TAX',
          rate: '0',
          status: 'PUBLISHED',
          effectiveFrom: at,
          effectiveTo: null,
          approvalReference,
          approvedAt: at,
          publishedAt: at,
          createdAt: at,
          updatedAt: at,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('Existing Restaurant Delivery E2E synthetic tax fixture does not match.');
    }
    return;
  }

  await tx.restaurantTaxOfficialSource.create({
    data: {
      id: IDS.deliveryTaxSource,
      authorityCode: 'TEST-E2E',
      documentTitle: 'Synthetic zero-rate Restaurant Delivery fixture',
      sourceUrl: 'https://example.invalid/restaurant-e2e/synthetic-zero-rate-tax',
      contentHash: sourceContentHash,
      retrievedAt: FIXED_DELIVERY_TAX_BUSINESS_DATE,
      createdAt: FIXED_DELIVERY_TAX_BUSINESS_DATE,
    },
  });
  await tx.restaurantTaxProfileVersion.create({
    data: {
      id: IDS.deliveryTaxProfile,
      branchId: RESTAURANT_E2E.branchA2Id,
      versionNumber: 1,
      status: 'PUBLISHED',
      effectiveFrom: FIXED_DELIVERY_TAX_BUSINESS_DATE,
      approvalReference,
      approvedAt: FIXED_DELIVERY_TAX_BUSINESS_DATE,
      publishedAt: FIXED_DELIVERY_TAX_BUSINESS_DATE,
      presetId: 'TEST-ONLY-ZERO-RATE',
      activationIdempotencyKey,
      activationPayloadHash,
      eligibilityEvidence,
      profileName: 'Synthetic zero-rate Delivery fixture',
      priceMode: 'INCLUSIVE',
      createdAt: FIXED_DELIVERY_TAX_BUSINESS_DATE,
      updatedAt: FIXED_DELIVERY_TAX_BUSINESS_DATE,
      rules: {
        create: rules.map((rule) => ({
          id: rule.id,
          officialSourceId: IDS.deliveryTaxSource,
          ruleCode: rule.ruleCode,
          paymentCategory: rule.paymentCategory,
          priceMode: 'INCLUSIVE',
          discountTreatment: 'BEFORE_TAX',
          rate: '0',
          status: 'PUBLISHED',
          effectiveFrom: FIXED_DELIVERY_TAX_BUSINESS_DATE,
          approvalReference,
          approvedAt: FIXED_DELIVERY_TAX_BUSINESS_DATE,
          publishedAt: FIXED_DELIVERY_TAX_BUSINESS_DATE,
          createdAt: FIXED_DELIVERY_TAX_BUSINESS_DATE,
          updatedAt: FIXED_DELIVERY_TAX_BUSINESS_DATE,
        })),
      },
    },
  });
}

async function seedCoreTaxProfile(tx: Prisma.TransactionClient) {
  if (await tx.restaurantTaxProfileVersion.findUnique({ where: { id: IDS.coreTaxProfile } }))
    return;
  const at = FIXED_DELIVERY_TAX_BUSINESS_DATE;
  const approvalReference = 'TEST_ONLY · SYNTHETIC_ZERO_RATE';
  const activationIdempotencyKey = `restaurant-e2e-core-tax:${at.toISOString()}`;
  await tx.restaurantTaxProfileVersion.create({
    data: {
      id: IDS.coreTaxProfile,
      branchId: RESTAURANT_E2E.branchId,
      versionNumber: 1,
      status: 'PUBLISHED',
      effectiveFrom: at,
      approvalReference,
      approvedAt: at,
      publishedAt: at,
      presetId: 'TEST-ONLY-ZERO-RATE',
      activationIdempotencyKey,
      activationPayloadHash: createHash('sha256').update(activationIdempotencyKey).digest('hex'),
      eligibilityEvidence: { fixture: true, synthetic: true, productionTaxAdvice: false },
      profileName: 'Synthetic zero-rate Core POS fixture',
      priceMode: 'INCLUSIVE',
      createdAt: at,
      updatedAt: at,
      rules: {
        create: [
          { id: IDS.coreTaxRuleCash, paymentCategory: 'CASH', ruleCode: 'TEST_ZERO_CORE_CASH' },
          { id: IDS.coreTaxRuleCard, paymentCategory: 'CARD', ruleCode: 'TEST_ZERO_CORE_CARD' },
          { id: IDS.coreTaxRuleOther, paymentCategory: 'OTHER', ruleCode: 'TEST_ZERO_CORE_OTHER' },
        ].map((rule) => ({
          ...rule,
          officialSourceId: IDS.deliveryTaxSource,
          priceMode: 'INCLUSIVE' as const,
          discountTreatment: 'BEFORE_TAX' as const,
          rate: '0',
          status: 'PUBLISHED' as const,
          effectiveFrom: at,
          approvalReference,
          approvedAt: at,
          publishedAt: at,
          createdAt: at,
          updatedAt: at,
        })),
      },
    },
  });
}

/**
 * WHA-1567 — the zero-rate profile for the ASCII receipt branch, a byte-for-byte
 * peer of the Core POS one above with its own branch and ids. A settled bill
 * resolves tax by branch, so without it the receipt cases would settle against
 * no published profile; and because it is the same synthetic zero rate, the
 * money a receipt renders there stays identical to the accented branches' — the
 * branch NAME is the only variable this fixture introduces.
 */
async function seedAsciiReceiptTaxProfile(tx: Prisma.TransactionClient) {
  if (
    await tx.restaurantTaxProfileVersion.findUnique({ where: { id: IDS.asciiReceiptTaxProfile } })
  )
    return;
  const at = FIXED_DELIVERY_TAX_BUSINESS_DATE;
  const approvalReference = 'TEST_ONLY · SYNTHETIC_ZERO_RATE';
  const activationIdempotencyKey = `restaurant-e2e-ascii-receipt-tax:${at.toISOString()}`;
  await tx.restaurantTaxProfileVersion.create({
    data: {
      id: IDS.asciiReceiptTaxProfile,
      branchId: IDS.asciiReceiptBranch,
      versionNumber: 1,
      status: 'PUBLISHED',
      effectiveFrom: at,
      approvalReference,
      approvedAt: at,
      publishedAt: at,
      presetId: 'TEST-ONLY-ZERO-RATE',
      activationIdempotencyKey,
      activationPayloadHash: createHash('sha256').update(activationIdempotencyKey).digest('hex'),
      eligibilityEvidence: { fixture: true, synthetic: true, productionTaxAdvice: false },
      profileName: 'Synthetic zero-rate ASCII receipt fixture',
      priceMode: 'INCLUSIVE',
      createdAt: at,
      updatedAt: at,
      rules: {
        create: [
          {
            id: IDS.asciiReceiptTaxRuleCash,
            paymentCategory: 'CASH',
            ruleCode: 'TEST_ZERO_ASCII_RECEIPT_CASH',
          },
          {
            id: IDS.asciiReceiptTaxRuleCard,
            paymentCategory: 'CARD',
            ruleCode: 'TEST_ZERO_ASCII_RECEIPT_CARD',
          },
          {
            id: IDS.asciiReceiptTaxRuleOther,
            paymentCategory: 'OTHER',
            ruleCode: 'TEST_ZERO_ASCII_RECEIPT_OTHER',
          },
        ].map((rule) => ({
          ...rule,
          officialSourceId: IDS.deliveryTaxSource,
          priceMode: 'INCLUSIVE' as const,
          discountTreatment: 'BEFORE_TAX' as const,
          rate: '0',
          status: 'PUBLISHED' as const,
          effectiveFrom: at,
          approvalReference,
          approvedAt: at,
          publishedAt: at,
          createdAt: at,
          updatedAt: at,
        })),
      },
    },
  });
}

/** Cut an empty, genuinely closed prior day through the production money path.
 * Yesterday is inside the default seven-day comparison window; today stays
 * open for POS acceptance. No prior-window close is fabricated, so unknown
 * comparison values remain unknown. The device/date key makes seed replay safe.
 */
function seedCurrentWindowClose(databaseUrl: string) {
  const day = new Date(CURRENT_BUSINESS_DATE);
  day.setUTCDate(day.getUTCDate() - 1);
  const businessDate = day.toISOString().slice(0, 10);
  // The scripts tsconfig supplies the existing server-only shim. A child keeps
  // that script-only resolution out of the seed's normal application imports.
  const input = {
    branchId: RESTAURANT_E2E.branchId,
    businessDate,
    actor: {
      staffProfileId: RESTAURANT_E2E.managerId,
      deviceId: RESTAURANT_E2E.posDeviceId,
      idempotencyKey: `e2e-comparison-close-${businessDate}`,
    },
  };
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      `--tsconfig=${fileURLToPath(new URL('./tsconfig.json', import.meta.url))}`,
      '--eval',
      `
      import { cutClose } from './src/lib/restaurant/daily-close';
      import { withTenantDb } from './src/lib/tenancy/scoped-db';
      import { db } from './src/lib/db';
      withTenantDb(${JSON.stringify(RESTAURANT_E2E.organizationId)}, tx =>
        cutClose(tx, ${JSON.stringify(input)})
      ).then(result => console.log('Current-window close:', result.dailyCloseId,
        'date:', ${JSON.stringify(businessDate)}, 'replayed:', result.replayed))
       .catch(error => { console.error(error); process.exitCode = 1; })
       .finally(() => db.$disconnect());
    `,
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Current-window daily-close fixture failed.');
}

/** Match platform onboarding's role catalog without changing existing actor grants. */
async function seedFirstRunRoles(tx: Prisma.TransactionClient, organizationId: string) {
  for (const template of roleTemplatesForVertical('RESTAURANT')) {
    await tx.organizationRole.upsert({
      where: {
        organizationId_key: {
          organizationId,
          key: template.key,
        },
      },
      update: {},
      create: {
        key: template.key,
        name: template.name,
        isSystem: template.isSystem,
        permissions: {
          create: template.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
        },
      },
    });
  }
}

/** Setup-only tenant: never seed orders, bills, tenders, receipts or closes. */
async function seedFirstSaleTenant(prisma: PrismaClient, password: string) {
  const organizationId = 'org_restaurant_first_sale';
  const id = (key: string) => `first_sale_${key}`;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true), set_config('app.is_platform_admin', 'true', true)`;
      const existing = await tx.organization.findUnique({ where: { id: organizationId } });
      if (existing) {
        if (
          (await tx.restaurantOrder.count({ where: { organizationId } })) ||
          (await tx.restaurantBill.count({ where: { organizationId } }))
        )
          throw new Error(
            'First-sale tenant has trading history; use a fresh disposable database.'
          );
        console.log('First-sale tenant replay: zero orders and bills.');
        return;
      }
      const source = await tx.organization.findUniqueOrThrow({
        where: { id: RESTAURANT_E2E.organizationId },
      });
      await tx.organization.create({
        data: {
          id: organizationId,
          slug: 'restaurant-first-sale',
          displayName: 'First Sale Cafe',
          legalName: 'First Sale Cafe Test Fixture',
          vertical: 'RESTAURANT',
          status: 'ACTIVE',
          deploymentMode: 'SHARED',
          timezone: 'Asia/Karachi',
          currency: 'PKR',
          locale: 'en',
          packageId: source.packageId,
          seatLimit: 5,
          activatedAt: FIXED_AT,
        },
      });
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'false', true)`;
      for (const department of defaultDepartmentRowsForVertical('RESTAURANT'))
        await tx.organizationDepartment.create({ data: department });
      await seedFirstRunRoles(tx, organizationId);
      const owner = await tx.organizationRole.findUniqueOrThrow({
        where: { organizationId_key: { organizationId, key: 'owner' } },
      });
      await tx.user.create({
        data: {
          id: id('user'),
          name: 'First Sale Owner',
          email: 'first-sale@restaurant-e2e.test',
          password,
          role: 'EMPLOYEE',
          department: adminDepartmentKeyForVertical('RESTAURANT'),
          title: 'Owner',
          organizationRoleId: owner.id,
        },
      });
      await tx.restaurantBranch.create({
        data: {
          id: id('branch'),
          name: 'First Sale Kitchen',
          timezone: 'Asia/Karachi',
          isDefault: true,
        },
      });
      await tx.restaurantBranchAssignment.create({
        data: { branchId: id('branch'), userId: id('user') },
      });
      await tx.restaurantStaffProfile.create({
        data: {
          id: id('staff'),
          userId: id('user'),
          displayName: 'First Sale Owner',
          primaryBranchId: id('branch'),
        },
      });
      await tx.restaurantOperatorCredential.create({
        data: {
          staffProfileId: id('staff'),
          type: 'PIN',
          credentialHash: hashSync('424242', PIN_BCRYPT_SALT),
        },
      });
      await tx.restaurantKitchenStation.create({
        data: { id: id('station'), branchId: id('branch'), name: 'Kitchen', isDefault: true },
      });
      for (const kind of ['POS', 'KDS'] as const) {
        await tx.restaurantRegisteredDevice.create({
          data: {
            id: id(kind.toLowerCase()),
            branchId: id('branch'),
            name: `First Sale ${kind}`,
            kind,
            stationId: kind === 'KDS' ? id('station') : null,
            deviceSecretHash: deviceSecretHash(
              `rdk_first_sale_${kind.toLowerCase()}_local_ci_only`
            ),
          },
        });
      }
      await tx.restaurantDrawerSession.create({
        data: {
          deviceId: id('pos'),
          branchId: id('branch'),
          staffProfileId: id('staff'),
          businessDate: CURRENT_BUSINESS_DATE,
          openingFloat: '100.00',
        },
      });
      await tx.restaurantFloor.create({
        data: { id: id('floor'), branchId: id('branch'), name: 'Dining' },
      });
      await tx.restaurantTable.create({
        data: { id: id('table'), floorId: id('floor'), code: 'Table 1', capacity: 4 },
      });
      await tx.restaurantBrand.create({
        data: { id: id('brand'), name: 'First Sale', isDefault: true },
      });
      await tx.restaurantCategory.create({ data: { id: id('category'), name: 'Mains' } });
      await tx.restaurantProduct.create({
        data: { id: id('product'), categoryId: id('category'), name: 'First Sale Bun' },
      });
      await tx.restaurantPriceList.create({
        data: { id: id('prices'), name: 'First Sale Prices', isDefault: true },
      });
      await tx.restaurantPriceListVersion.create({
        data: {
          id: id('price_version'),
          priceListId: id('prices'),
          versionNumber: 1,
          effectiveFrom: FIXED_AT,
          status: 'ACTIVE',
          activatedAt: FIXED_AT,
        },
      });
      await tx.restaurantPriceListEntry.create({
        data: { priceListVersionId: id('price_version'), productId: id('product'), price: '12.50' },
      });
      await tx.restaurantMenu.create({
        data: { id: id('menu'), brandId: id('brand'), name: 'First Sale Menu' },
      });
      await tx.restaurantMenuSection.create({
        data: { id: id('section'), menuId: id('menu'), name: 'Mains' },
      });
      await tx.restaurantMenuItem.create({
        data: { sectionId: id('section'), productId: id('product') },
      });
      await tx.restaurantBranchMenuPublication.create({
        data: {
          id: id('publication'),
          branchId: id('branch'),
          menuId: id('menu'),
          priceListId: id('prices'),
          status: 'PUBLISHED',
          channels: ['DINE_IN'],
          publishedAt: FIXED_AT,
        },
      });
      await tx.restaurantMenuAvailabilityWindow.create({
        data: {
          publicationId: id('publication'),
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          startMinutes: 0,
          endMinutes: 0,
        },
      });
      await tx.restaurantTaxOfficialSource.create({
        data: {
          id: id('tax_source'),
          authorityCode: 'TEST-E2E',
          documentTitle: 'Synthetic zero-rate first-sale fixture',
          sourceUrl: 'https://example.invalid/first-sale/synthetic-zero-rate-tax',
          contentHash: createHash('sha256').update('first-sale synthetic zero rate').digest('hex'),
          retrievedAt: FIXED_AT,
        },
      });
      await tx.restaurantTaxProfileVersion.create({
        data: {
          id: id('tax_profile'),
          branchId: id('branch'),
          versionNumber: 1,
          status: 'PUBLISHED',
          effectiveFrom: FIXED_AT,
          approvedAt: FIXED_AT,
          publishedAt: FIXED_AT,
          approvalReference: 'TEST_ONLY · SYNTHETIC_ZERO_RATE',
          priceMode: 'INCLUSIVE',
          rules: {
            create: ['CASH', 'CARD', 'OTHER'].map((paymentCategory) => ({
              officialSourceId: id('tax_source'),
              ruleCode: `TEST_ZERO_${paymentCategory}`,
              paymentCategory,
              priceMode: 'INCLUSIVE',
              rate: '0',
              status: 'PUBLISHED',
              effectiveFrom: FIXED_AT,
              approvalReference: 'TEST_ONLY · SYNTHETIC_ZERO_RATE',
              approvedAt: FIXED_AT,
              publishedAt: FIXED_AT,
            })),
          },
        },
      });
      console.log('Seeded separate first-sale tenant: setup only; zero trading history.');
    },
    { timeout: 60_000 }
  );
}

async function main() {
  const databaseUrl = resolveRestaurantE2eDatabaseUrl();
  const operatorPassword = process.env.RESTAURANT_ACTOR_OPERATOR_PASSWORD;
  const operatorPasswordHash = operatorPassword
    ? hashSync(operatorPassword, PIN_BCRYPT_SALT)
    : null;

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  let devFathomAlexPassword: string | null = null;

  try {
    const [role] = await prisma.$queryRaw<
      Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>
    >`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error(
        'Restaurant E2E seed requires LOGIN NOSUPERUSER NOBYPASSRLS PostgreSQL role.'
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_organization_id', '', true), set_config('app.is_platform_admin', 'true', true)`
      );
      const devFathomAlex = await tx.user.findUnique({
        where: {
          organizationId_email: {
            organizationId: DEVFATHOM_ORGANIZATION_ID,
            email: ALEX_EMAIL,
          },
        },
        select: { password: true },
      });
      if (!devFathomAlex) {
        throw new Error('Seed org_devfathom before Chai Chowk so Alex can belong to both tenants.');
      }
      devFathomAlexPassword = devFathomAlex.password;

      await tx.organization.upsert({
        where: { id: RESTAURANT_E2E.organizationId },
        update: {
          slug: 'chai-chowk',
          legalName: 'Chai Chowk Cafe LLC',
          displayName: 'Chai Chowk Café',
          vertical: 'RESTAURANT',
          status: 'ACTIVE',
          deploymentMode: 'SHARED',
          packageId: null,
          timezone: 'Asia/Karachi',
          locale: 'en',
          currency: 'PKR',
          seatLimit: 1,
          gracePeriodDays: 0,
          activatedAt: null,
          suspendedAt: null,
          terminatedAt: null,
          purgeScheduledAt: null,
          dataResidency: null,
          primaryContactName: null,
          primaryContactEmail: null,
          notes: null,
        },
        create: {
          id: RESTAURANT_E2E.organizationId,
          slug: 'chai-chowk',
          legalName: 'Chai Chowk Cafe LLC',
          displayName: 'Chai Chowk Café',
          vertical: 'RESTAURANT',
          status: 'ACTIVE',
          timezone: 'Asia/Karachi',
          currency: 'PKR',
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      await seedRestaurantDemoControlPlane(tx);
      // WHA-1542 — the tenant must be licensed for exactly the branches this
      // fixture creates. It seeds THREE: `branch_restaurant_e2e`,
      // `branch_restaurant_e2e_a2` and WHA-1567's ASCII-receipt branch. At 2 the
      // organization sat over its own location licence, so the branches console
      // read "3 of 2 active" and refused further branch creation.
      await tx.organizationLimit.upsert({
        where: {
          organizationId_key: {
            organizationId: RESTAURANT_E2E.organizationId,
            key: 'restaurant.locations.max',
          },
        },
        update: {
          value: RESTAURANT_E2E_BRANCH_COUNT,
          period: null,
          source: 'E2E_FIXTURE',
          expiresAt: null,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
        create: {
          id: IDS.locationsLimit,
          organizationId: RESTAURANT_E2E.organizationId,
          key: 'restaurant.locations.max',
          value: RESTAURANT_E2E_BRANCH_COUNT,
          period: null,
          source: 'E2E_FIXTURE',
          expiresAt: null,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      // WHA-1542 — SOP manager verification (`SOP_DEPTH_REQUIREMENTS`
      // 'sop.verification' in src/lib/module-catalog.ts) requires the BARE limit
      // key `sop.evidenceRetentionDays` at >= AUDIT_EVIDENCE_RETENTION_DAYS.
      // `resolveOrganizationEntitlements` namespaces every PACKAGE-granted limit
      // as `<moduleKey>.<key>`, so the `restaurant-operations` package's own
      // `sop.evidenceRetentionDays: 365` lands as
      // `restaurant-core.sop.evidenceRetentionDays` and the requirement — which
      // reads the bare key only — sees 0 and denies. An explicit organization
      // limit is the sanctioned grant for that key, so the fixture states it.
      // The gate is NOT relaxed: it still evaluates, and still denies below 365.
      await tx.organizationLimit.upsert({
        where: {
          organizationId_key: {
            organizationId: RESTAURANT_E2E.organizationId,
            key: 'sop.evidenceRetentionDays',
          },
        },
        update: {
          value: SOP_EVIDENCE_RETENTION_DAYS,
          period: null,
          source: 'E2E_FIXTURE',
          expiresAt: null,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
        create: {
          id: IDS.sopEvidenceRetentionLimit,
          organizationId: RESTAURANT_E2E.organizationId,
          key: 'sop.evidenceRetentionDays',
          value: SOP_EVIDENCE_RETENTION_DAYS,
          period: null,
          source: 'E2E_FIXTURE',
          expiresAt: null,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      // WHA-290: `User.department` is a composite foreign key onto
      // `organization_departments`, so this RESTAURANT organization's own
      // catalog (KITCHEN, FRONT_OF_HOUSE — it has no LEADERSHIP) must exist
      // before the operator and manager below. `organizationId` is passed
      // explicitly because this transaction runs with an empty tenant GUC, so
      // the column's `current_setting` default would resolve to ''.
      for (const department of defaultDepartmentRowsForVertical('RESTAURANT')) {
        await tx.organizationDepartment.upsert({
          where: {
            organizationId_key: {
              organizationId: RESTAURANT_E2E.organizationId,
              key: department.key,
            },
          },
          update: department,
          create: {
            ...department,
            id: `department_restaurant_e2e_${department.key.toLowerCase()}`,
            organizationId: RESTAURANT_E2E.organizationId,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
      }
    });

    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)`,
          RESTAURANT_E2E.organizationId
        );
        await tx.restaurantBranch.upsert({
          where: { id: RESTAURANT_E2E.branchId },
          update: {
            name: 'Gulberg Café',
            timezone: 'Asia/Karachi',
            businessDayCutoff: '00:00',
            shiftSignInEnforced: false,
            address: null,
            active: true,
            isDefault: true,
          },
          create: {
            id: RESTAURANT_E2E.branchId,
            name: 'Gulberg Café',
            timezone: 'Asia/Karachi',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantBranch.upsert({
          where: { id: RESTAURANT_E2E.branchA2Id },
          update: {
            name: 'DHA Café',
            timezone: 'Asia/Karachi',
            businessDayCutoff: '00:00',
            shiftSignInEnforced: false,
            address: null,
            active: true,
            isDefault: false,
          },
          create: {
            id: RESTAURANT_E2E.branchA2Id,
            name: 'DHA Café',
            timezone: 'Asia/Karachi',
            active: true,
            isDefault: false,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        // WHA-1567 — the ASCII-printable receipt branch. `bill.branch.name`
        // becomes `facts.businessName`, and `validateRawPrintDocument` refuses
        // any fact outside [\x20-\x7e\n]; both branches above carry an 'é', so a
        // RECEIPT job could never be queued anywhere in this tenant. The gate is
        // the product behaving correctly and is NOT relaxed — the accented
        // branches keep asserting their genuine 422 + BROWSER_OS fallback, and
        // the queued-receipt half of that acceptance moves here.
        await tx.restaurantBranch.upsert({
          where: { id: IDS.asciiReceiptBranch },
          update: {
            name: ASCII_RECEIPT_BRANCH_NAME,
            timezone: 'Asia/Karachi',
            businessDayCutoff: '00:00',
            shiftSignInEnforced: false,
            address: null,
            active: true,
            isDefault: false,
          },
          create: {
            id: IDS.asciiReceiptBranch,
            name: ASCII_RECEIPT_BRANCH_NAME,
            timezone: 'Asia/Karachi',
            active: true,
            isDefault: false,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await seedFirstRunRoles(tx, RESTAURANT_E2E.organizationId);
        await requirePristineDeliveryLane(tx);
        await seedDeliveryTaxProfile(tx);
        await seedCoreTaxProfile(tx);
        await seedAsciiReceiptTaxProfile(tx);
        await tx.restaurantFloor.upsert({
          where: { id: IDS.floor },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            name: 'Main dining',
            sortOrder: 0,
            active: true,
          },
          create: {
            id: IDS.floor,
            branchId: RESTAURANT_E2E.branchId,
            name: 'Main dining',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantTable.upsert({
          where: { id: IDS.table },
          update: { floorId: IDS.floor, code: 'Table 12', capacity: 4, active: true },
          create: {
            id: IDS.table,
            floorId: IDS.floor,
            code: 'Table 12',
            capacity: 4,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.organizationRole.upsert({
          where: { id: IDS.operatorRole },
          update: {
            key: 'restaurant-e2e-operator',
            name: 'Restaurant E2E Operator',
            description: null,
            isSystem: false,
            permissions: {
              deleteMany: {},
              create: [
                'payments:collect',
                'cash:open',
                'cash:adjust',
                'cash:close',
                'orders:take',
                'customers:read',
                'kitchen:operate',
              ].map((capability, index) => ({
                id: `permission_restaurant_e2e_operator_${index}`,
                capability,
                effect: 'ALLOW' as const,
                createdAt: FIXED_AT,
              })),
            },
          },
          create: {
            id: IDS.operatorRole,
            key: 'restaurant-e2e-operator',
            name: 'Restaurant E2E Operator',
            permissions: {
              create: [
                'payments:collect',
                'cash:open',
                'cash:adjust',
                'cash:close',
                'orders:take',
                'customers:read',
                'kitchen:operate',
              ].map((capability, index) => ({
                id: `permission_restaurant_e2e_operator_${index}`,
                capability,
                effect: 'ALLOW' as const,
                createdAt: FIXED_AT,
              })),
            },
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.organizationRole.upsert({
          where: { id: IDS.deniedOperatorRole },
          update: {
            key: 'restaurant-e2e-delivery-denied',
            name: 'Restaurant E2E Delivery Denied',
            description: null,
            isSystem: false,
            permissions: {
              deleteMany: {},
              create: {
                id: 'permission_restaurant_e2e_delivery_denied',
                capability: 'customers:read',
                effect: 'ALLOW',
                createdAt: FIXED_AT,
              },
            },
          },
          create: {
            id: IDS.deniedOperatorRole,
            key: 'restaurant-e2e-delivery-denied',
            name: 'Restaurant E2E Delivery Denied',
            permissions: {
              create: {
                id: 'permission_restaurant_e2e_delivery_denied',
                capability: 'customers:read',
                effect: 'ALLOW',
                createdAt: FIXED_AT,
              },
            },
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.organizationRole.upsert({
          where: { id: IDS.managerRole },
          update: {
            key: 'restaurant-e2e-manager',
            name: 'Restaurant E2E Manager',
            description: null,
            isSystem: false,
            permissions: {
              deleteMany: {},
              create: {
                id: 'permission_restaurant_e2e_manager_all',
                capability: '*',
                effect: 'ALLOW',
                createdAt: FIXED_AT,
              },
            },
          },
          create: {
            id: IDS.managerRole,
            key: 'restaurant-e2e-manager',
            name: 'Restaurant E2E Manager',
            permissions: {
              create: [
                {
                  id: 'permission_restaurant_e2e_manager_all',
                  capability: '*',
                  effect: 'ALLOW',
                  createdAt: FIXED_AT,
                },
              ],
            },
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        // CSV denial case: a real operational reader with branch scope, but
        // no financial capability and no wildcard administrator grant.
        await tx.organizationRole.upsert({
          where: { id: IDS.reportsOperationalRole },
          update: {
            permissions: {
              deleteMany: {},
              create: [
                {
                  id: 'permission_restaurant_e2e_reports_operational',
                  capability: 'reports:operational',
                  effect: 'ALLOW',
                },
              ],
            },
          },
          create: {
            id: IDS.reportsOperationalRole,
            key: 'restaurant-e2e-reports-operational',
            name: 'Operational reports reader',
            permissions: {
              create: [
                {
                  id: 'permission_restaurant_e2e_reports_operational',
                  capability: 'reports:operational',
                  effect: 'ALLOW',
                },
              ],
            },
          },
        });
        for (const user of [
          {
            id: IDS.reportsOperationalUser,
            roleId: IDS.reportsOperationalRole,
            name: 'Operational Reports Reader',
            email: 'reports-operational@restaurant-e2e.test',
            title: 'Reports reader',
            password: devFathomAlexPassword,
            branchId: RESTAURANT_E2E.branchId,
          },
          {
            id: IDS.alexUser,
            roleId: IDS.managerRole,
            name: 'Alex Carter',
            email: ALEX_EMAIL,
            title: 'Owner',
            password: devFathomAlexPassword,
            branchId: RESTAURANT_E2E.branchId,
          },
          {
            id: IDS.operatorUser,
            roleId: IDS.operatorRole,
            name: 'E2E Operator',
            email: OPERATOR_EMAIL,
            title: 'Operator',
            password: operatorPasswordHash,
            branchId: RESTAURANT_E2E.branchId,
          },
          {
            id: IDS.deniedOperatorUser,
            roleId: IDS.deniedOperatorRole,
            name: 'E2E Delivery Denied',
            email: 'delivery-denied@restaurant-e2e.test',
            title: 'Operator',
            password: null,
            branchId: RESTAURANT_E2E.branchId,
          },
          {
            id: IDS.managerUser,
            roleId: IDS.managerRole,
            name: 'E2E Manager',
            email: 'manager@restaurant-e2e.test',
            title: 'Manager',
            password: null,
            branchId: RESTAURANT_E2E.branchId,
          },
          {
            id: IDS.deliveryOperatorUser,
            roleId: IDS.operatorRole,
            name: 'E2E Delivery Operator',
            email: 'delivery-operator@restaurant-e2e.test',
            title: 'Operator',
            password: null,
            branchId: RESTAURANT_E2E.branchA2Id,
          },
          {
            id: IDS.deliveryDeniedOperatorUser,
            roleId: IDS.deniedOperatorRole,
            name: 'E2E Delivery Capability Denied',
            email: 'delivery-capability-denied@restaurant-e2e.test',
            title: 'Operator',
            password: null,
            branchId: RESTAURANT_E2E.branchA2Id,
          },
          {
            // WHA-1567 — the register operator of the ASCII receipt branch. It
            // reuses `operatorRole` rather than declaring a role of its own: the
            // fixture contract asks for the SAME capabilities as the seeded
            // restaurant-e2e-operator, and a second copy of that permission set
            // could drift away from the one every other terminal case asserts.
            id: IDS.asciiReceiptUser,
            roleId: IDS.operatorRole,
            name: ASCII_RECEIPT_OPERATOR_NAME,
            email: ASCII_RECEIPT_OPERATOR_EMAIL,
            title: 'Operator',
            password: null,
            branchId: IDS.asciiReceiptBranch,
          },
        ]) {
          await tx.user.upsert({
            where: { id: user.id },
            update: {
              organizationRoleId: user.roleId,
              name: user.name,
              email: user.email,
              password: user.password,
              department: adminDepartmentKeyForVertical('RESTAURANT'),
              title: user.title,
              status: 'ACTIVE',
              startDate: FIXED_AT,
              role: user.id === IDS.alexUser ? 'ADMIN' : 'EMPLOYEE',
              avatar: null,
              phone: null,
              bio: null,
              skills: [],
              lastActiveAt: null,
              tokenVersion: 0,
              passwordChangedAt: null,
              preferences: Prisma.DbNull,
              notificationPrefs: Prisma.DbNull,
              twoFactorSecret: null,
              twoFactorEnabledAt: null,
            },
            create: {
              id: user.id,
              organizationRoleId: user.roleId,
              name: user.name,
              email: user.email,
              password: user.password,
              role: user.id === IDS.alexUser ? 'ADMIN' : 'EMPLOYEE',
              // A restaurant has no LEADERSHIP department; both fixture users
              // work the floor.
              department: adminDepartmentKeyForVertical('RESTAURANT'),
              title: user.title,
              startDate: FIXED_AT,
              createdAt: FIXED_AT,
              updatedAt: FIXED_AT,
            },
          });
          await tx.restaurantBranchAssignment.upsert({
            where: { branchId_userId: { branchId: user.branchId, userId: user.id } },
            update: { branchId: user.branchId, userId: user.id },
            create: {
              id: `assignment_${user.id}`,
              branchId: user.branchId,
              userId: user.id,
              createdAt: FIXED_AT,
              updatedAt: FIXED_AT,
            },
          });
        }
        await tx.restaurantStaffProfile.upsert({
          where: { id: IDS.reportsOperationalStaff },
          update: {
            userId: IDS.reportsOperationalUser,
            primaryBranchId: RESTAURANT_E2E.branchId,
            status: 'ACTIVE',
          },
          create: {
            id: IDS.reportsOperationalStaff,
            userId: IDS.reportsOperationalUser,
            primaryBranchId: RESTAURANT_E2E.branchId,
            displayName: 'Operational Reports Reader',
          },
        });
        await tx.restaurantBranchAssignment.upsert({
          where: {
            branchId_userId: { branchId: RESTAURANT_E2E.branchA2Id, userId: IDS.alexUser },
          },
          update: { branchId: RESTAURANT_E2E.branchA2Id, userId: IDS.alexUser },
          create: {
            id: `assignment_delivery_${IDS.alexUser}`,
            branchId: RESTAURANT_E2E.branchA2Id,
            userId: IDS.alexUser,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        // The print-bridge configurator answers for the branches the signed-in
        // admin is assigned to, and the receipt acceptance case publishes a
        // RECEIPT route on the ASCII branch through that real endpoint.
        await tx.restaurantBranchAssignment.upsert({
          where: {
            branchId_userId: { branchId: IDS.asciiReceiptBranch, userId: IDS.alexUser },
          },
          update: { branchId: IDS.asciiReceiptBranch, userId: IDS.alexUser },
          create: {
            id: `assignment_ascii_receipt_${IDS.alexUser}`,
            branchId: IDS.asciiReceiptBranch,
            userId: IDS.alexUser,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        for (const staff of [
          {
            id: IDS.alexStaff,
            userId: IDS.alexUser,
            name: 'Alex Carter',
            pin: RESTAURANT_E2E.managerPin,
            credentialId: 'credential_chai_chowk_alex',
            primaryBranchId: RESTAURANT_E2E.branchId,
          },
          {
            id: RESTAURANT_E2E.operatorId,
            userId: IDS.operatorUser,
            name: 'E2E Operator',
            pin: RESTAURANT_E2E.operatorPin,
            credentialId: IDS.operatorCredential,
            primaryBranchId: RESTAURANT_E2E.branchId,
          },
          {
            id: RESTAURANT_E2E.deniedOperatorId,
            userId: IDS.deniedOperatorUser,
            name: 'E2E Delivery Denied',
            pin: RESTAURANT_E2E.deniedOperatorPin,
            credentialId: IDS.deniedOperatorCredential,
            primaryBranchId: RESTAURANT_E2E.branchId,
          },
          {
            id: RESTAURANT_E2E.managerId,
            userId: IDS.managerUser,
            name: 'E2E Manager',
            pin: RESTAURANT_E2E.managerPin,
            credentialId: IDS.managerCredential,
            primaryBranchId: RESTAURANT_E2E.branchId,
          },
          {
            id: RESTAURANT_E2E.deliveryOperatorId,
            userId: IDS.deliveryOperatorUser,
            name: 'E2E Delivery Operator',
            pin: RESTAURANT_E2E.deliveryOperatorPin,
            credentialId: IDS.deliveryOperatorCredential,
            primaryBranchId: RESTAURANT_E2E.branchA2Id,
          },
          {
            id: RESTAURANT_E2E.deliveryDeniedOperatorId,
            userId: IDS.deliveryDeniedOperatorUser,
            name: 'E2E Delivery Capability Denied',
            pin: RESTAURANT_E2E.deliveryDeniedOperatorPin,
            credentialId: IDS.deliveryDeniedOperatorCredential,
            primaryBranchId: RESTAURANT_E2E.branchA2Id,
          },
          {
            id: IDS.asciiReceiptStaffProfile,
            userId: IDS.asciiReceiptUser,
            name: ASCII_RECEIPT_OPERATOR_NAME,
            pin: ASCII_RECEIPT_OPERATOR_PIN,
            credentialId: IDS.asciiReceiptCredential,
            primaryBranchId: IDS.asciiReceiptBranch,
          },
        ]) {
          await tx.restaurantStaffProfile.upsert({
            where: { id: staff.id },
            update: {
              userId: staff.userId,
              displayName: staff.name,
              email: null,
              primaryBranchId: staff.primaryBranchId,
              status: 'ACTIVE',
            },
            create: {
              id: staff.id,
              userId: staff.userId,
              displayName: staff.name,
              primaryBranchId: staff.primaryBranchId,
              status: 'ACTIVE',
              createdAt: FIXED_AT,
              updatedAt: FIXED_AT,
            },
          });
          await tx.restaurantOperatorCredential.upsert({
            where: { id: staff.credentialId },
            update: {
              staffProfileId: staff.id,
              deviceId: null,
              type: 'PIN',
              credentialHash: hashSync(staff.pin, PIN_BCRYPT_SALT),
              failedAttempts: 0,
              lockedUntil: null,
              revokedAt: null,
            },
            create: {
              id: staff.credentialId,
              staffProfileId: staff.id,
              type: 'PIN',
              credentialHash: hashSync(staff.pin, PIN_BCRYPT_SALT),
              createdAt: FIXED_AT,
              updatedAt: FIXED_AT,
            },
          });
        }
        await tx.restaurantKitchenStation.upsert({
          where: { id: IDS.grillStation },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            name: 'Grill',
            active: true,
            isDefault: true,
          },
          create: {
            id: IDS.grillStation,
            branchId: RESTAURANT_E2E.branchId,
            name: 'Grill',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantKitchenStation.upsert({
          where: { id: IDS.expoStation },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            name: 'Expo',
            active: true,
            isDefault: false,
          },
          create: {
            id: IDS.expoStation,
            branchId: RESTAURANT_E2E.branchId,
            name: 'Expo',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantKitchenStation.upsert({
          where: { id: IDS.deliveryStation },
          update: {
            branchId: RESTAURANT_E2E.branchA2Id,
            name: 'Delivery kitchen',
            active: true,
            isDefault: true,
          },
          create: {
            id: IDS.deliveryStation,
            branchId: RESTAURANT_E2E.branchA2Id,
            name: 'Delivery kitchen',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        // An ACTIVE default station on the ASCII branch: `fire` raises
        // `KitchenTicketError` with no station to route to, and a settled bill is
        // what the receipt cases dispatch from. No RECEIPT-only branch printer is
        // published for it by the seed, so its KOTs reach NO_PRINTER and persist
        // nothing — the queue there holds receipts alone, as the spec asserts.
        await tx.restaurantKitchenStation.upsert({
          where: { id: IDS.asciiReceiptStation },
          update: {
            branchId: IDS.asciiReceiptBranch,
            name: 'Receipt lab kitchen',
            active: true,
            isDefault: true,
          },
          create: {
            id: IDS.asciiReceiptStation,
            branchId: IDS.asciiReceiptBranch,
            name: 'Receipt lab kitchen',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        // Register and print bridge are one device here: `isBridgeRequest` only
        // requires an `rdk_` bearer, so no bridge-specific enrolment exists.
        await tx.restaurantRegisteredDevice.upsert({
          where: { id: IDS.asciiReceiptDevice },
          update: {
            branchId: IDS.asciiReceiptBranch,
            name: 'E2E ASCII Receipt POS',
            kind: 'POS',
            stationId: null,
            deviceSecretHash: deviceSecretHash(RESTAURANT_E2E_ASCII_RECEIPT_DEVICE_SECRET),
            status: 'ACTIVE',
            lastSeenAt: null,
            revokedAt: null,
          },
          create: {
            id: IDS.asciiReceiptDevice,
            branchId: IDS.asciiReceiptBranch,
            name: 'E2E ASCII Receipt POS',
            kind: 'POS',
            deviceSecretHash: deviceSecretHash(RESTAURANT_E2E_ASCII_RECEIPT_DEVICE_SECRET),
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantRegisteredDevice.upsert({
          where: { id: RESTAURANT_E2E.posDeviceId },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            name: 'E2E POS',
            kind: 'POS',
            stationId: null,
            deviceSecretHash: deviceSecretHash(RESTAURANT_E2E.posDeviceSecret),
            status: 'ACTIVE',
            lastSeenAt: null,
            revokedAt: null,
          },
          create: {
            id: RESTAURANT_E2E.posDeviceId,
            branchId: RESTAURANT_E2E.branchId,
            name: 'E2E POS',
            kind: 'POS',
            deviceSecretHash: deviceSecretHash(RESTAURANT_E2E.posDeviceSecret),
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantRegisteredDevice.upsert({
          where: { id: RESTAURANT_E2E.kdsDeviceId },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            name: 'E2E KDS',
            kind: 'KDS',
            stationId: IDS.grillStation,
            deviceSecretHash: deviceSecretHash(RESTAURANT_E2E.kdsDeviceSecret),
            status: 'ACTIVE',
            lastSeenAt: null,
            revokedAt: null,
          },
          create: {
            id: RESTAURANT_E2E.kdsDeviceId,
            branchId: RESTAURANT_E2E.branchId,
            name: 'E2E KDS',
            kind: 'KDS',
            stationId: IDS.grillStation,
            deviceSecretHash: deviceSecretHash(RESTAURANT_E2E.kdsDeviceSecret),
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        // One register per acceptance case, so the unlock burst gate's
        // `<deviceId>:<staffProfileId>` bucket is never shared across cases.
        // See `RESTAURANT_E2E.caseTerminalCount`.
        for (const index of CASE_TERMINAL_INDEXES) {
          const enrolment = caseRegisterDevice(index);
          const name = `E2E POS Case ${index}`;
          await tx.restaurantRegisteredDevice.upsert({
            where: { id: enrolment.deviceId },
            update: {
              branchId: RESTAURANT_E2E.branchId,
              name,
              kind: 'POS',
              stationId: null,
              deviceSecretHash: deviceSecretHash(enrolment.secret),
              status: 'ACTIVE',
              lastSeenAt: null,
              revokedAt: null,
            },
            create: {
              id: enrolment.deviceId,
              branchId: RESTAURANT_E2E.branchId,
              name,
              kind: 'POS',
              deviceSecretHash: deviceSecretHash(enrolment.secret),
              createdAt: FIXED_AT,
              updatedAt: FIXED_AT,
            },
          });
        }
        for (const device of [
          {
            id: RESTAURANT_E2E.deliveryPosDeviceId,
            name: 'E2E Delivery POS',
            kind: 'POS' as const,
            stationId: null,
            secret: RESTAURANT_E2E.deliveryPosDeviceSecret,
          },
          {
            id: RESTAURANT_E2E.deliveryKdsDeviceId,
            name: 'E2E Delivery KDS',
            kind: 'KDS' as const,
            stationId: IDS.deliveryStation,
            secret: RESTAURANT_E2E.deliveryKdsDeviceSecret,
          },
        ]) {
          await tx.restaurantRegisteredDevice.upsert({
            where: { id: device.id },
            update: {
              branchId: RESTAURANT_E2E.branchA2Id,
              name: device.name,
              kind: device.kind,
              stationId: device.stationId,
              deviceSecretHash: deviceSecretHash(device.secret),
              status: 'ACTIVE',
              lastSeenAt: null,
              revokedAt: null,
            },
            create: {
              id: device.id,
              branchId: RESTAURANT_E2E.branchA2Id,
              name: device.name,
              kind: device.kind,
              stationId: device.stationId,
              deviceSecretHash: deviceSecretHash(device.secret),
              createdAt: FIXED_AT,
              updatedAt: FIXED_AT,
            },
          });
        }
        // WHA-1567 — a REVOKED branch device. `withDeviceAuth` refuses one with
        // 403 'This device has been revoked.' before any print-queue read, and the
        // lane otherwise registers only ACTIVE devices, so that gate had no
        // executable proof against the running application. Nothing else may use
        // this row: revoked is its only reachable state.
        await tx.restaurantRegisteredDevice.upsert({
          where: { id: IDS.revokedBridgeDevice },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            name: 'E2E Revoked Print Bridge',
            kind: 'KDS',
            stationId: null,
            deviceSecretHash: deviceSecretHash(RESTAURANT_E2E_REVOKED_BRIDGE_DEVICE_SECRET),
            status: 'REVOKED',
            lastSeenAt: null,
            revokedAt: FIXED_AT,
          },
          create: {
            id: IDS.revokedBridgeDevice,
            branchId: RESTAURANT_E2E.branchId,
            name: 'E2E Revoked Print Bridge',
            kind: 'KDS',
            deviceSecretHash: deviceSecretHash(RESTAURANT_E2E_REVOKED_BRIDGE_DEVICE_SECRET),
            status: 'REVOKED',
            revokedAt: FIXED_AT,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantDrawerSession.upsert({
          where: { id: IDS.drawer },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            deviceId: RESTAURANT_E2E.posDeviceId,
            staffProfileId: RESTAURANT_E2E.operatorId,
            businessDate: CURRENT_BUSINESS_DATE,
            status: 'OPEN',
            openedAt: FIXED_AT,
            closedAt: null,
            openingFloat: '100.00',
            expectedCash: null,
            countedCash: null,
            variance: null,
          },
          create: {
            id: IDS.drawer,
            branchId: RESTAURANT_E2E.branchId,
            deviceId: RESTAURANT_E2E.posDeviceId,
            staffProfileId: RESTAURANT_E2E.operatorId,
            businessDate: CURRENT_BUSINESS_DATE,
            openingFloat: '100.00',
            openedAt: FIXED_AT,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });

        await tx.restaurantBrand.upsert({
          where: { id: IDS.brand },
          update: {
            name: 'Chai Chowk',
            nameLocalized: Prisma.DbNull,
            status: 'ACTIVE',
            isDefault: true,
          },
          create: {
            id: IDS.brand,
            name: 'Chai Chowk',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantCategory.upsert({
          where: { id: IDS.category },
          update: { parentId: null, name: 'Mains', nameLocalized: Prisma.DbNull, sortOrder: 0 },
          create: { id: IDS.category, name: 'Mains', createdAt: FIXED_AT, updatedAt: FIXED_AT },
        });
        await tx.restaurantProduct.upsert({
          where: { id: IDS.product },
          update: {
            categoryId: IDS.category,
            type: 'ITEM',
            status: 'ACTIVE',
            name: 'Chicken Tikka Bun',
            nameLocalized: Prisma.DbNull,
            description: null,
            descriptionLocalized: Prisma.DbNull,
            sortOrder: 0,
          },
          create: {
            id: IDS.product,
            categoryId: IDS.category,
            name: 'Chicken Tikka Bun',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantModifierGroup.upsert({
          where: { id: IDS.modifierGroup },
          update: { name: 'Heat', nameLocalized: Prisma.DbNull, minSelect: 1, maxSelect: 1 },
          create: {
            id: IDS.modifierGroup,
            name: 'Heat',
            minSelect: 1,
            maxSelect: 1,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantModifierOption.upsert({
          where: { id: IDS.modifierOption },
          update: {
            modifierGroupId: IDS.modifierGroup,
            name: 'Spicy',
            nameLocalized: Prisma.DbNull,
            priceDelta: '1.50',
            sortOrder: 0,
          },
          create: {
            id: IDS.modifierOption,
            modifierGroupId: IDS.modifierGroup,
            name: 'Spicy',
            priceDelta: '1.50',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantProductModifierGroup.upsert({
          where: { id: IDS.productModifier },
          update: { productId: IDS.product, modifierGroupId: IDS.modifierGroup, sortOrder: 0 },
          create: {
            id: IDS.productModifier,
            productId: IDS.product,
            modifierGroupId: IDS.modifierGroup,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantUnit.upsert({
          where: { id: IDS.unit },
          update: { name: 'Each', abbreviation: 'ea' },
          create: {
            id: IDS.unit,
            name: 'Each',
            abbreviation: 'ea',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantIngredient.upsert({
          where: { id: IDS.ingredient },
          update: {
            name: 'Tikka bun',
            nameLocalized: Prisma.DbNull,
            baseUnitId: IDS.unit,
            referenceCost: '3.0000',
          },
          create: {
            id: IDS.ingredient,
            name: 'Tikka bun',
            baseUnitId: IDS.unit,
            referenceCost: '3.0000',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantRecipe.upsert({
          where: { id: IDS.recipe },
          update: {
            productId: IDS.product,
            variantId: null,
            name: 'Chicken Tikka Bun BOM',
          },
          create: {
            id: IDS.recipe,
            productId: IDS.product,
            name: 'Chicken Tikka Bun BOM',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantRecipeVersion.upsert({
          where: { id: IDS.recipeVersion },
          update: {
            recipeId: IDS.recipe,
            versionNumber: 1,
            status: 'ACTIVE',
            portionCount: 1,
            activatedAt: FIXED_AT,
            supersededAt: null,
          },
          create: {
            id: IDS.recipeVersion,
            recipeId: IDS.recipe,
            versionNumber: 1,
            status: 'ACTIVE',
            portionCount: 1,
            activatedAt: FIXED_AT,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantRecipeLine.upsert({
          where: { id: IDS.recipeLine },
          update: {
            recipeVersionId: IDS.recipeVersion,
            ingredientId: IDS.ingredient,
            subRecipeId: null,
            quantity: '1.0000',
            unitId: IDS.unit,
            sortOrder: 0,
          },
          create: {
            id: IDS.recipeLine,
            recipeVersionId: IDS.recipeVersion,
            ingredientId: IDS.ingredient,
            quantity: '1.0000',
            unitId: IDS.unit,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantPriceList.upsert({
          where: { id: IDS.priceList },
          update: { name: 'Chai Chowk Prices', isDefault: true },
          create: {
            id: IDS.priceList,
            name: 'Chai Chowk Prices',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantPriceListVersion.upsert({
          where: { id: IDS.priceVersion },
          update: {
            priceListId: IDS.priceList,
            versionNumber: 1,
            effectiveFrom: FIXED_AT,
            status: 'ACTIVE',
            activatedAt: FIXED_AT,
            supersededAt: null,
          },
          create: {
            id: IDS.priceVersion,
            priceListId: IDS.priceList,
            versionNumber: 1,
            effectiveFrom: FIXED_AT,
            status: 'ACTIVE',
            activatedAt: FIXED_AT,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantPriceListEntry.upsert({
          where: { id: IDS.priceEntry },
          update: {
            priceListVersionId: IDS.priceVersion,
            productId: IDS.product,
            variantId: null,
            price: '12.50',
          },
          create: {
            id: IDS.priceEntry,
            priceListVersionId: IDS.priceVersion,
            productId: IDS.product,
            price: '12.50',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantMenu.upsert({
          where: { id: IDS.menu },
          update: {
            brandId: IDS.brand,
            name: 'Chai Chowk Menu',
            nameLocalized: Prisma.DbNull,
            description: null,
          },
          create: {
            id: IDS.menu,
            brandId: IDS.brand,
            name: 'Chai Chowk Menu',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantMenuSection.upsert({
          where: { id: IDS.menuSection },
          update: {
            menuId: IDS.menu,
            name: 'Mains',
            nameLocalized: Prisma.DbNull,
            sortOrder: 0,
          },
          create: {
            id: IDS.menuSection,
            menuId: IDS.menu,
            name: 'Mains',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantMenuItem.upsert({
          where: { id: IDS.menuItem },
          update: {
            sectionId: IDS.menuSection,
            productId: IDS.product,
            variantId: null,
            displayName: null,
            nameLocalized: Prisma.DbNull,
            sortOrder: 1,
          },
          create: {
            id: IDS.menuItem,
            sectionId: IDS.menuSection,
            productId: IDS.product,
            sortOrder: 1,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantBranchMenuPublication.upsert({
          where: { id: IDS.publication },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            menuId: IDS.menu,
            priceListId: IDS.priceList,
            status: 'PUBLISHED',
            channels: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
            publishedAt: FIXED_AT,
            retiredAt: null,
          },
          create: {
            id: IDS.publication,
            branchId: RESTAURANT_E2E.branchId,
            menuId: IDS.menu,
            priceListId: IDS.priceList,
            status: 'PUBLISHED',
            channels: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
            publishedAt: FIXED_AT,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantBranchMenuPublication.upsert({
          where: { id: IDS.deliveryPublication },
          update: {
            branchId: RESTAURANT_E2E.branchA2Id,
            menuId: IDS.menu,
            priceListId: IDS.priceList,
            status: 'PUBLISHED',
            channels: ['DELIVERY'],
            publishedAt: FIXED_AT,
            retiredAt: null,
          },
          create: {
            id: IDS.deliveryPublication,
            branchId: RESTAURANT_E2E.branchA2Id,
            menuId: IDS.menu,
            priceListId: IDS.priceList,
            status: 'PUBLISHED',
            channels: ['DELIVERY'],
            publishedAt: FIXED_AT,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        // Same menu and price list as the shipped branches: the ASCII branch
        // differs ONLY by name, which is the whole point of the fixture. A
        // narrower catalog would make its receipt totals a separate oracle.
        await tx.restaurantBranchMenuPublication.upsert({
          where: { id: IDS.asciiReceiptPublication },
          update: {
            branchId: IDS.asciiReceiptBranch,
            menuId: IDS.menu,
            priceListId: IDS.priceList,
            status: 'PUBLISHED',
            channels: ['DINE_IN'],
            publishedAt: FIXED_AT,
            retiredAt: null,
          },
          create: {
            id: IDS.asciiReceiptPublication,
            branchId: IDS.asciiReceiptBranch,
            menuId: IDS.menu,
            priceListId: IDS.priceList,
            status: 'PUBLISHED',
            channels: ['DINE_IN'],
            publishedAt: FIXED_AT,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantMenuAvailabilityWindow.upsert({
          where: { id: IDS.asciiReceiptAvailability },
          update: {
            publicationId: IDS.asciiReceiptPublication,
            menuItemId: null,
            label: 'Receipt lab always available',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            startMinutes: 0,
            endMinutes: 0,
          },
          create: {
            id: IDS.asciiReceiptAvailability,
            publicationId: IDS.asciiReceiptPublication,
            label: 'Receipt lab always available',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            startMinutes: 0,
            endMinutes: 0,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantMenuAvailabilityWindow.upsert({
          where: { id: IDS.availability },
          update: {
            publicationId: IDS.publication,
            menuItemId: null,
            label: 'Always available',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            startMinutes: 0,
            endMinutes: 0,
          },
          create: {
            id: IDS.availability,
            publicationId: IDS.publication,
            label: 'Always available',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            startMinutes: 0,
            endMinutes: 0,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantMenuAvailabilityWindow.upsert({
          where: { id: IDS.deliveryAvailability },
          update: {
            publicationId: IDS.deliveryPublication,
            menuItemId: null,
            label: 'Delivery always available',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            startMinutes: 0,
            endMinutes: 0,
          },
          create: {
            id: IDS.deliveryAvailability,
            publicationId: IDS.deliveryPublication,
            label: 'Delivery always available',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            startMinutes: 0,
            endMinutes: 0,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantStationRoutingRule.upsert({
          where: { id: IDS.routingRule },
          update: {
            stationId: IDS.grillStation,
            productId: IDS.product,
            categoryId: null,
            priority: 100,
          },
          create: {
            id: IDS.routingRule,
            stationId: IDS.grillStation,
            productId: IDS.product,
            priority: 100,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantStationRoutingRule.upsert({
          where: { id: IDS.deliveryRoutingRule },
          update: {
            stationId: IDS.deliveryStation,
            productId: IDS.product,
            categoryId: null,
            priority: 100,
          },
          create: {
            id: IDS.deliveryRoutingRule,
            stationId: IDS.deliveryStation,
            productId: IDS.product,
            priority: 100,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });

        await tx.restaurantCustomer.upsert({
          where: { id: IDS.customer },
          update: {
            displayName: 'E2E Guest',
            givenName: null,
            familyName: null,
            birthDate: null,
            notes: null,
            anonymizedAt: null,
          },
          create: {
            id: IDS.customer,
            displayName: 'E2E Guest',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantCustomerAddress.upsert({
          where: { id: IDS.customerAddress },
          update: {
            customerId: IDS.customer,
            label: 'Home',
            recipientName: 'E2E Guest',
            normalizedPhone: '+923001234567',
            addressLine1: '12 Delivery Street',
            addressLine2: null,
            locality: 'Gulberg',
            administrativeArea: 'Punjab',
            postalCode: '54660',
            countryCode: 'PK',
            latitude: null,
            longitude: null,
            isDefault: true,
            deletedAt: null,
          },
          create: {
            id: IDS.customerAddress,
            customerId: IDS.customer,
            label: 'Home',
            recipientName: 'E2E Guest',
            normalizedPhone: '+923001234567',
            addressLine1: '12 Delivery Street',
            locality: 'Gulberg',
            administrativeArea: 'Punjab',
            postalCode: '54660',
            countryCode: 'PK',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantDeliveryZone.upsert({
          where: { id: IDS.deliveryZone },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            name: 'Gulberg Central',
            active: true,
            fixedFee: '3.50',
            minimumSubtotal: '10.00',
            promisedMinutes: 35,
            sortOrder: 0,
            areaPostalLabel: 'Gulberg 54660',
          },
          create: {
            id: IDS.deliveryZone,
            branchId: RESTAURANT_E2E.branchId,
            name: 'Gulberg Central',
            fixedFee: '3.50',
            minimumSubtotal: '10.00',
            promisedMinutes: 35,
            areaPostalLabel: 'Gulberg 54660',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantDeliveryZone.upsert({
          where: { id: IDS.isolatedDeliveryZone },
          update: {
            branchId: RESTAURANT_E2E.branchA2Id,
            name: 'DHA Delivery Lane',
            active: true,
            fixedFee: '3.50',
            minimumSubtotal: '10.00',
            promisedMinutes: 35,
            sortOrder: 0,
            areaPostalLabel: 'DHA 54792',
          },
          create: {
            id: IDS.isolatedDeliveryZone,
            branchId: RESTAURANT_E2E.branchA2Id,
            name: 'DHA Delivery Lane',
            fixedFee: '3.50',
            minimumSubtotal: '10.00',
            promisedMinutes: 35,
            areaPostalLabel: 'DHA 54792',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        const existingLoyaltyProgram = await tx.loyaltyProgramVersion.findUnique({
          where: { id: IDS.loyaltyProgram },
          select: {
            id: true,
            versionNumber: true,
            effectiveFrom: true,
            earnRate: true,
            redemptionValue: true,
          },
        });
        if (existingLoyaltyProgram) {
          const matchesCanonicalFixture =
            existingLoyaltyProgram.versionNumber === 1 &&
            existingLoyaltyProgram.effectiveFrom.getTime() === FIXED_AT.getTime() &&
            existingLoyaltyProgram.earnRate.equals(new Prisma.Decimal('1.000000')) &&
            existingLoyaltyProgram.redemptionValue.equals(new Prisma.Decimal('0.010000'));
          if (!matchesCanonicalFixture) {
            throw new Error(
              `Immutable loyalty program ${IDS.loyaltyProgram} does not match the canonical fixture.`
            );
          }
        } else {
          await tx.loyaltyProgramVersion.create({
            data: {
              id: IDS.loyaltyProgram,
              versionNumber: 1,
              effectiveFrom: FIXED_AT,
              earnRate: '1.000000',
              redemptionValue: '0.010000',
              createdAt: FIXED_AT,
              updatedAt: FIXED_AT,
            },
          });
        }
        await tx.loyaltyAccount.upsert({
          where: { id: IDS.loyaltyAccount },
          update: {
            customerId: IDS.customer,
            active: true,
            enrolledAt: FIXED_AT,
            deactivatedAt: null,
          },
          create: {
            id: IDS.loyaltyAccount,
            customerId: IDS.customer,
            enrolledAt: FIXED_AT,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        const existingLoyaltyEntry = await tx.loyaltyPointsEntry.findUnique({
          where: { id: IDS.loyaltyEntry },
          select: {
            organizationId: true,
            accountId: true,
            programVersionId: true,
            kind: true,
            points: true,
            billId: true,
            refundId: true,
            reversesEntryId: true,
            actorId: true,
            reason: true,
            expiresAt: true,
            occurredAt: true,
            idempotencyKey: true,
            createdAt: true,
          },
        });
        if (existingLoyaltyEntry) {
          const matchesCanonicalFixture =
            existingLoyaltyEntry.organizationId === RESTAURANT_E2E.organizationId &&
            existingLoyaltyEntry.accountId === IDS.loyaltyAccount &&
            existingLoyaltyEntry.programVersionId === IDS.loyaltyProgram &&
            existingLoyaltyEntry.kind === 'ADJUSTMENT' &&
            existingLoyaltyEntry.points === 250 &&
            existingLoyaltyEntry.billId === null &&
            existingLoyaltyEntry.refundId === null &&
            existingLoyaltyEntry.reversesEntryId === null &&
            existingLoyaltyEntry.actorId === RESTAURANT_E2E.managerId &&
            existingLoyaltyEntry.reason === 'Deterministic E2E opening balance' &&
            existingLoyaltyEntry.expiresAt === null &&
            existingLoyaltyEntry.occurredAt.getTime() === FIXED_AT.getTime() &&
            existingLoyaltyEntry.idempotencyKey === 'restaurant-e2e-opening-balance-v1' &&
            existingLoyaltyEntry.createdAt.getTime() === FIXED_AT.getTime();
          if (!matchesCanonicalFixture) {
            throw new Error(
              `Immutable loyalty points entry ${IDS.loyaltyEntry} does not match the canonical fixture.`
            );
          }
        } else {
          await tx.loyaltyPointsEntry.create({
            data: {
              id: IDS.loyaltyEntry,
              organizationId: RESTAURANT_E2E.organizationId,
              accountId: IDS.loyaltyAccount,
              programVersionId: IDS.loyaltyProgram,
              kind: 'ADJUSTMENT',
              points: 250,
              billId: null,
              refundId: null,
              reversesEntryId: null,
              actorId: RESTAURANT_E2E.managerId,
              reason: 'Deterministic E2E opening balance',
              expiresAt: null,
              occurredAt: FIXED_AT,
              idempotencyKey: 'restaurant-e2e-opening-balance-v1',
              createdAt: FIXED_AT,
            },
          });
        }
        await tx.restaurantSopTemplate.upsert({
          where: { id: IDS.sopTemplate },
          update: {
            name: 'Opening food-safety check',
            category: 'OPENING',
            isActive: true,
          },
          create: {
            id: IDS.sopTemplate,
            name: 'Opening food-safety check',
            category: 'OPENING',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantSopTemplateVersion.upsert({
          where: { id: IDS.sopVersion },
          update: {
            templateId: IDS.sopTemplate,
            versionNumber: 1,
            status: 'PUBLISHED',
            publishedAt: FIXED_AT,
            retiredAt: null,
          },
          create: {
            id: IDS.sopVersion,
            templateId: IDS.sopTemplate,
            versionNumber: 1,
            status: 'PUBLISHED',
            publishedAt: FIXED_AT,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantSopTemplateStep.upsert({
          where: { id: IDS.sopStep },
          update: {
            templateVersionId: IDS.sopVersion,
            stepOrder: 1,
            title: 'Record cold-storage temperature',
            requiresPhoto: false,
            requiresSignature: false,
            requiresNote: true,
          },
          create: {
            id: IDS.sopStep,
            templateVersionId: IDS.sopVersion,
            stepOrder: 1,
            title: 'Record cold-storage temperature',
            requiresNote: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantSopAssignment.upsert({
          where: { id: IDS.sopAssignment },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            templateId: IDS.sopTemplate,
            frequency: 'DAILY',
            interval: 1,
            daysOfWeek: [],
            startDate: BUSINESS_DATE,
            endDate: null,
            dueTimeMinutes: 480,
            windowMinutes: 1440,
            graceMinutes: 0,
            active: true,
            assigneeTargetType: 'PERSON',
            assigneeStaffProfileId: RESTAURANT_E2E.operatorId,
            assigneeJobRoleId: null,
          },
          create: {
            id: IDS.sopAssignment,
            branchId: RESTAURANT_E2E.branchId,
            templateId: IDS.sopTemplate,
            frequency: 'DAILY',
            interval: 1,
            daysOfWeek: [],
            startDate: BUSINESS_DATE,
            dueTimeMinutes: 480,
            assigneeTargetType: 'PERSON',
            assigneeStaffProfileId: RESTAURANT_E2E.operatorId,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantSopOccurrence.upsert({
          where: { id: IDS.sopOccurrence },
          update: {
            assignmentId: IDS.sopAssignment,
            templateVersionId: IDS.sopVersion,
            branchId: RESTAURANT_E2E.branchId,
            businessDate: BUSINESS_DATE,
            status: 'SCHEDULED',
            dueAt: new Date('2026-08-27T03:00:00.000Z'),
            windowEndsAt: new Date('2026-08-28T03:00:00.000Z'),
            startedAt: null,
            submittedAt: null,
            resolvedAt: null,
            assignedStaffProfileId: RESTAURANT_E2E.operatorId,
            poolJobRoleId: null,
            claimedByStaffProfileId: null,
            claimedAt: null,
          },
          create: {
            id: IDS.sopOccurrence,
            assignmentId: IDS.sopAssignment,
            templateVersionId: IDS.sopVersion,
            branchId: RESTAURANT_E2E.branchId,
            businessDate: BUSINESS_DATE,
            status: 'SCHEDULED',
            dueAt: new Date('2026-08-27T03:00:00.000Z'),
            windowEndsAt: new Date('2026-08-28T03:00:00.000Z'),
            assignedStaffProfileId: RESTAURANT_E2E.operatorId,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        // WHA-1566 — the per-step checklist row a REAL occurrence gets from
        // `generateDueSopOccurrences`, which pins the published version's steps
        // into `restaurant_sop_occurrence_steps`. The occurrence above is upserted
        // directly, so that table was never populated and `completeStep` — which
        // looks the step up by (occurrenceId, templateStepId) — answered every
        // command with "Step not found on this occurrence.".
        //
        // Reset to the unstarted shape on every run, exactly like the occurrence
        // itself, so the acceptance lane is repeatable rather than single-use.
        await tx.restaurantSopOccurrenceStep.upsert({
          where: {
            occurrenceId_templateStepId: {
              occurrenceId: IDS.sopOccurrence,
              templateStepId: IDS.sopStep,
            },
          },
          update: {
            completed: false,
            completedAt: null,
            completedByStaffProfileId: null,
            note: null,
          },
          create: {
            id: IDS.sopOccurrenceStep,
            occurrenceId: IDS.sopOccurrence,
            templateStepId: IDS.sopStep,
            completed: false,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        // WHA-1238 first: the WHA-1565 stock movements are booked against the
        // stock location it creates, so ordering here is a dependency, not style.
        await seedBackOfficeStockFixture(tx, RESTAURANT_E2E.branchId);
        await seedRecipeProfitabilityFixture(tx, {
          branchId: RESTAURANT_E2E.branchId,
          locationId: BACK_OFFICE_STOCK.locationId,
          staffProfileId: RESTAURANT_E2E.operatorId,
          deviceId: RESTAURANT_E2E.posDeviceId,
        });
      },
      { timeout: 60_000 }
    );

    const verification = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'true', true)`,
        RESTAURANT_E2E.organizationId
      );
      const alexMemberships = await tx.user.findMany({
        where: { email: ALEX_EMAIL },
        select: { organizationId: true },
        orderBy: { organizationId: 'asc' },
      });
      const operator = await tx.user.findUniqueOrThrow({
        where: { id: IDS.operatorUser },
        select: {
          email: true,
          organizationRole: { select: { key: true } },
          restaurantBranchAssignments: { select: { branchId: true } },
        },
      });
      const ownedRows = [];
      for (const [table, ids] of RESTAURANT_E2E_OWNED_FIXTURES) {
        const rows = await tx.$queryRaw<Array<{ id: string; organizationId: string }>>(
          Prisma.sql`SELECT id, ${
            table === 'organizations' ? Prisma.sql`id` : Prisma.sql`"organizationId"`
          } AS "organizationId" FROM ${Prisma.raw(table)} WHERE id IN (${Prisma.join([...ids])})`
        );
        ownedRows.push({ table, expected: ids.length, rows });
      }
      return { alexMemberships, operator, ownedRows };
    });

    const alexOrganizations = new Set(
      verification.alexMemberships.map(({ organizationId }) => organizationId)
    );
    if (
      String(RESTAURANT_E2E.organizationId) === DEVFATHOM_ORGANIZATION_ID ||
      !alexOrganizations.has(DEVFATHOM_ORGANIZATION_ID) ||
      !alexOrganizations.has(RESTAURANT_E2E.organizationId) ||
      verification.operator.email !== OPERATOR_EMAIL ||
      verification.operator.organizationRole?.key !== 'restaurant-e2e-operator' ||
      verification.operator.restaurantBranchAssignments.length !== 1 ||
      verification.operator.restaurantBranchAssignments[0]?.branchId !== RESTAURANT_E2E.branchId ||
      verification.ownedRows.some(
        ({ expected, rows }) =>
          rows.length !== expected ||
          new Set(rows.map(({ id }) => id)).size !== expected ||
          rows.some(({ organizationId }) => organizationId !== RESTAURANT_E2E.organizationId)
      )
    ) {
      throw new Error('Chai Chowk tenant-separation verification failed.');
    }

    console.log(
      `Seeded and verified Chai Chowk (${RESTAURANT_E2E.organizationId}): Alex belongs to ${[...alexOrganizations].join(', ')}; exact owned fixture rows=${RESTAURANT_E2E_OWNED_ROW_COUNT}; leaked fixture rows=0.`
    );

    // WHA-1553 — the two isolated Insights completion acceptance tenants. They
    // own separate organizations and never read or write Chai Chowk's rows, so
    // they run after the verification above rather than inside it.
    await seedFirstSaleTenant(prisma, devFathomAlexPassword!);
    seedCurrentWindowClose(databaseUrl);

    const insightsCompletion = await seedRestaurantInsightsCompletionFixtures(prisma);
    console.log(
      `Seeded restaurant Insights completion fixtures: ${JSON.stringify(insightsCompletion)}`
    );

    // Showcase layer (SEED DATA ONLY, WHA-223). Skipped unless asked for, so CI
    // keeps seeding exactly the minimal fixture the Playwright specs assert on.
    if (process.env.RESTAURANT_DEMO_SEED === '1') {
      const counts = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)`,
            RESTAURANT_E2E.organizationId
          );
          return seedRestaurantDemoTenant(tx);
        },
        { timeout: 180_000, maxWait: 30_000 }
      );

      console.log(`Seeded restaurant showcase demo data: ${JSON.stringify(counts)}`);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Restaurant E2E seed failed.');
  process.exitCode = 1;
});
