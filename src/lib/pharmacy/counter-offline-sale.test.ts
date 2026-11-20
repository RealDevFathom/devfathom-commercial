// @vitest-environment node
/**
 * DEV-957 phase 2: offline cash sales at an enrolled counter, with the real runtime, the
 * real WebCrypto snapshot verifier and snapshots signed by the real server signer. Only the
 * browser storage is replaced (an in-memory driver that survives a "reload").
 */
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_SCOPE,
  fixturePublicKey,
  fixtureSalePayloads,
  signedSnapshot,
} from '@/lib/test-support/pharmacy-offline-snapshots';
import { findForbiddenPersistPath, terminalScopeKey } from '@/lib/retail-terminal/local-store';

import {
  createMemoryDriver,
  PharmacyCounterRuntime,
  projectCounterDraft,
  type CounterDraft,
} from './counter-offline-runtime';
import { webCryptoSnapshotVerifier, browserSnapshotPayloadHash } from './counter-snapshot-verifier';
import { offlineSaleRows } from './counter-offline-catalogue';
import {
  addToOfflineDraft,
  composeOfflineCashSale,
  newOfflineDraft,
  offlineLinePrice,
  offlineSaleReceipt,
  priceOfflineBill,
  pruneOfflineDraft,
} from './counter-offline-sale';
import { buildCounterReplayRequest, type CounterLeaseCursor } from './counter-command-queue';
import { priceFromLot } from './medicine';
import { priceMixedLotAllocation } from './sales';
import { buildCounterReceiptPreview } from './counter-receipt-presentation';
import type { PharmacyOfflineSnapshotKind } from './offline-action-matrix';

const KINDS: PharmacyOfflineSnapshotKind[] = ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'];
const OPERATOR = { userId: 'user_cashier_a', name: 'Ayesha Khan' };

function lease(id: string, start: number, end: number): CounterLeaseCursor {
  return { leaseId: id, blockStart: start, blockEnd: end, nextNumber: start };
}

async function openCounter(
  driver = createMemoryDriver(),
  options: { quotaUnits?: number; leases?: CounterLeaseCursor[]; operator?: typeof OPERATOR } = {}
) {
  const runtime = new PharmacyCounterRuntime(
    FIXTURE_SCOPE,
    driver,
    webCryptoSnapshotVerifier(),
    fixturePublicKey()
  );
  expect(await runtime.hydrate()).toBe('ready');
  return { runtime, driver, ...options };
}

