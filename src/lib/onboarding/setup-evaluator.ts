import type { PrismaClient } from '@/generated/prisma/client';
import { evaluatePharmacyReadiness } from '@/lib/pharmacy/onboarding';
import { FIRST_RUN_VERTICALS, roleTemplatesForVertical, VERTICALS } from '@/lib/vertical-catalog';

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
  vertical: (typeof FIRST_RUN_VERTICALS)[number];
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
  const items = VERTICALS[vertical].firstRunChecklist.map((definition): SetupChecklistItem => {
    const done = definition.evidence.every((key) => evidence[key]);
    return {
      key: definition.key,
      label: definition.label,
      status: status(done, definition.optional),
      why: done ? definition.doneWhy : definition.pendingWhy,
      actionLabel: done ? definition.doneActionLabel : definition.pendingActionLabel,
      href: definition.href,
      optional: definition.optional,
    };
  });

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
      // A closed order is not yet a sale: settlement allocates the receipt and
      // is the durable proof that checkout completed end to end.
      db.restaurantBill.count({ where: { organizationId, status: 'SETTLED' } }),
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
