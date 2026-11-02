import { trpc, short, disposeApis, save } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const MED = 'cmvxpws13002v1xqrfsg4p4hz';
const PRES = 'cmvxpx8in003a1xqrbz6z4t3n';
const PACK = 'cmvxpy8hn003t1xqr9az7aste';
const out = [];
const rec = (l, r) => { out.push({ l, ...r, raw: undefined }); console.log(l.padEnd(46), short(r, 260)); return r; };
rec('owner onHand before', await trpc('owner', 'pharmacyInventory.onHand', { branchId: BR, medicineId: MED }));
for (const role of ['manager', 'pharmacist', 'cashier']) {
  const s = rec(`${role} pharmacySales.create`, await trpc(role, 'pharmacySales.create', { branchId: BR }, 'mutation'));
  const saleId = s.data?.id;
  if (!saleId) continue;
  const l = rec(`${role} pharmacySales.addLine`, await trpc(role, 'pharmacySales.addLine', {
    branchId: BR, saleId, medicineId: MED, presentationId: PRES, packLevelId: PACK, saleUnit: 'STRIP', quantity: 1, canonicalUnitsPerSaleUnit: 10, idempotencyKey: `qa-${role}-${Date.now()}`,
  }, 'mutation'));
  rec(`${role} pharmacySales.counterCart`, await trpc(role, 'pharmacySales.counterCart', { branchId: BR, saleId }));
}
rec('owner onHand after', await trpc('owner', 'pharmacyInventory.onHand', { branchId: BR, medicineId: MED }));
save('rbac-sale.json', out);
await disposeApis();