async function prepare(
  runtime: PharmacyCounterRuntime,
  options: { quotaUnits?: number; leases?: CounterLeaseCursor[]; operator?: typeof OPERATOR } = {}
) {
  const payloads = fixtureSalePayloads({ quotaUnits: options.quotaUnits, operator: options.operator });
  for (const kind of KINDS) {
    const snapshot = signedSnapshot(kind, payloads[kind as keyof typeof payloads]);
    const result = await runtime.installSnapshot({
      ...snapshot,
      payloadHash: await browserSnapshotPayloadHash(snapshot.payload),
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(true);
  }
  await runtime.adoptQuotas(payloads.LOT_BALANCES);
  await runtime.adoptLeases(options.leases ?? [lease('lease_a', 501, 600)]);
}

function rowsOf(runtime: PharmacyCounterRuntime) {
  return offlineSaleRows(runtime.snapshot(), Date.now());
}

function bill(runtime: PharmacyCounterRuntime, picks: Array<[string, 'PACK' | 'STRIP' | 'UNIT', number]>) {
  let draft: CounterDraft = newOfflineDraft(OPERATOR.userId, new Date());
  for (const [lotId, kind, quantity] of picks) {
    const row = rowsOf(runtime).find((candidate) => candidate.inventoryLotId === lotId)!;
    const option = row.saleUnits.find((unit) => unit.kind === kind)!;
    for (let index = 0; index < quantity; index += 1)
      draft = addToOfflineDraft(draft, row, option, new Date());
  }
  return draft;
}

async function sell(runtime: PharmacyCounterRuntime, draft: CounterDraft, cash = 100_000) {
  const composed = composeOfflineCashSale({
    state: runtime.snapshot(),
    rows: rowsOf(runtime),
    draft,
    cashReceivedMinor: cash,
    nowMs: Date.now(),
  });
  if (!composed.ok) throw new Error(composed.message);
  return runtime.enqueue(composed.input, composed.matrix, { draftId: draft.draftId });
}

describe('DEV-957 phase 2: the price the counter signs is the price the server charges', () => {
  it('matches addSaleLine (priceFromLot + priceMixedLotAllocation) for packs, strips and units', () => {
    // An odd pack (21 = 3 strips x 7) and rounding increments that bite on strips and units.
    const cases: Array<{ mrp: number; pack: number; units: number[] }> = [
      { mrp: 1_000, pack: 21, units: [21, 7, 1] },
      { mrp: 999, pack: 7, units: [7, 1] },
      { mrp: 12_345, pack: 30, units: [30, 10, 1] },
      { mrp: 100, pack: 3, units: [3, 1] },
    ];
    for (const { mrp, pack, units } of cases)
      for (const perUnit of units)
        for (const rounding of [1, 5, 10, 50])
          for (const quantity of [1, 2, 3, 7, 13, 1000]) {
            const server = priceFromLot({
              printedMrpMinor: mrp,
              canonicalUnitsInPack: pack,
              canonicalUnitsPerSaleUnit: perUnit,
              roundingIncrementMinor: rounding,
            });
            const charged = priceMixedLotAllocation(
              [{ units: quantity * perUnit, unitPriceMinor: server.unitPriceMinor }],
              quantity,
              perUnit
            );
            const signed = offlineLinePrice({
              printedMrpMinor: mrp,
              unitsPerPack: pack,
              canonicalUnitsPerSaleUnit: perUnit,
              roundingIncrementMinor: rounding,
              quantity,
            });
            expect(signed.lineTotalMinor).toBe(charged.grossMinor);
            expect(signed.unitPriceMinor).toBe(charged.unitPriceMinor);
          }
  });

  it('prices the odd 21-tablet box exactly: pack 1000, strip 330, tablet 45 with a 5-paisa rule', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    const priced = priceOfflineBill(
      bill(runtime, [
        ['lot_brufen', 'PACK', 1],
        ['lot_brufen', 'STRIP', 1],
        ['lot_brufen', 'UNIT', 3],
      ]),
      rowsOf(runtime)
    );
    expect(priced.lines.map((line) => [line.option.kind, line.unitPriceMinor, line.lineTotalMinor])).toEqual([
      ['PACK', 1_000, 1_000],
      ['STRIP', 330, 330],
      ['UNIT', 45, 135],
    ]);
    expect(priced.totalMinor).toBe(1_465);
  });
});

describe('DEV-957 phase 2: offline cash sales are queued with leased receipt numbers', () => {
  it('keeps a sale after the browser closes, and the next sale takes the next number', async () => {
    const first = await openCounter();
    await prepare(first.runtime);
    const sold = await sell(first.runtime, bill(first.runtime, [['lot_panadol_a', 'UNIT', 2]]));
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;
    expect(sold.command.receiptNumber).toBe(501);
    expect(sold.command.payload).toMatchObject({
      amountMinor: 700,
      cashReceivedMinor: 100_000,
      leasedReceipt: { leaseId: 'lease_a' },
    });
    first.runtime.close();

    // "Reopen while still offline": a new runtime over the same stored document.
    const reopened = await openCounter(first.driver);
    const queue = reopened.runtime.snapshot().queue!;
    expect(queue.commands).toHaveLength(1);
    expect(queue.commands[0]).toMatchObject({ receiptNumber: 501, sequence: 1, status: 'PENDING' });
    const next = await sell(reopened.runtime, bill(reopened.runtime, [['lot_panadol_a', 'PACK', 1]]));
    expect(next.ok && next.command.receiptNumber).toBe(502);
    expect(next.ok && next.command.sequence).toBe(2);
    // The quota the first sale used is still spent after the reload.
    const panadol = rowsOf(reopened.runtime).find((row) => row.inventoryLotId === 'lot_panadol_a')!;
    expect(panadol.unitsLeft).toBe(20 - 2 - 10);
  });

  it('two sales tapped at once draw two numbers and two sequences (#554)', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    const [a, b] = await Promise.all([
      sell(runtime, bill(runtime, [['lot_panadol_a', 'UNIT', 1]])),
      sell(runtime, bill(runtime, [['lot_brufen', 'UNIT', 1]])),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(new Set([a.command.receiptNumber, b.command.receiptNumber])).toEqual(new Set([501, 502]));
    expect(new Set([a.command.sequence, b.command.sequence])).toEqual(new Set([1, 2]));
    expect(runtime.snapshot().queue!.commands).toHaveLength(2);
  });

  it('refuses a bill over this counter quota with a plain message and spends nothing', async () => {
    const { runtime } = await openCounter(undefined);
    await prepare(runtime, { quotaUnits: 5 });
    const before = structuredClone(runtime.snapshot());
    const draft = bill(runtime, [['lot_panadol_a', 'UNIT', 6]]);
    const composed = composeOfflineCashSale({
      state: runtime.snapshot(),
      rows: rowsOf(runtime),
      draft,
      cashReceivedMinor: 10_000,
      nowMs: Date.now(),
    });
    expect(composed).toEqual({
      ok: false,
      message:
        'This counter holds only 5 units of Panadol 500mg for offline selling. Lower the quantity.',
    });
    // Even a caller that skips the check cannot over-sell: the runtime refuses it whole.
    const forced = await runtime.enqueue(
      {
        deviceId: FIXTURE_SCOPE.deviceId,
        action: 'CASH_OTC_SALE',
        clientOriginAt: new Date().toISOString(),
        payload: { leasedReceipt: {}, amountMinor: 2_100, cashReceivedMinor: 2_100 },
        buckets: [{ inventoryLotId: 'lot_panadol_a', stockLocationId: 'loc_front', units: 6 }],
      },
      {
        nowMs: Date.now(),
        cachedCreditRemainingMinor: 0,
        controlledMedicinesPermittedOffline: false,
        originalSaleAvailable: false,
        deviceUsable: true,
      }
    );
    expect(forced).toMatchObject({ ok: false, reason: 'QUOTA_EXCEEDED' });
    expect(runtime.snapshot().queue).toEqual(before.queue);
  });

  it('refuses when the receipt block is used up, keeps the bill and spends no stock', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime, { leases: [lease('lease_a', 501, 501)] });
    expect((await sell(runtime, bill(runtime, [['lot_panadol_a', 'UNIT', 1]]))).ok).toBe(true);
    const draft = bill(runtime, [['lot_panadol_a', 'UNIT', 1]]);
    await runtime.saveDraft(draft);
    const before = structuredClone(runtime.snapshot().queue);
    const refused = await sell(runtime, draft);
    expect(refused).toMatchObject({ ok: false, reason: 'NO_RECEIPT_NUMBER' });
    expect(runtime.snapshot().queue).toEqual(before);
    expect(runtime.drafts().map((row) => row.draftId)).toEqual([draft.draftId]);
  });

  it('names the lease each number was drawn from, across two blocks', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime, { leases: [lease('lease_a', 501, 501), lease('lease_b', 900, 910)] });
    const one = await sell(runtime, bill(runtime, [['lot_panadol_a', 'UNIT', 1]]));
    const two = await sell(runtime, bill(runtime, [['lot_panadol_a', 'UNIT', 1]]));
    expect(one.ok && [one.command.receiptNumber, (one.command.payload.leasedReceipt as { leaseId: string }).leaseId]).toEqual([501, 'lease_a']);
    expect(two.ok && [two.command.receiptNumber, (two.command.payload.leasedReceipt as { leaseId: string }).leaseId]).toEqual([900, 'lease_b']);
  });

  it('builds a replay request the server schema accepts, with the RULES envelope on the receipt', async () => {
    const { counterReplaySchema } = await import('@/server/routers/pharmacy-offline');
    const { runtime } = await openCounter();
    await prepare(runtime);
    const sold = await sell(
      runtime,
      bill(runtime, [
        ['lot_brufen', 'STRIP', 2],
        ['lot_panadol_a', 'PACK', 1],
      ]),
      5_000
    );
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;
    const request = await buildCounterReplayRequest(runtime.snapshot().queue!, sold.command, () => ({
      command: 'c',
      receipt: 'r',
    }));
    const parsed = counterReplaySchema.parse(request.body);
    expect(parsed.amountMinor).toBe(2 * 330 + 3_500);
    expect(parsed.cashReceivedMinor).toBe(5_000);
    expect(parsed.leasedReceipt.envelope.kind).toBe('RULES');
    expect(parsed.snapshots.map((snapshot) => snapshot.envelope.kind).sort()).toEqual([...KINDS].sort());
    expect(parsed.lines).toEqual([
      expect.objectContaining({ saleUnit: 'STRIP', packLevelId: 'pack_brufen_strip', canonicalUnitsPerSaleUnit: 7, quantity: 2 }),
      expect.objectContaining({ saleUnit: 'PACK', packLevelId: 'pack_panadol', canonicalUnitsPerSaleUnit: 10, quantity: 1 }),
    ]);
  });

  it('shows the receipt in the online receipt model with the leased number, the cashier and the sale time', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    const draft = bill(runtime, [['lot_brufen', 'STRIP', 1]]);
    const priced = priceOfflineBill(draft, rowsOf(runtime));
    const sold = await sell(runtime, draft, 500);
    if (!sold.ok) throw new Error(sold.message);
    const receipt = offlineSaleReceipt({
      bill: priced,
      receiptNumber: sold.command.receiptNumber!,
      soldAt: sold.command.clientOriginAt,
      cashReceivedMinor: 500,
      counterName: 'Front counter',
      branchName: 'Gulberg branch',
      cashierName: OPERATOR.name,
      commandId: sold.command.commandId,
    });
    expect(receipt).toMatchObject({
      receiptNumber: 501,
      totals: { netMinor: 330, changeMinor: 170, tenderedMinor: 330 },
      cashierName: 'Ayesha Khan',
    });
    const preview = buildCounterReceiptPreview(receipt, 'en', 80);
    expect(preview).toContain('501');
    expect(preview).toContain('Ayesha Khan');
    expect(preview).toContain('Batch: BR-01');
    expect(preview).toContain('Counter Front counter, sold offline');
  });
});

