import { trpc, short, disposeApis, save } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const out = {};
const f = { branchId: BR, from: '2026-11-01', to: '2026-11-02' };
for (const role of ['owner', 'pharmacist', 'cashier', 'manager']) {
  for (const [p, input] of [
    ['pharmacyReports.commandCentre', f],
    ['pharmacyReports.expiryAdvice', f],
    ['pharmacyReports.anomalySignals', f],
  ]) {
    const r = await trpc(role, p, input);
    out[`${role} ${p}`] = r;
    console.log(
      role.padEnd(10),
      p.padEnd(34),
      short(r, role === 'owner' ? 900 : 160),
      r.status >= 500 ? r.at : ''
    );
  }
}
save('reports1.json', out);
await disposeApis();
