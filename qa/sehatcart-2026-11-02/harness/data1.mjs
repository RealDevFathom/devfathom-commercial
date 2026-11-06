import { trpc, short, disposeApis, save } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const calls = [
  ['pharmacyPurchasing.workspace', undefined],
  ['pharmacyPurchasing.suppliers', { includeInactive: true }],
  ['pharmacyPurchasing.requisitions', undefined],
  ['pharmacyPurchasing.purchaseOrders', undefined],
  ['pharmacyPurchasing.goodsReceipts', { branchId: BR }],
  ['pharmacyInventory.nearExpiryBoard', { branchId: BR }],
  ['pharmacyInventory.expiryBoardLots', { branchId: BR }],
  ['pharmacyInventory.transferBoard', { branchId: BR }],
  ['pharmacyInventory.stockSignalDashboard', { branchId: BR }],
  ['pharmacySales.counterSearch', { branchId: BR, query: 'pan' }],
  ['pharmacySales.counterSearch', { branchId: BR, query: 'a' }],
  ['pharmacySales.drawerStatus', { branchId: BR }],
  ['pharmacySales.closePreview', { branchId: BR }],
  ['pharmacySales.khataAccounts', { branchId: BR }],
  ['pharmacySafety.access', undefined],
];
const out = {};
for (const [p, input] of calls) {
  const r = await trpc('owner', p, input);
  out[p + JSON.stringify(input ?? '')] = r;
  console.log(p.padEnd(42), short(r, 700));
}
save('data1.json', out);
await disposeApis();
