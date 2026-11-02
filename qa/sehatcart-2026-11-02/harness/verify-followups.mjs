// Follow-up live checks raised by the adversarial verification of qa-report.md.
// T1 pharmacist cannot tender; T2 Rx sale without prescription via API; T3 client-chosen businessDate.
import { trpc, short, disposeApis, save, pkt } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const PANADOL = { medicineId: 'cmvxpws13002v1xqrfsg4p4hz', presentationId: 'cmvxpx8in003a1xqrbz6z4t3n', packLevelId: 'cmvxpy8hn003t1xqr9az7aste' };
const AMOXIL = { medicineId: 'cmvzld6dm01uc4oqrs4vn5m0a', packLevelId: 'cmvzld6hf01ui4oqrzi7bnemw' };
const today = new Date(process.argv[2] ?? '2026-11-03T00:00:00.000Z');
const future = new Date(process.argv[3] ?? '2026-11-05T00:00:00.000Z');
const tag = 'qa-verify-' + Date.now().toString(36);
const out = {};
const rec = (k, r, n = 220) => { out[k] = { status: r.status, code: r.code, message: r.message, data: r.data, at: r.at }; console.log(k.padEnd(44), short(r, n), r.at); return r; };

async function sale(role, line, label) {
  const s = rec(`${label} create`, await trpc(role, 'pharmacySales.create', { branchId: BR }, 'mutation'), 80);
  const l = rec(`${label} addLine`, await trpc(role, 'pharmacySales.addLine', { branchId: BR, saleId: s.data?.id, ...line, saleUnit: 'STRIP', quantity: 1, canonicalUnitsPerSaleUnit: 10, idempotencyKey: `${tag}-${label}` }, 'mutation'), 120);
  return { saleId: s.data?.id, gross: l.data?.line?.grossMinor };
}

// presentation of amoxil
const med = await trpc('owner', 'pharmacyMedicine.get', { id: AMOXIL.medicineId });
AMOXIL.presentationId = med.data?.presentations?.[0]?.id;

// T1: pharmacist sells OTC Panadol and tries to take cash.
rec('T1 pharmacist openDrawer', await trpc('pharmacist', 'pharmacySales.openDrawer', { branchId: BR, deviceId: `${tag}-pharm`, businessDate: today, openingFloatMinor: 0 }, 'mutation'), 80);
const t1 = await sale('pharmacist', PANADOL, 'T1 pharmacist');
rec('T1 pharmacist tender CASH', await trpc('pharmacist', 'pharmacySales.tender', { branchId: BR, saleId: t1.saleId, deviceId: `${tag}-pharm`, businessDate: today, type: 'CASH', amountMinor: t1.gross ?? 2600, cashReceivedMinor: 5000, idempotencyKey: `${tag}-t1` }, 'mutation'));
if (t1.saleId) rec('T1 owner voids pharmacist bill', await trpc('owner', 'pharmacySales.transition', { branchId: BR, saleId: t1.saleId, action: 'void', reason: 'QA verify cleanup' }, 'mutation'), 60);

// T2: owner (dispense + counter) sells the Rx item with NO prescription through the API.
rec('T2 owner openDrawer', await trpc('owner', 'pharmacySales.openDrawer', { branchId: BR, deviceId: `${tag}-owner`, businessDate: today, openingFloatMinor: 0 }, 'mutation'), 80);
const t2 = await sale('owner', AMOXIL, 'T2 owner Rx-no-prescription');
const t2t = rec('T2 owner tender CASH (no prescription)', await trpc('owner', 'pharmacySales.tender', { branchId: BR, saleId: t2.saleId, deviceId: `${tag}-owner`, businessDate: today, type: 'CASH', amountMinor: t2.gross ?? 30000, cashReceivedMinor: t2.gross ?? 30000, idempotencyKey: `${tag}-t2` }, 'mutation'), 300);

// T3: owner opens a drawer and books a sale on a FUTURE business date chosen by the client.
rec('T3 owner openDrawer future date', await trpc('owner', 'pharmacySales.openDrawer', { branchId: BR, deviceId: `${tag}-owner-future`, businessDate: future, openingFloatMinor: 0 }, 'mutation'), 120);
const t3 = await sale('owner', PANADOL, 'T3 owner future-dated');
const t3t = rec('T3 owner tender on future date', await trpc('owner', 'pharmacySales.tender', { branchId: BR, saleId: t3.saleId, deviceId: `${tag}-owner-future`, businessDate: future, type: 'CASH', amountMinor: t3.gross ?? 2600, cashReceivedMinor: t3.gross ?? 2600, idempotencyKey: `${tag}-t3` }, 'mutation'), 300);

// Cleanup: refund the completed test sales in full on the date they were booked.
for (const [k, t, date, dev] of [['T2', t2t, today, `${tag}-owner`], ['T3', t3t, future, `${tag}-owner-future`]]) {
  const tenderId = t.data?.tender?.id ?? t.data?.tenderId ?? t.data?.tenders?.[0]?.id;
  if (!t.ok || !tenderId) { console.log(k, 'no completed tender to refund', JSON.stringify(t.data ?? {}).slice(0, 200)); continue; }
  rec(`${k} cleanup refund`, await trpc('owner', 'pharmacySales.refundTender', { branchId: BR, originalTenderId: tenderId, deviceId: dev, businessDate: date, amountMinor: t.data?.tender?.amountMinor ?? t.data?.amountMinor ?? 2600, reason: 'QA verification cleanup', idempotencyKey: `${tag}-${k}-refund` }, 'mutation'), 160);
}
save(`verify-followups-${tag}.json`, { at: pkt(), out });
await disposeApis();