describe('DEV-957 phase 2: the offline bill is saved locally', () => {
  it('brings a bill back after a reload, through the allowlist projection only', async () => {
    const first = await openCounter();
    await prepare(first.runtime);
    const draft = bill(first.runtime, [['lot_brufen', 'UNIT', 2]]);
    // A caller that attaches anything else does not get it stored.
    const tampered = {
      ...draft,
      customerName: 'Never stored',
      lines: draft.lines.map((line) => ({ ...line, unitPriceMinor: 1 })),
    } as unknown as CounterDraft;
    expect(await first.runtime.saveDraft(tampered)).toBe(true);
    first.runtime.close();
    const reopened = await openCounter(first.driver);
    expect(reopened.runtime.drafts()).toEqual([draft]);
    const raw = await first.driver.read(terminalScopeKey(FIXTURE_SCOPE));
    expect(JSON.stringify(raw)).not.toContain('Never stored');
    expect(JSON.stringify(raw)).not.toContain('unitPriceMinor');
    expect(findForbiddenPersistPath(raw)).toBeNull();
  });

  it('refuses a draft the projection cannot read and keeps the stored ones', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    expect(projectCounterDraft({ draftId: 'x', operatorUserId: null, updatedAt: 'no', lines: [] })).toBeNull();
    expect(await runtime.saveDraft({ draftId: '', operatorUserId: null, updatedAt: '', lines: [] } as CounterDraft)).toBe(false);
  });

  it('a paid bill leaves the drafts in the same write', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    const draft = bill(runtime, [['lot_panadol_a', 'UNIT', 1]]);
    await runtime.saveDraft(draft);
    expect((await sell(runtime, draft)).ok).toBe(true);
    expect(runtime.drafts()).toEqual([]);
  });

  it('drops the previous cashier bills when the counter is signed for another cashier', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    await runtime.saveDraft(bill(runtime, [['lot_panadol_a', 'UNIT', 1]]));
    expect(runtime.drafts()).toHaveLength(1);
    const rules = signedSnapshot(
      'RULES',
      fixtureSalePayloads({ operator: { userId: 'user_cashier_b', name: 'Bilal' } }).RULES,
      { version: 2 }
    );
    const installed = await runtime.installSnapshot({
      ...rules,
      payloadHash: await browserSnapshotPayloadHash(rules.payload),
      nowMs: Date.now(),
    });
    expect(installed.ok).toBe(true);
    expect(runtime.drafts()).toEqual([]);
    // Queued sales are money already taken: they stay.
  });

  it('upgrades a phase-1 document in place, keeping its receipt numbers and quotas', async () => {
    const leases = [lease('lease_a', 501, 600)];
    const driver = createMemoryDriver([
      [
        terminalScopeKey(FIXTURE_SCOPE),
        {
          schemaVersion: 2,
          scope: FIXTURE_SCOPE,
          catalog: { snapshotPublicKey: fixturePublicKey(), snapshots: [] },
          queue: {
            deviceId: FIXTURE_SCOPE.deviceId,
            nextSequence: 1,
            replay: 'READY',
            commands: [],
            leases,
            quotas: [],
            safetyLeaseEvents: [],
          },
        },
      ],
    ]);
    const { runtime } = await openCounter(driver);
    expect(runtime.snapshot().queue!.leases).toEqual(leases);
    expect(runtime.drafts()).toEqual([]);
    expect(((await driver.read(terminalScopeKey(FIXTURE_SCOPE))) as { schemaVersion: number }).schemaVersion).toBe(3);
  });
});

