import { trpc, short, disposeApis } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
for (const role of ['owner', 'pharmacist', 'cashier', 'manager']) {
  const r = await trpc(role, 'pharmacySales.closePreview', { branchId: BR, businessDate: new Date('2026-11-02T00:00:00.000Z') });
  console.log(role.padEnd(10), 'closePreview', short(r, 500));
}
await disposeApis();
