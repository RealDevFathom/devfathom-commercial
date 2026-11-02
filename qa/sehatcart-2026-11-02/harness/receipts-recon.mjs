// Rebuild sales/refund totals from receipts and compare with the owner command centre.
import { trpc, short, disposeApis, save } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const rows = [];
for (let n = 1; n <= 40; n++) {
  const r = await trpc('owner', 'pharmacySales.lookupReceiptByNumber', { branchId: BR, receiptNumber: n });
  if (!r.ok) { console.log('lookup', n, short(r)); break; }
  if (!r.data?.length) continue;
  for (const sale of r.data) {
    const rc = await trpc('owner', 'pharmacySales.counterReceipt', { branchId: BR, saleId: sale.id });
    const d = rc.data ?? {};
    rows.push({ n, saleId: sale.id, device: sale.receiptDeviceId, businessDate: sale.businessDate, keys: Object.keys(d).join(','), totals: d.totals ?? null, refunds: d.refunds ?? null });
  }
}
console.log('receipts found:', rows.length);
console.log('first receipt keys:', rows[0]?.keys);
for (const r of rows) console.log(r.n, r.device?.slice(0, 26), String(r.businessDate).slice(0, 10), JSON.stringify(r.totals)?.slice(0, 220), '| refunds:', JSON.stringify(r.refunds)?.slice(0, 160));
const cc = await trpc('owner', 'pharmacyReports.commandCentre', { branchId: BR, from: '2026-11-01', to: '2026-11-02' });
console.log('commandCentre metrics', JSON.stringify(cc.data?.metrics));
save('receipts-recon.json', { rows, cc: cc.data });
await disposeApis();
