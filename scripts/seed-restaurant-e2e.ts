import { createHash } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { hashSync } from 'bcryptjs';
import 'dotenv/config';
import pg from 'pg';

import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  adminDepartmentKeyForVertical,
  defaultDepartmentRowsForVertical,
} from '../src/lib/vertical-catalog.js';

export const RESTAURANT_E2E = {
  organizationId: 'org_restaurant_e2e',
  branchId: 'branch_restaurant_e2e',
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
} as const;

const FIXED_AT = new Date('2026-08-27T00:00:00.000Z');
const BUSINESS_DATE = new Date('2026-08-27T00:00:00.000Z');
const PIN_BCRYPT_SALT = '$2b$12$abcdefghijklmnopqrstuu';

function deviceSecretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required; refusing DATABASE_URL.');

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

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
      await tx.organization.upsert({
        where: { id: RESTAURANT_E2E.organizationId },
        update: {},
        create: {
          id: RESTAURANT_E2E.organizationId,
          slug: 'restaurant-e2e',
          legalName: 'Restaurant E2E Test Organization',
          displayName: 'Restaurant E2E',
          vertical: 'RESTAURANT',
          status: 'ACTIVE',
          timezone: 'UTC',
          currency: 'USD',
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
      await tx.organizationDepartment.createMany({
        data: defaultDepartmentRowsForVertical('RESTAURANT').map((department) => ({
          ...department,
          id: `department_restaurant_e2e_${department.key.toLowerCase()}`,
          organizationId: RESTAURANT_E2E.organizationId,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        })),
        skipDuplicates: true,
      });
    });

    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)`,
          RESTAURANT_E2E.organizationId
        );
        await tx.restaurantBranch.upsert({
          where: { id: RESTAURANT_E2E.branchId },
          update: {},
          create: {
            id: RESTAURANT_E2E.branchId,
            name: 'Test Kitchen',
            timezone: 'UTC',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.organizationRole.upsert({
          where: { id: IDS.operatorRole },
          update: {},
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
          update: {},
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
            id: IDS.operatorUser,
            roleId: IDS.operatorRole,
            name: 'E2E Operator',
            email: 'operator@restaurant-e2e.test',
            title: 'Operator',
          },
          {
            id: IDS.managerUser,
            roleId: IDS.managerRole,
            name: 'E2E Manager',
            email: 'manager@restaurant-e2e.test',
            title: 'Manager',
          },
        ]) {
          await tx.user.upsert({
            where: { id: user.id },
            update: {},
            create: {
              id: user.id,
              organizationRoleId: user.roleId,
              name: user.name,
              email: user.email,
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
            update: {},
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
            update: {},
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
            update: {},
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
          update: {},
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
          update: {},
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
          update: {},
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
          update: {},
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
          update: {},
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
          update: {},
          create: {
            id: IDS.brand,
            name: 'E2E Kitchen',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantCategory.upsert({
          where: { id: IDS.category },
          update: {},
          create: { id: IDS.category, name: 'Mains', createdAt: FIXED_AT, updatedAt: FIXED_AT },
        });
        await tx.restaurantProduct.upsert({
          where: { id: IDS.product },
          update: {},
          create: {
            id: IDS.product,
            categoryId: IDS.category,
            name: 'Test Burger',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantPriceList.upsert({
          where: { id: IDS.priceList },
          update: {},
          create: {
            id: IDS.priceList,
            name: 'E2E Prices',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantPriceListVersion.upsert({
          where: { id: IDS.priceVersion },
          update: {},
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
          update: {},
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
          update: {},
          create: {
            id: IDS.menu,
            brandId: IDS.brand,
            name: 'E2E Menu',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.restaurantMenuSection.upsert({
          where: { id: IDS.menuSection },
          update: {},
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
          update: {},
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
          update: {},
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
          update: {},
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
          update: {},
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
          update: {},
          create: {
            id: IDS.customer,
            displayName: 'E2E Guest',
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.loyaltyProgramVersion.upsert({
          where: { id: IDS.loyaltyProgram },
          update: {},
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
          update: {},
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
          update: {},
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
      },
      { timeout: 30_000 }
    );

    console.log(`Seeded restaurant E2E fixture for ${RESTAURANT_E2E.organizationId}.`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Restaurant E2E seed failed.');
  process.exitCode = 1;
});
