import { trpc, short, disposeApis, save } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const out = [];
for (const role of ['owner', 'pharmacist', 'cashier']) {
  const input = { branchId: BR, kind: 'ADVERSE_DRUG_REACTION', occurredAt: new Date(), assertedDescription: 'QA probe - please ignore' };
  const r = await trpc(role, 'pharmacyReports.createPharmacovigilanceReport', input, 'mutation');
  out.push({ role, input, status: r.status, code: r.code, message: r.message, at: r.at, raw: r.raw });
  console.log(role.padEnd(10), 'createPV', short(r, 200), r.at);
}
for (const role of ['cashier']) {
  const r = await trpc(role, 'pharmacyInventory.expiryBoardLots', { branchId: BR, withinDays: 180 });
  const row = r.data?.rows?.[0];
  console.log('cashier expiryBoardLots', short(r, 100), '| row keys:', row ? Object.keys(row).join(',') : 'none', '| sample:', row ? JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => /cost|value|mrp|margin/i.test(k)))) : '');
}
save('pv500.json', out);
await disposeApis();
