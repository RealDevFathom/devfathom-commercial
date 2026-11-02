import { randomUUID } from 'node:crypto';
import { trpc, short, disposeApis, save } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const SUP = 'cmvzktbce01cs4oqrsxjjoswy';
const SHELF = 'cmvxw8ed000094oqr68yrqp8c';
const show = (l, r) => {
  console.log(l.padEnd(34), short(r, 220));
  return r;
};
const prov = [
  {
    field: 'drapRegistrationNumber',
    source: 'QA self-asserted',
    sourceType: 'USER',
    retrievedAt: new Date(),
    status: 'ACCEPTED',
  },
];

// 1) Cashier tries to create a saleable medicine flagged NOT prescription-only (#1012 probe)
const ingC = show(
  'cashier createIngredient',
  await trpc(
    'cashier',
    'pharmacyMedicine.createIngredient',
    { name: 'QA-RBAC Azithromycin' },
    'mutation'
  )
);
const medC = show(
  'cashier createMedicine rx:false',
  await trpc(
    'cashier',
    'pharmacyMedicine.createMedicine',
    {
      productName: 'QA-RBAC Azithromycin 500mg Tablets',
      brandName: 'QA-RBAC Azi',
      manufacturer: 'QA Pharma',
      drapRegistrationNumber: 'QA-RBAC-0003',
      productFamily: 'PHARMACEUTICAL',
      rx: false,
      otc: true,
      saleable: true,
      presentation: { dosageForm: 'Tablet', presentation: '1 x 6' },
      strengths: ingC.data?.id ? [{ ingredientId: ingC.data.id, value: 500, unit: 'mg' }] : [],
      provenance: prov,
    },
    'mutation'
  )
);

// 2) Owner creates a genuine Rx medicine for the pharmacist-gate test
const ing = show(
  'owner createIngredient',
  await trpc('owner', 'pharmacyMedicine.createIngredient', { name: 'QA Amoxicillin' }, 'mutation')
);
const med = show(
  'owner createMedicine rx:true',
  await trpc(
    'owner',
    'pharmacyMedicine.createMedicine',
    {
      productName: 'QA Amoxicillin 500mg Capsules',
      brandName: 'QA Amoxil',
      manufacturer: 'QA Pharma',
      drapRegistrationNumber: 'QA-0002',
      productFamily: 'PHARMACEUTICAL',
      rx: true,
      saleable: true,
      presentation: { dosageForm: 'Capsule', presentation: '2 x 10' },
      strengths: [{ ingredientId: ing.data?.id, value: 500, unit: 'mg' }],
      provenance: prov,
    },
    'mutation'
  )
);
const medId = med.data?.id;
const full = await trpc('owner', 'pharmacyMedicine.get', { id: medId });
const presId = full.data?.presentations?.[0]?.id;
const pack = show(
  'owner createPackLevel',
  await trpc(
    'owner',
    'pharmacyMedicine.createPackLevel',
    {
      presentationId: presId,
      versionGroupId: randomUUID(),
      level: 'STRIP',
      unitsPerParent: 10,
      effectiveFrom: new Date('2026-11-01T00:00:00Z'),
    },
    'mutation'
  )
);
const packId = pack.data?.id;
const po = show(
  'manager createPO',
  await trpc(
    'manager',
    'pharmacyPurchasing.createPurchaseOrder',
    {
      reference: 'QA-RX-PO-' + Date.now().toString(36),
      supplierId: SUP,
      branchId: BR,
      lines: [
        {
          medicineId: medId,
          packLevelId: packId,
          orderedPacks: 20,
          canonicalUnitsPerPack: 10,
          listPricePerPackMinor: 15000,
        },
      ],
    },
    'mutation'
  )
);
show(
  'manager submit',
  await trpc(
    'manager',
    'pharmacyPurchasing.submitPurchaseOrder',
    { purchaseOrderId: po.data?.id },
    'mutation'
  )
);
show(
  'owner approve',
  await trpc(
    'owner',
    'pharmacyPurchasing.approvePurchaseOrder',
    { purchaseOrderId: po.data?.id, decision: 'APPROVED' },
    'mutation'
  )
);
show(
  'manager send',
  await trpc(
    'manager',
    'pharmacyPurchasing.sendPurchaseOrder',
    { purchaseOrderId: po.data?.id },
    'mutation'
  )
);
const grn = show(
  'manager createGRN',
  await trpc(
    'manager',
    'pharmacyPurchasing.createGoodsReceipt',
    {
      reference: 'QA-RX-GRN-' + Date.now().toString(36),
      branchId: BR,
      supplierId: SUP,
      purchaseOrderId: po.data?.id,
      supplierInvoiceRef: 'QA-RX-INV',
      supplierInvoiceDate: new Date(),
      warrantyEvidenceRef: 'Warranty on invoice',
      receivedAt: new Date(),
      lines: [
        {
          purchaseOrderLineId: po.data?.lines?.[0]?.id,
          medicineId: medId,
          packLevelId: packId,
          batchNumber: 'QA-AMX-1',
          printedExpiry: new Date('2027-09-30T00:00:00Z'),
          expiryPrecision: 'MONTH',
          printedMrpMinor: 30000,
          canonicalUnitsPerPack: 10,
          receivedPacks: 20,
          invoicedPricePerPackMinor: 15000,
          stockLocationId: SHELF,
        },
      ],
    },
    'mutation'
  )
);
show(
  'manager postGRN',
  await trpc(
    'manager',
    'pharmacyPurchasing.postGoodsReceipt',
    { branchId: BR, goodsReceiptId: grn.data?.id },
    'mutation'
  )
);
save('rx-setup.json', {
  medC: medC.data?.id,
  medId,
  presId,
  packId,
  po: po.data?.id,
  grn: grn.data?.id,
});
console.log('IDS', JSON.stringify({ medC: medC.data?.id, medId, presId, packId }));
await disposeApis();
