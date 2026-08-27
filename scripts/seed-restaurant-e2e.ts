import { createHash } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { hashSync } from 'bcryptjs';
import 'dotenv/config';
import pg from 'pg';

import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  seedRestaurantDemoControlPlane,
  seedRestaurantDemoTenant,
} from './seed-restaurant-demo.js';

export const RESTAURANT_E2E = {
  organizationId: 'org_chai_chowk',
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
} as const;

const FIXED_AT = new Date('2026-08-27T00:00:00.000Z');
const BUSINESS_DATE = new Date('2026-08-27T00:00:00.000Z');
const PIN_BCRYPT_SALT = '$2b$12$abcdefghijklmnopqrstuu';
const DEVFATHOM_ORGANIZATION_ID = 'org_devfathom';
const ALEX_EMAIL = 'alex@company.com';

function deviceSecretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required; refusing DATABASE_URL.');

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
          timezone: 'Asia/Karachi',
          currency: 'PKR',
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
    });

    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)`,
          RESTAURANT_E2E.organizationId
        );
        await tx.restaurantBranch.upsert({
          where: { id: RESTAURANT_E2E.branchId },
          update: { name: 'Gulberg Café', timezone: 'Asia/Karachi', isDefault: true },
          create: {
            id: RESTAURANT_E2E.branchId,
            name: 'Gulberg Café',
            timezone: 'Asia/Karachi',
            isDefault: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.organizationRole.upsert({
          where: { id: IDS.operatorRole },
          update: { name: 'Chai Chowk Operator' },
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
          update: { name: 'Chai Chowk Manager' },
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
              title: user.title,
              status: 'ACTIVE',
            },
            create: {
              id: user.id,
              organizationRoleId: user.roleId,
              name: user.name,
              email: user.email,
              password: user.password,
              department: 'LEADERSHIP',
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
          update: { name: 'Chai Chowk', isDefault: true },
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
          update: {},
          create: { id: IDS.category, name: 'Mains', createdAt: FIXED_AT, updatedAt: FIXED_AT },
        });
        await tx.restaurantProduct.upsert({
          where: { id: IDS.product },
          update: { categoryId: IDS.category, name: 'Chicken Tikka Bun' },
          create: {
            id: IDS.product,
            categoryId: IDS.category,
            name: 'Chicken Tikka Bun',
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
          update: { brandId: IDS.brand, name: 'Chai Chowk Menu' },
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

    const verification = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_organization_id', '', true), set_config('app.is_platform_admin', 'true', true)`
      );
      const [alexMemberships, ownedRows, leakedRows] = await Promise.all([
        tx.user.findMany({
          where: { email: ALEX_EMAIL },
          select: { organizationId: true },
          orderBy: { organizationId: 'asc' },
        }),
        tx.$queryRaw<Array<{ roles: bigint; staff: bigint; products: bigint }>>`
          SELECT
            (SELECT count(*) FROM organization_roles WHERE "organizationId" = ${RESTAURANT_E2E.organizationId}) AS roles,
            (SELECT count(*) FROM restaurant_staff_profiles WHERE "organizationId" = ${RESTAURANT_E2E.organizationId}) AS staff,
            (SELECT count(*) FROM restaurant_products WHERE "organizationId" = ${RESTAURANT_E2E.organizationId}) AS products
        `,
        tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count
          FROM (
            SELECT "organizationId" FROM organization_roles WHERE id IN (${IDS.operatorRole}, ${IDS.managerRole})
            UNION ALL
            SELECT "organizationId" FROM restaurant_staff_profiles WHERE id IN (${IDS.alexStaff}, ${RESTAURANT_E2E.operatorId}, ${RESTAURANT_E2E.managerId})
            UNION ALL
            SELECT "organizationId" FROM restaurant_products WHERE id = ${IDS.product}
          ) fixture_rows
          WHERE "organizationId" <> ${RESTAURANT_E2E.organizationId}
        `,
      ]);
      return { alexMemberships, ownedRows: ownedRows[0], leakedRows: leakedRows[0] };
    });

    const alexOrganizations = new Set(
      verification.alexMemberships.map(({ organizationId }) => organizationId)
    );
    if (
      String(RESTAURANT_E2E.organizationId) === DEVFATHOM_ORGANIZATION_ID ||
      !alexOrganizations.has(DEVFATHOM_ORGANIZATION_ID) ||
      !alexOrganizations.has(RESTAURANT_E2E.organizationId) ||
      !verification.ownedRows ||
      Number(verification.ownedRows.roles) < 2 ||
      Number(verification.ownedRows.staff) < 3 ||
      Number(verification.ownedRows.products) < 1 ||
      !verification.leakedRows ||
      Number(verification.leakedRows.count) !== 0
    ) {
      throw new Error('Chai Chowk tenant-separation verification failed.');
    }

    console.log(
      `Seeded and verified Chai Chowk (${RESTAURANT_E2E.organizationId}): Alex belongs to ${[...alexOrganizations].join(', ')}; roles=${verification.ownedRows.roles}, staff=${verification.ownedRows.staff}, products=${verification.ownedRows.products}, leaked fixture rows=${verification.leakedRows.count}.`
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
