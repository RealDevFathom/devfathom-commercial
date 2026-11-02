import { trpc, short, disposeApis } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
for (const q of ['amox', 'QA-20261102', 'QA tab']) {
  const r = await trpc('cashier', 'pharmacySales.counterSearch', { branchId: BR, query: q });
  for (const row of r.data?.rows ?? []) console.log(q, '|', row.displayName, '| rx', JSON.stringify(row.restriction), '| onHand', row.onHandUnits, '| mrp', row.printedMrpMinor, '| saleUnits', JSON.stringify(row.saleUnits).slice(0,200), '| blocked', JSON.stringify(row.blocked ?? row.block ?? null).slice(0,200));
  if (!r.ok) console.log(q, short(r));
}
await disposeApis();
