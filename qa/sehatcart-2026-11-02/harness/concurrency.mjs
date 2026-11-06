// Concurrent allocation on one small batch + mixed-lot pricing check.
import { trpc, short, disposeApis, save } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const MED = 'cmvxpws13002v1xqrfsg4p4hz';
const PRES = 'cmvxpx8in003a1xqrbz6z4t3n';
const PACK = 'cmvxpy8hn003t1xqr9az7aste';
const SUP = 'cmvzktbce01cs4oqrsxjjoswy';
const SHELF = 'cmvxw8ed000094oqr68yrqp8c';
const tag = 'QA-CONC-' + Date.now().toString(36);
const show = (l, r, n = 200) => {
  console.log(l.padEnd(30), short(r, n));
  return r;
};

// 1) Receive QA-B4: 3 strips, MRP 26.00, earliest expiry so FEFO allocates it first.
const po = show(
  'createPO',
  await trpc(
    'manager',
    'pharmacyPurchasing.createPurchaseOrder',
    {
      reference: `${tag}-PO`,
      supplierId: SUP,
      branchId: BR,
      lines: [
        {
          medicineId: MED,
          packLevelId: PACK,
          orderedPacks: 3,
          canonicalUnitsPerPack: 10,
          listPricePerPackMinor: 1050,
        },
      ],
    },
    'mutation'
  ),
  80
);
await trpc(
  'manager',
  'pharmacyPurchasing.submitPurchaseOrder',
  { purchaseOrderId: po.data.id },
  'mutation'
);
await trpc(
  'owner',
  'pharmacyPurchasing.approvePurchaseOrder',
  { purchaseOrderId: po.data.id, decision: 'APPROVED' },
  'mutation'
);
await trpc(
  'manager',
  'pharmacyPurchasing.sendPurchaseOrder',
  { purchaseOrderId: po.data.id },
  'mutation'
);
const grn = await trpc(
  'manager',
  'pharmacyPurchasing.createGoodsReceipt',
  {
    reference: `${tag}-GRN`,
    branchId: BR,
    supplierId: SUP,
    purchaseOrderId: po.data.id,
    supplierInvoiceRef: `${tag}-INV`,
    supplierInvoiceDate: new Date(),
    warrantyEvidenceRef: 'Warranty on invoice',
    receivedAt: new Date(),
    lines: [
      {
        purchaseOrderLineId: po.data.lines[0].id,
        medicineId: MED,
        packLevelId: PACK,
        batchNumber: 'QA-B4',
        printedExpiry: new Date('2027-01-15T00:00:00Z'),
        expiryPrecision: 'DAY',
        printedMrpMinor: 2600,
        canonicalUnitsPerPack: 10,
        receivedPacks: 3,
        invoicedPricePerPackMinor: 1050,
        stockLocationId: SHELF,
      },
    ],
  },
  'mutation'
);
const post = show(
  'postGRN',
  await trpc(
    'manager',
    'pharmacyPurchasing.postGoodsReceipt',
    { branchId: BR, goodsReceiptId: grn.data?.id },
    'mutation'
  ),
  120
);
const b4Lot = post.data?.lines?.[0]?.inventoryLotId;
const before = await trpc('owner', 'pharmacyInventory.onHand', { branchId: BR, medicineId: MED });
console.log(
  'onHand before',
  JSON.stringify(before.data?.map((r) => [r.inventoryLotId.slice(-6), r.onHandUnits]))
);

// 2) Four bills opened, then four addLine calls fired at the same instant (2 strips = 20 units each).
const actors = ['owner', 'owner', 'cashier', 'cashier'];
const bills = [];
for (const role of actors)
  bills.push({
    role,
    sale: (await trpc(role, 'pharmacySales.create', { branchId: BR }, 'mutation')).data?.id,
  });
const t0 = Date.now();
const results = await Promise.all(
  bills.map((b, i) =>
    trpc(
      b.role,
      'pharmacySales.addLine',
      {
        branchId: BR,
        saleId: b.sale,
        medicineId: MED,
        presentationId: PRES,
        packLevelId: PACK,
        saleUnit: 'STRIP',
        quantity: 2,
        canonicalUnitsPerSaleUnit: 10,
        idempotencyKey: `${tag}-${i}`,
      },
      'mutation'
    )
  )
);
console.log('parallel addLine wall time', Date.now() - t0, 'ms');
const lines = [];
for (const [i, r] of results.entries()) {
  const line = r.data?.line;
  const allocs = r.data?.allocations ?? line?.allocations ?? [];
  lines.push({
    i,
    role: bills[i].role,
    sale: bills[i].sale,
    status: r.status,
    code: r.code,
    msg: r.message,
    gross: line?.grossMinor,
    unit: line?.unitPriceMinor,
    units: line?.canonicalUnits,
    allocs: allocs.map?.((a) => ({
      lot: (a.inventoryLotId ?? '').slice(-6),
      units: a.units ?? a.quantityUnits,
    })),
  });
  console.log(
    i,
    bills[i].role,
    r.status,
    r.code ?? '',
    'gross',
    line?.grossMinor,
    'unitPrice',
    line?.unitPriceMinor,
    'allocs',
    JSON.stringify(lines[i].allocs),
    r.message ?? ''
  );
}
const after = await trpc('owner', 'pharmacyInventory.onHand', { branchId: BR, medicineId: MED });
console.log(
  'onHand after',
  JSON.stringify(after.data?.map((r) => [r.inventoryLotId.slice(-6), r.onHandUnits])),
  'B4 lot',
  b4Lot?.slice(-6)
);
// 3) Release: void every test bill.
for (const b of bills)
  if (b.sale)
    console.log(
      'void',
      b.role,
      short(
        await trpc(
          b.role,
          'pharmacySales.transition',
          { branchId: BR, saleId: b.sale, action: 'void', reason: 'QA concurrency cleanup' },
          'mutation'
        ),
        60
      )
    );
const final = await trpc('owner', 'pharmacyInventory.onHand', { branchId: BR, medicineId: MED });
console.log(
  'onHand after void',
  JSON.stringify(final.data?.map((r) => [r.inventoryLotId.slice(-6), r.onHandUnits]))
);
save(`concurrency-${tag}.json`, {
  b4Lot,
  before: before.data,
  lines,
  after: after.data,
  final: final.data,
  raw: results.map((r) => r.data),
});
await disposeApis();
