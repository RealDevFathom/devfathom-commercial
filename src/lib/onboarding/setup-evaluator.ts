import type { PrismaClient } from '@/generated/prisma/client';
import { evaluatePharmacyReadiness } from '@/lib/pharmacy/onboarding';
import { roleTemplatesForVertical } from '@/lib/vertical-catalog';

export type SetupChecklistStatus = 'Done' | 'Needs you' | 'Optional';
export type SetupChecklistItemKey =
  'branch' | 'staff' | 'stations' | 'catalog' | 'tax' | 'first-sale';

export type SetupChecklistItem = {
  key: SetupChecklistItemKey;
  label: string;
  status: SetupChecklistStatus;
  why: string;
  actionLabel: string;
  href: string;
  optional: boolean;
};

export type SetupChecklist = {
  vertical: 'RESTAURANT' | 'PHARMACY';
  items: readonly SetupChecklistItem[];
  complete: boolean;
};

export type SetupEvidence = {
  hasBranch: boolean;
  hasProvisionedRoles: boolean;
  hasStationOrPrinter: boolean;
  hasCatalog: boolean;
  hasOpeningStock: boolean;
  hasTax: boolean;
  hasFirstSale: boolean;
};

const status = (done: boolean, optional = false): SetupChecklistStatus =>
  done ? 'Done' : optional ? 'Optional' : 'Needs you';

export function evaluateSetupChecklist(
  vertical: SetupChecklist['vertical'],
  evidence: SetupEvidence
): SetupChecklist {
  const restaurant = vertical === 'RESTAURANT';
  const catalogDone = evidence.hasCatalog && (restaurant || evidence.hasOpeningStock);
  const items: SetupChecklistItem[] = [
    {
      key: 'branch',
      label: 'Branch',
      status: status(evidence.hasBranch),
      why: evidence.hasBranch
        ? 'An active location is ready for daily operations.'
        : 'Your first sale needs an active operating location.',
      actionLabel: evidence.hasBranch ? 'Review branches' : 'Set up a branch',
      href: restaurant ? '/restaurant/settings/branches' : '/pharmacy/inventory',
      optional: false,
    },
    {
      key: 'staff',
      label: 'Staff and roles',
      status: status(evidence.hasProvisionedRoles),
      why: evidence.hasProvisionedRoles
        ? 'The required system roles were provisioned automatically.'
        : 'Provisioned roles keep staff access consistent and least-privileged.',
      actionLabel: evidence.hasProvisionedRoles ? 'Review staff' : 'Finish staff setup',
      href: restaurant ? '/restaurant/staff' : '/organization',
      optional: false,
    },
    {
      key: 'stations',
      label: restaurant ? 'Stations and printers' : 'Counter device',
      status: status(evidence.hasStationOrPrinter, true),
      why: evidence.hasStationOrPrinter
        ? 'At least one active station, printer route, or counter device is configured.'
        : 'Optional for a test sale; add hardware when this location is ready.',
      actionLabel: evidence.hasStationOrPrinter ? 'Review devices' : 'Set up later',
      href: restaurant ? '/restaurant/devices' : '/settings',
      optional: true,
    },
    {
      key: 'catalog',
      label: restaurant ? 'Published menu' : 'Catalog and opening stock',
      status: status(catalogDone),
      why: catalogDone
        ? restaurant
          ? 'A published menu gives the register saleable items.'
          : 'A published medicine and received opening stock are ready to sell.'
        : restaurant
          ? 'Publish a priced menu before opening the register.'
          : 'Publish a medicine and receive opening stock before a test sale.',
      actionLabel: catalogDone
        ? `Review ${restaurant ? 'menus' : 'inventory'}`
        : `Set up ${restaurant ? 'a menu' : 'inventory'}`,
      href: restaurant ? '/restaurant/menus' : '/pharmacy/inventory',
      optional: false,
    },
    {
      key: 'tax',
      label: 'Tax',
      status: status(evidence.hasTax, !restaurant),
      why: evidence.hasTax
        ? 'An active tax profile is available for checkout.'
        : restaurant
          ? 'Publish the branch tax profile used at checkout.'
          : 'Pharmacy tax setup is not yet required by the available counter flow.',
      actionLabel: evidence.hasTax
        ? 'Review tax'
        : restaurant
          ? 'Set up tax'
          : 'Review organization',
      href: restaurant ? '/restaurant/tax' : '/organization',
      optional: !restaurant,
    },
    {
      key: 'first-sale',
      label: 'First test sale',
      status: status(evidence.hasFirstSale),
      why: evidence.hasFirstSale
        ? 'A completed sale proves the core checkout path.'
        : 'Complete one test checkout to verify the workspace end to end.',
      actionLabel: evidence.hasFirstSale ? 'Review sales' : 'Make a test sale',
      href: restaurant ? '/pos' : '/pharmacy/reports?section=sales',
      optional: false,
    },
  ];

  return {
    vertical,
    items,
    complete: items.every((item) => item.optional || item.status === 'Done'),
  };
}

