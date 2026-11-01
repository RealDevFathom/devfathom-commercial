import { describe, expect, it } from 'vitest';

import type { PharmacyDemoContext } from '../scripts/pharmacy-demo-contract';
import {
  planPharmacyDemoFinance,
  type PharmacyDemoFinanceStock,
} from '../scripts/pharmacy-demo-finance';
import { planInventoryDemo, type InventoryDemoFacts } from '../scripts/pharmacy-demo-inventory';
import { planPharmacyDemoRetention } from '../scripts/pharmacy-demo-retention';
import { targetNamespace } from '../scripts/seed-pharmacy-demo';

describe('pharmacy demo root namespace composition', () => {
  it('passes one unchanged root namespace through every delivered planner', () => {
    const organizationId = 'oracle-org';
    const branchId = 'oracle-branch';
    const ownerUserId = 'oracle-owner';
    const namespace = targetNamespace({
      environment: 'disposable',
      targetKey: 'oracle-only',
      organizationId,
      branchId,
    });
    const context: PharmacyDemoContext = {
      organizationId,
      branchId,
      ownerUserId,
      namespace,
      scenarioAt: '2026-09-07T07:00:00.000Z',
      businessDate: '2026-09-07',
      timezone: 'Asia/Karachi',
      currency: 'PKR',
      actors: [
        {
          userId: ownerUserId,
          actorId: ownerUserId,
          organizationId,
          branchId,
          active: true,
          synthetic: true,
          capabilities: ['pharmacyPurchasing.createCentralPurchaseOrder'],
        },
      ],
      references: [],
      modules: [{ key: 'pharmacy-procurement', enabled: true }],
    };
    const reference = (kind: InventoryDemoFacts['references'][number]['kind'], id: string) => ({
      kind,
      id,
      organizationId,
      branchId,
      approved: true as const,
      observedHash: 'a'.repeat(64),
    });
    const inventoryFacts: InventoryDemoFacts = {
      ...context,
      actorId: ownerUserId,
      purchasingEntitled: true,
      organizationPurchaser: true,
      approvedCatalog: {
        medicineId: 'medicine',
        presentationId: 'presentation',
        packLevelId: 'pack',
        stockLocationId: 'location',
        canonicalUnitsPerPack: 10,
      },
      supplier: {
        id: 'supplier',
        authorized: true,
        licences: [{ id: 'licence', verified: true, expiresAt: '2027-01-01T00:00:00Z' }],
      },
      references: [
        reference('medicine', 'medicine'),
        reference('presentation', 'presentation'),
        reference('pack', 'pack'),
        reference('location', 'location'),
        reference('supplier', 'supplier'),
      ],
      orderedPacks: 3,
      listPricePerPackMinor: 12_500,
    };
    const financeStock: PharmacyDemoFinanceStock = {
      medicineId: 'medicine',
      presentationId: 'presentation',
      inventoryLotId: 'lot',
      stockLocationId: 'location',
      printedMrpMinor: 1_001,
      unitsPerPack: 10,
      units: [{ saleUnit: 'PACK', packLevelId: 'pack', canonicalUnitsPerSaleUnit: 10 }],
    };

    const inventory = planInventoryDemo(inventoryFacts);
    const finance = planPharmacyDemoFinance(context, financeStock);
    const retention = planPharmacyDemoRetention(context);

    expect(namespace).toMatch(/^phdemo_[a-f0-9]{24}_$/);
    expect(inventory.unmet).toEqual([]);
    expect([inventory.namespace, finance.namespace, retention.namespace]).toEqual([
      namespace,
      namespace,
      namespace,
    ]);
    expect(inventory.input.reference).toBe(`${namespace}:inventory:po:v1`);
    expect(finance.examples[0]?.ref).toBe(`${namespace}:finance:pack`);
    expect(retention.personas[0]?.ref).toBe(`${namespace}:retention:repeat`);
  });
});
