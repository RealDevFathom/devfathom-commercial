import { trpc, short, disposeApis } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const MED = 'cmvxpws13002v1xqrfsg4p4hz';
for (const saleId of ['cmvzl0m9f01kp4oqrq5jmq7vh', 'cmvzl0mgb01kx4oqro37or4ki', 'cmvzl0mm501l54oqrp4vxwa68']) {
  const r = await trpc('owner', 'pharmacySales.transition', { branchId: BR, saleId, action: 'void', reason: 'QA cleanup of orphan bill' }, 'mutation');
  console.log('void', saleId, short(r, 200));
}
console.log('onHand', short(await trpc('owner', 'pharmacyInventory.onHand', { branchId: BR, medicineId: MED }), 400));
await disposeApis();