export async function loadSetupChecklist(
  db: PrismaClient,
  organizationId: string,
  vertical: SetupChecklist['vertical'],
  at: Date = new Date()
): Promise<SetupChecklist> {
  const requiredRoleKeys = roleTemplatesForVertical(vertical).map((template) => template.key);

  if (vertical === 'PHARMACY') {
    const [readiness, branchCount, deviceCount, firstSaleCount] = await Promise.all([
      evaluatePharmacyReadiness(db, organizationId, at),
      db.pharmacyBranch.count({ where: { organizationId, active: true } }),
      db.pharmacyRegisteredDevice.count({ where: { organizationId, status: 'ACTIVE' } }),
      db.pharmacySale.count({ where: { organizationId, status: 'COMPLETED' } }),
    ]);
    const gatePassed = (gate: (typeof readiness.gates)[number]['gate']) =>
      readiness.gates.some((result) => result.gate === gate && result.status === 'PASSED');

    return evaluateSetupChecklist(vertical, {
      hasBranch: branchCount > 0,
      hasProvisionedRoles: gatePassed('OWNER_AND_ROLE_TEMPLATES'),
      hasStationOrPrinter: deviceCount > 0,
      hasCatalog: gatePassed('MEDICINE_CATALOG_READINESS'),
      hasOpeningStock: gatePassed('OPENING_STOCK_READINESS'),
      hasTax: false,
      hasFirstSale: firstSaleCount > 0,
    });
  }

  const [branchCount, roleCount, stationCount, printRouteCount, menuCount, taxCount, saleCount] =
    await Promise.all([
      db.restaurantBranch.count({ where: { organizationId, active: true } }),
      db.organizationRole.count({ where: { organizationId, key: { in: requiredRoleKeys } } }),
      db.restaurantKitchenStation.count({ where: { organizationId, active: true } }),
      db.restaurantPrintRoute.count({ where: { organizationId, enabled: true } }),
      db.restaurantBranchMenuPublication.count({ where: { organizationId, status: 'PUBLISHED' } }),
      db.restaurantTaxProfileVersion.count({
        where: {
          organizationId,
          status: 'PUBLISHED',
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        },
      }),
      db.restaurantOrder.count({ where: { organizationId, status: 'CLOSED' } }),
    ]);

  return evaluateSetupChecklist(vertical, {
    hasBranch: branchCount > 0,
    hasProvisionedRoles: requiredRoleKeys.length > 0 && roleCount >= requiredRoleKeys.length,
    hasStationOrPrinter: stationCount > 0 || printRouteCount > 0,
    hasCatalog: menuCount > 0,
    hasOpeningStock: true,
    hasTax: taxCount > 0,
    hasFirstSale: saleCount > 0,
  });
}