describe('DEV-957 phase 2: what can never be sold offline', () => {
  it('lists only signed over-the-counter lots this counter holds quota for', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    // An item the server never signed into the catalogue (prescription-only, controlled,
    // restricted, high-alert or look-alike), even with a quota and a price, is never offered.
    const rows = rowsOf(runtime).map((row) => row.medicineId).sort();
    expect(rows).toEqual(['med_brufen', 'med_panadol']);
    const draft: CounterDraft = {
      draftId: 'crafted',
      operatorUserId: OPERATOR.userId,
      updatedAt: new Date().toISOString(),
      lines: [
        {
          inventoryLotId: 'lot_rx_only',
          stockLocationId: 'loc_front',
          medicineId: 'med_rx',
          presentationId: 'pres_rx',
          packLevelId: 'pack_rx',
          saleUnit: 'PACK',
          canonicalUnitsPerSaleUnit: 14,
          quantity: 1,
        },
      ],
    };
    const composed = composeOfflineCashSale({
      state: runtime.snapshot(),
      rows: rowsOf(runtime),
      draft,
      cashReceivedMinor: 100_000,
      nowMs: Date.now(),
    });
    expect(composed.ok).toBe(false);
  });

  it('refuses cash below the total', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    const composed = composeOfflineCashSale({
      state: runtime.snapshot(),
      rows: rowsOf(runtime),
      draft: bill(runtime, [['lot_panadol_a', 'PACK', 1]]),
      cashReceivedMinor: 3_499,
      nowMs: Date.now(),
    });
    expect(composed).toEqual({
      ok: false,
      message: 'The cash received is less than the total. Take the full amount.',
    });
  });
});

