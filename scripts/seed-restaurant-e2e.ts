import { createHash } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { hashSync } from 'bcryptjs';
import 'dotenv/config';
import pg from 'pg';

import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import {
  seedRestaurantDemoControlPlane,
  seedRestaurantDemoTenant,
} from './seed-restaurant-demo.js';
import {
  adminDepartmentKeyForVertical,
  defaultDepartmentRowsForVertical,
} from '../src/lib/vertical-catalog.js';
import { resolveRestaurantE2eDatabaseUrl } from './restaurant-e2e-database.js';

export const RESTAURANT_E2E = {
  organizationId: 'org_chai_chowk',
  branchId: 'branch_restaurant_e2e',
  branchA2Id: 'branch_restaurant_e2e_a2',
  posDeviceId: 'device_restaurant_e2e_pos',
  kdsDeviceId: 'device_restaurant_e2e_kds',
  operatorId: 'staff_restaurant_e2e_operator',
  managerId: 'staff_restaurant_e2e_manager',
  operatorPin: '424242',
  managerPin: '848484',
  posDeviceSecret: 'rdk_restaurant_e2e_pos_local_ci_only',
  kdsDeviceSecret: 'rdk_restaurant_e2e_kds_local_ci_only',
} as const;

const IDS = {
  alexUser: 'user_chai_chowk_alex',
  alexStaff: 'staff_chai_chowk_alex',
  operatorUser: 'user_restaurant_e2e_operator',
  managerUser: 'user_restaurant_e2e_manager',
  operatorRole: 'role_restaurant_e2e_operator',
  managerRole: 'role_restaurant_e2e_manager',
  operatorCredential: 'credential_restaurant_e2e_operator',
  managerCredential: 'credential_restaurant_e2e_manager',
  drawer: 'drawer_restaurant_e2e',
  grillStation: 'station_restaurant_e2e_grill',
  expoStation: 'station_restaurant_e2e_expo',
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
  availability: 'availability_restaurant_e2e_always',
  routingRule: 'routing_restaurant_e2e_burger',
  customer: 'customer_restaurant_e2e',
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
} as const;

export const RESTAURANT_E2E_OWNED_FIXTURES = [
  ['organizations', [RESTAURANT_E2E.organizationId]],
  [
    'organization_departments',
    ['department_restaurant_e2e_kitchen', 'department_restaurant_e2e_front_of_house'],
  ],
  ['organization_roles', [IDS.operatorRole, IDS.managerRole]],
  [
    'organization_role_permissions',
    [
      'permission_restaurant_e2e_operator_0',
      'permission_restaurant_e2e_operator_1',
      'permission_restaurant_e2e_operator_2',
      'permission_restaurant_e2e_operator_3',
      'permission_restaurant_e2e_manager_all',
    ],
  ],
  ['users', [IDS.alexUser, IDS.operatorUser, IDS.managerUser]],
  [
    'restaurant_branch_assignments',
    [
      `assignment_${IDS.alexUser}`,
      `assignment_${IDS.operatorUser}`,
      `assignment_${IDS.managerUser}`,
    ],
  ],
  [
    'restaurant_staff_profiles',
    [IDS.alexStaff, RESTAURANT_E2E.operatorId, RESTAURANT_E2E.managerId],
  ],
  [
    'restaurant_operator_credentials',
    ['credential_chai_chowk_alex', IDS.operatorCredential, IDS.managerCredential],
  ],
  ['restaurant_branches', [RESTAURANT_E2E.branchId, RESTAURANT_E2E.branchA2Id]],
  ['restaurant_floors', [IDS.floor]],
  ['restaurant_tables', [IDS.table]],
  ['restaurant_kitchen_stations', [IDS.grillStation, IDS.expoStation]],
  ['restaurant_registered_devices', [RESTAURANT_E2E.posDeviceId, RESTAURANT_E2E.kdsDeviceId]],
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
  ['restaurant_branch_menu_publications', [IDS.publication]],
  ['restaurant_menu_availability_windows', [IDS.availability]],
  ['restaurant_station_routing_rules', [IDS.routingRule]],
  ['restaurant_customers', [IDS.customer]],
  ['restaurant_loyalty_program_versions', [IDS.loyaltyProgram]],
  ['restaurant_loyalty_accounts', [IDS.loyaltyAccount]],
  ['restaurant_loyalty_points_entries', [IDS.loyaltyEntry]],
  ['restaurant_sop_templates', [IDS.sopTemplate]],
  ['restaurant_sop_template_versions', [IDS.sopVersion]],
  ['restaurant_sop_template_steps', [IDS.sopStep]],
  ['restaurant_sop_assignments', [IDS.sopAssignment]],
  ['restaurant_sop_occurrences', [IDS.sopOccurrence]],
] as const;

