// Reverse the two completed verification sales: record a return of the sold line (restock), then refund the tender.
import { trpc, short, disposeApis, save } from './lib.mjs';
const BR = 'cmvx5fc4p000cy5qrcgzjrc3b';
const SHELF = 'cmvxw8ed000094oqr68yrqp8c';
const jobs = [
  {
    k: 'T2',
    saleId: 'cmvzny2ob02h54oqr5dphq71j',
    lineId: 'cmvzny2qy02h94oqrk7ckevku',
    tenderId: 'cmvzny2ul02hd4oqr7cz6zbkg',
    deviceId: process.argv[2],
    date: new Date('2026-11-03T00:00:00.000Z'),
  },
  {
    k: 'T3',
    saleId: 'cmvzny31y02hr4oqr2fef702o',
    lineId: 'cmvzny37202hv4oqrbrm04mft',
    tenderId: 'cmvzny3cd02hz4oqrf8arbrc5',
    deviceId: process.argv[3],
    date: new Date('2026-11-05T00:00:00.000Z'),
  },
];
const out = {};
for (const j of jobs) {
  const cart = await trpc('owner', 'pharmacySales.counterCart', { branchId: BR, saleId: j.saleId });
  const line = (cart.data?.lines ?? []).find((l) => l.id === j.lineId) ?? cart.data?.lines?.[0];
  const units = line?.canonicalUnits ?? 10;
  const lotId = line?.allocations?.[0]?.inventoryLotId ?? line?.lots?.[0]?.inventoryLotId;
  const ret = await trpc(
    'owner',
    'pharmacySales.returnLine',
    {
      branchId: BR,
      saleLineId: j.lineId,
      canonicalUnits: units,
      disposition: 'QUARANTINE',
      quarantineLocationId: 'cmvxw8o9q000d4oqrynjacioh',
      reason: 'QA verification cleanup',
      integrityDecision: 'QA test sale reversed; stock to quarantine shelf',
      idempotencyKey: `qa-cleanup-ret-${j.k}`,
    },
    'mutation'
  );
  console.log(j.k, 'returnLine', short(ret, 160));
  const gross = line?.grossMinor ?? line?.lineTotalMinor;
  const ref = await trpc(
    'owner',
    'pharmacySales.refundTender',
    {
      branchId: BR,
      originalTenderId: j.tenderId,
      deviceId: j.deviceId,
      businessDate: j.date,
      amountMinor: gross ?? 2800,
      reason: 'QA verification cleanup',
      idempotencyKey: `qa-cleanup-ref-${j.k}`,
    },
    'mutation'
  );
  console.log(j.k, 'refundTender', gross, short(ref, 160));
  out[j.k] = {
    ret: { status: ret.status, code: ret.code, message: ret.message },
    ref: { status: ref.status, code: ref.code, message: ref.message, data: ref.data },
    units,
    gross,
    lotId,
  };
}
save('verify-cleanup.json', out);
await disposeApis();
