import { trpc, short, disposeApis, ROLES, save } from './lib.mjs';

const out = {};
for (const role of ROLES) {
  out[role] = {};
  for (const p of [
    'pharmacySales.counterBranches',
    'pharmacySales.counterKeymap',
    'pharmacyBranchAssignments.list',
  ]) {
    const r = await trpc(role, p);
    out[role][p] = r;
    console.log(role.padEnd(10), p.padEnd(40), short(r, 400));
  }
}
save('probe1.json', out);
await disposeApis();