export const RESTAURANT_E2E_OWNED_ROW_COUNT = RESTAURANT_E2E_OWNED_FIXTURES.reduce(
  (count, [, ids]) => count + ids.length,
  0
);

const FIXED_AT = new Date('2026-08-27T00:00:00.000Z');
const BUSINESS_DATE = new Date('2026-08-27T00:00:00.000Z');
const PIN_BCRYPT_SALT = '$2b$12$abcdefghijklmnopqrstuu';
const DEVFATHOM_ORGANIZATION_ID = 'org_devfathom';
const ALEX_EMAIL = 'alex@company.com';

function deviceSecretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

async function main() {
  const databaseUrl = resolveRestaurantE2eDatabaseUrl();

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
              create: ['payments:collect', 'cash:open', 'cash:adjust', 'cash:close'].map(
                (capability, index) => ({
                  id: `permission_restaurant_e2e_operator_${index}`,
                  capability,
                  effect: 'ALLOW' as const,
                  createdAt: FIXED_AT,
                })
              ),
            },
          },
          create: {
            id: IDS.operatorRole,
            key: 'restaurant-e2e-operator',
            name: 'Restaurant E2E Operator',
            permissions: {
              create: ['payments:collect', 'cash:open', 'cash:adjust', 'cash:close'].map(
                (capability, index) => ({
                  id: `permission_restaurant_e2e_operator_${index}`,
                  capability,
                  effect: 'ALLOW' as const,
                  createdAt: FIXED_AT,
                })
              ),
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
        for (const user of [
          {
            id: IDS.alexUser,
            roleId: IDS.managerRole,
            name: 'Alex Carter',
            email: ALEX_EMAIL,
            title: 'Owner',
            password: devFathomAlexPassword,
          },
          {
            id: IDS.operatorUser,
            roleId: IDS.operatorRole,
            name: 'E2E Operator',
            email: 'operator@restaurant-e2e.test',
            title: 'Operator',
            password: null,
          },
          {
            id: IDS.managerUser,
            roleId: IDS.managerRole,
            name: 'E2E Manager',
            email: 'manager@restaurant-e2e.test',
            title: 'Manager',
            password: null,
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
              role: 'EMPLOYEE',
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
            where: { branchId_userId: { branchId: RESTAURANT_E2E.branchId, userId: user.id } },
            update: { branchId: RESTAURANT_E2E.branchId, userId: user.id },
            create: {
              id: `assignment_${user.id}`,
              branchId: RESTAURANT_E2E.branchId,
              userId: user.id,
              createdAt: FIXED_AT,
              updatedAt: FIXED_AT,
            },
          });
        }
        for (const staff of [
          {
            id: IDS.alexStaff,
            userId: IDS.alexUser,
            name: 'Alex Carter',
            pin: RESTAURANT_E2E.managerPin,
            credentialId: 'credential_chai_chowk_alex',
          },
          {
            id: RESTAURANT_E2E.operatorId,
            userId: IDS.operatorUser,
            name: 'E2E Operator',
            pin: RESTAURANT_E2E.operatorPin,
            credentialId: IDS.operatorCredential,
          },
          {
            id: RESTAURANT_E2E.managerId,
            userId: IDS.managerUser,
            name: 'E2E Manager',
            pin: RESTAURANT_E2E.managerPin,
            credentialId: IDS.managerCredential,
          },
        ]) {
          await tx.restaurantStaffProfile.upsert({
            where: { id: staff.id },
            update: {
              userId: staff.userId,
              displayName: staff.name,
              email: null,
              primaryBranchId: RESTAURANT_E2E.branchId,
              status: 'ACTIVE',
            },
            create: {
              id: staff.id,
              userId: staff.userId,
              displayName: staff.name,
              primaryBranchId: RESTAURANT_E2E.branchId,
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
        await tx.restaurantDrawerSession.upsert({
          where: { id: IDS.drawer },
          update: {
            branchId: RESTAURANT_E2E.branchId,
            deviceId: RESTAURANT_E2E.posDeviceId,
            staffProfileId: RESTAURANT_E2E.operatorId,
            businessDate: BUSINESS_DATE,
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
            businessDate: BUSINESS_DATE,
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
            channels: ['DINE_IN', 'TAKEAWAY'],
            publishedAt: FIXED_AT,
            retiredAt: null,
          },
          create: {
            id: IDS.publication,
            branchId: RESTAURANT_E2E.branchId,
            menuId: IDS.menu,
            priceListId: IDS.priceList,
            status: 'PUBLISHED',
            channels: ['DINE_IN', 'TAKEAWAY'],
            publishedAt: FIXED_AT,
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
        await tx.loyaltyProgramVersion.upsert({
          where: { id: IDS.loyaltyProgram },
          update: {
            versionNumber: 1,
            effectiveFrom: FIXED_AT,
            earnRate: '1.000000',
            redemptionValue: '0.010000',
          },
          create: {
            id: IDS.loyaltyProgram,
            versionNumber: 1,
            effectiveFrom: FIXED_AT,
            earnRate: '1.000000',
            redemptionValue: '0.010000',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
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
        await tx.loyaltyPointsEntry.upsert({
          where: { id: IDS.loyaltyEntry },
          update: {
            accountId: IDS.loyaltyAccount,
            programVersionId: IDS.loyaltyProgram,
            kind: 'ADJUSTMENT',
            points: 250,
            actorId: RESTAURANT_E2E.managerId,
            reason: 'Deterministic E2E opening balance',
            occurredAt: FIXED_AT,
            idempotencyKey: 'restaurant-e2e-opening-balance-v1',
          },
          create: {
            id: IDS.loyaltyEntry,
            accountId: IDS.loyaltyAccount,
            programVersionId: IDS.loyaltyProgram,
            kind: 'ADJUSTMENT',
            points: 250,
            actorId: RESTAURANT_E2E.managerId,
            reason: 'Deterministic E2E opening balance',
            occurredAt: FIXED_AT,
            idempotencyKey: 'restaurant-e2e-opening-balance-v1',
            createdAt: FIXED_AT,
          },
        });
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
      },
      { timeout: 30_000 }
    );

    const verification = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_organization_id', '', true), set_config('app.is_platform_admin', 'true', true)`
      );
      const [alexMemberships, ownedRows] = await Promise.all([
        tx.user.findMany({
          where: { email: ALEX_EMAIL },
          select: { organizationId: true },
          orderBy: { organizationId: 'asc' },
        }),
        Promise.all(
          RESTAURANT_E2E_OWNED_FIXTURES.map(async ([table, ids]) => {
            const rows = await tx.$queryRaw<Array<{ id: string; organizationId: string }>>(
              Prisma.sql`SELECT id, ${
                table === 'organizations' ? Prisma.sql`id` : Prisma.sql`"organizationId"`
              } AS "organizationId" FROM ${Prisma.raw(table)} WHERE id IN (${Prisma.join([...ids])})`
            );
            return { table, expected: ids.length, rows };
          })
        ),
      ]);
      return { alexMemberships, ownedRows };
    });

    const alexOrganizations = new Set(
      verification.alexMemberships.map(({ organizationId }) => organizationId)
    );
    if (
      String(RESTAURANT_E2E.organizationId) === DEVFATHOM_ORGANIZATION_ID ||
      !alexOrganizations.has(DEVFATHOM_ORGANIZATION_ID) ||
      !alexOrganizations.has(RESTAURANT_E2E.organizationId) ||
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

    // Showcase layer (SEED DATA ONLY, WHA-223). Skipped unless asked for, so CI
    // keeps seeding exactly the minimal fixture the Playwright specs assert on.
    if (process.env.RESTAURANT_DEMO_SEED === '1') {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_organization_id', '', true), set_config('app.is_platform_admin', 'true', true)`
        );
        await seedRestaurantDemoControlPlane(tx);
      });

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
