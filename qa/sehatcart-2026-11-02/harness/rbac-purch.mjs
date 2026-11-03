import { trpc, short, disposeApis, save, pkt } from './lib.mjs';
const TAG = 'QA-RBAC-' + Date.now().toString(36);
const MED = 'cmvxpws13002v1xqrfsg4p4hz';
const PACK = 'cmvxpy8hn003t1xqr9az7aste';
const log = [];
async function step(label, role, proc, input, type = 'mutation') {
  const r = await trpc(role, proc, input, type);
  log.push({
    label,
    role,
    proc,
    input,
    status: r.status,
    code: r.code,
    message: r.message,
    data: r.data,
    at: r.at,
  });
  console.log(`${label.padEnd(34)} ${role.padEnd(10)} ${proc.padEnd(44)} ${short(r, 220)}`);
  return r;
}
const sup = await step('A cashier createSupplier', 'cashier', 'pharmacyPurchasing.createSupplier', {
  name: `${TAG} supplier`,
  legalName: `${TAG} Ltd`,
  serviceArea: 'Lahore',
});
const supplierId = sup.data?.id;
if (supplierId) {
  await step(
    'B cashier recordSupplierLicence',
    'cashier',
    'pharmacyPurchasing.recordSupplierLicence',
    {
      supplierId,
      licenceType: 'Drug sale licence (distribution)',
      licenceNumber: `${TAG}-LIC`,
      issuingAuthority: 'QA self-asserted',
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2027-12-31T00:00:00Z'),
      verified: true,
    }
  );
  await step(
    'C cashier setSupplierAuthorization',
    'cashier',
    'pharmacyPurchasing.setSupplierAuthorization',
    { supplierId, authorized: true }
  );
}
const po = await step(
  'D cashier createPurchaseOrder',
  'cashier',
  'pharmacyPurchasing.createPurchaseOrder',
  {
    reference: `${TAG}-PO`,
    supplierId: supplierId ?? 'cmvxpznfk003y1xqrmmzp7p8k',
    branchId: 'cmvx5fc4p000cy5qrcgzjrc3b',
    lines: [
      {
        medicineId: MED,
        packLevelId: PACK,
        orderedPacks: 10,
        canonicalUnitsPerPack: 10,
        listPricePerPackMinor: 1000,
      },
    ],
  }
);
const poId = po.data?.id;
if (poId) {
  await step('E cashier submitPurchaseOrder', 'cashier', 'pharmacyPurchasing.submitPurchaseOrder', {
    purchaseOrderId: poId,
  });
  await step('F cashier approve own PO', 'cashier', 'pharmacyPurchasing.approvePurchaseOrder', {
    purchaseOrderId: poId,
    decision: 'APPROVED',
  });
  await step('G pharmacist approve PO', 'pharmacist', 'pharmacyPurchasing.approvePurchaseOrder', {
    purchaseOrderId: poId,
    decision: 'APPROVED',
    reason: 'QA RBAC probe',
  });
  await step('H cashier sendPurchaseOrder', 'cashier', 'pharmacyPurchasing.sendPurchaseOrder', {
    purchaseOrderId: poId,
  });
}
save(`rbac-purch-${TAG}.json`, { TAG, at: pkt(), log });
console.log('TAG', TAG, 'supplierId', supplierId, 'poId', poId);
await disposeApis();
