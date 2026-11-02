import { trpc, short, disposeApis, save } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const out = [];
const rec = (l, r, n = 260) => { out.push({ l, status: r.status, code: r.code, message: r.message, data: r.data, at: r.at }); console.log(l.padEnd(48), short(r, n)); return r; };

// Financial (cost) data reachable by the cashier
const eb = rec('cashier expiryBoardLots', await trpc('cashier', 'pharmacyInventory.expiryBoardLots', { branchId: BR, withinDays: 365 }), 120);
const row = eb.data?.rows?.[0];
console.log('   first row cost fields:', row ? JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => /cost|value|margin|mrp/i.test(k)))) : 'no rows');
const sup = rec('cashier suppliers', await trpc('cashier', 'pharmacyPurchasing.suppliers', { includeInactive: true }), 80);
console.log('   supplier credit fields:', JSON.stringify((sup.data ?? []).slice(0, 2).map((s) => ({ n: s.name, creditLimitMinor: s.creditLimitMinor, terms: s.paymentTermsDays }))));
const lots = rec('cashier lotsFromReceipt', await trpc('cashier', 'pharmacyPurchasing.lotsFromReceipt', { branchId: BR, goodsReceiptId: 'cmvzl8u1g01pl4oqrcbubue9y' }), 80);
console.log('   lot cost fields:', JSON.stringify((Array.isArray(lots.data) ? lots.data : lots.data?.lots ?? []).slice(0, 2).map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => /cost|mrp|batch/i.test(k))))));

// Drawer by the Procurement user (no counter capability)
const od = rec('manager openDrawer', await trpc('manager', 'pharmacySales.openDrawer', { branchId: BR, deviceId: 'qa-rbac-manager-device', businessDate: new Date('2026-11-02T00:00:00.000Z'), openingFloatMinor: 0 }, 'mutation'));
const ds = od.data?.id ?? od.data?.drawerSessionId;
if (ds) {
  rec('manager drawerMovement PAID_IN 100', await trpc('manager', 'pharmacySales.drawerMovement', { branchId: BR, drawerSessionId: ds, kind: 'PAID_IN', amountMinor: 10000, reason: 'QA RBAC probe' }, 'mutation'));
  rec('manager drawerMovement PAID_OUT 100', await trpc('manager', 'pharmacySales.drawerMovement', { branchId: BR, drawerSessionId: ds, kind: 'PAID_OUT', amountMinor: 10000, reason: 'QA RBAC probe' }, 'mutation'));
  rec('manager closeDrawer', await trpc('manager', 'pharmacySales.closeDrawer', { branchId: BR, drawerSessionId: ds, countedCashMinor: 0 }, 'mutation'));
}

// Patient records by the Procurement user
const pat = rec('manager createPatient', await trpc('manager', 'pharmacyPrescriptions.createPatient', { displayName: 'QA-RBAC Patient', phone: '+923001234567' }, 'mutation'));
const pid = pat.data?.id;
if (pid) {
  rec('manager recordConsent MARKETING/WHATSAPP', await trpc('manager', 'pharmacyPrescriptions.recordConsent', { patientId: pid, purpose: 'MARKETING', channel: 'WHATSAPP', granted: true }, 'mutation'));
  rec('manager readPatient', await trpc('manager', 'pharmacyPrescriptions.readPatient', { patientId: pid }), 200);
  rec('manager exportPatient', await trpc('manager', 'pharmacyPrescriptions.exportPatient', { patientId: pid }), 200);
  rec('cashier exportPatient', await trpc('cashier', 'pharmacyPrescriptions.exportPatient', { patientId: pid }), 200);
}

// Pharmacovigilance by cashier/manager
rec('cashier createPharmacovigilanceReport', await trpc('cashier', 'pharmacyReports.createPharmacovigilanceReport', { branchId: BR, kind: 'ADVERSE_DRUG_REACTION', occurredAt: new Date(), assertedDescription: 'QA RBAC probe - please ignore' }, 'mutation'));
rec('manager exportPharmacovigilanceDrap', await trpc('manager', 'pharmacyReports.exportPharmacovigilanceDrap', { branchId: BR, from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z') }), 200);
save('rbac2.json', out);
await disposeApis();
