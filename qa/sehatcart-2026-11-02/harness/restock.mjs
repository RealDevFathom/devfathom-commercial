import { trpc, short, disposeApis, save } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const MED = 'cmvxpws13002v1xqrfsg4p4hz';
const PACK = 'cmvxpy8hn003t1xqr9az7aste';
const SUP = 'cmvzktbce01cs4oqrsxjjoswy';
const SHELF = 'cmvxw8ed000094oqr68yrqp8c';
const tag = 'QA-STK-' + Date.now().toString(36);
const show = (l, r) => { console.log(l.padEnd(28), short(r, 260)); return r; };
const po = show('manager createPO', await trpc('manager', 'pharmacyPurchasing.createPurchaseOrder', {
  reference: `${tag}-PO`, supplierId: SUP, branchId: BR,
  lines: [
    { medicineId: MED, packLevelId: PACK, orderedPacks: 30, canonicalUnitsPerPack: 10, listPricePerPackMinor: 1100 },
    { medicineId: MED, packLevelId: PACK, orderedPacks: 30, canonicalUnitsPerPack: 10, listPricePerPackMinor: 1200 },
  ],
}, 'mutation'));
const poId = po.data?.id;
show('manager submitPO', await trpc('manager', 'pharmacyPurchasing.submitPurchaseOrder', { purchaseOrderId: poId }, 'mutation'));
show('owner approvePO', await trpc('owner', 'pharmacyPurchasing.approvePurchaseOrder', { purchaseOrderId: poId, decision: 'APPROVED' }, 'mutation'));
show('manager sendPO', await trpc('manager', 'pharmacyPurchasing.sendPurchaseOrder', { purchaseOrderId: poId }, 'mutation'));
const lines = po.data?.lines ?? [];
const grn = show('manager createGRN', await trpc('manager', 'pharmacyPurchasing.createGoodsReceipt', {
  reference: `${tag}-GRN`, branchId: BR, supplierId: SUP, purchaseOrderId: poId,
  supplierInvoiceRef: `${tag}-INV`, supplierInvoiceDate: new Date(), warrantyEvidenceRef: 'Warranty on invoice', receivedAt: new Date(),
  lines: [
    { purchaseOrderLineId: lines[0]?.id, medicineId: MED, packLevelId: PACK, batchNumber: 'QA-B2', printedExpiry: new Date('2027-01-31T00:00:00Z'), expiryPrecision: 'MONTH', printedMrpMinor: 2800, canonicalUnitsPerPack: 10, receivedPacks: 30, invoicedPricePerPackMinor: 1100, stockLocationId: SHELF },
    { purchaseOrderLineId: lines[1]?.id, medicineId: MED, packLevelId: PACK, batchNumber: 'QA-B3', printedExpiry: new Date('2028-03-31T00:00:00Z'), expiryPrecision: 'MONTH', printedMrpMinor: 3000, canonicalUnitsPerPack: 10, receivedPacks: 30, invoicedPricePerPackMinor: 1200, stockLocationId: SHELF },
  ],
}, 'mutation'));
const post = show('manager postGRN', await trpc('manager', 'pharmacyPurchasing.postGoodsReceipt', { branchId: BR, goodsReceiptId: grn.data?.id }, 'mutation'));
show('onHand', await trpc('owner', 'pharmacyInventory.onHand', { branchId: BR, medicineId: MED }));
save(`restock-${tag}.json`, { po, grn, post });
await disposeApis();