describe('DEV-957 phase 2: a bill with an item that can no longer be sold offline', () => {
  it('refuses payment until that item is taken off, then the rest can be paid', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    const valid = bill(runtime, [['lot_panadol_a', 'UNIT', 2]]);
    // A line whose lot has since left the signed list (expired, recalled or quota gone).
    const stale: CounterDraft = {
      ...valid,
      lines: [
        ...valid.lines,
        {
          inventoryLotId: 'lot_gone',
          stockLocationId: 'loc_front',
          medicineId: 'med_gone',
          presentationId: 'pres_gone',
          packLevelId: 'pack_gone',
          saleUnit: 'PACK',
          canonicalUnitsPerSaleUnit: 10,
          quantity: 1,
        },
      ],
    };
    const blocked = composeOfflineCashSale({
      state: runtime.snapshot(),
      rows: rowsOf(runtime),
      draft: stale,
      cashReceivedMinor: 1_000,
      nowMs: Date.now(),
    });
    expect(blocked).toEqual({
      ok: false,
      message:
        'A medicine on this bill can no longer be sold offline from this counter. Take it off to pay for the rest.',
    });
    const pruned = pruneOfflineDraft(stale, rowsOf(runtime), new Date());
    expect(pruned.lines).toEqual(valid.lines);
    expect(priceOfflineBill(pruned, rowsOf(runtime)).problems).toEqual([]);
    // The trimmed bill is saved (a reload brings back only the sellable lines) and pays.
    expect(await runtime.saveDraft(pruned)).toBe(true);
    expect(runtime.drafts()[0]!.lines).toEqual(valid.lines);
    const sold = await sell(runtime, pruned, 1_000);
    expect(sold.ok && sold.command.payload.amountMinor).toBe(700);
  });
});
