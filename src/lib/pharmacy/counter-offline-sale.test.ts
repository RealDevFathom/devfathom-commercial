// @vitest-environment node
/**
 * DEV-957 phase 2: offline cash sales at an enrolled counter, with the real runtime, the
 * real WebCrypto snapshot verifier and snapshots signed by the real server signer. Only the
 * browser storage is replaced (an in-memory driver that survives a "reload").
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { counterSaleSealer, importCounterSigningKey } from './counter-device-signing';
import {
  verifyLocalChain,
  type OfflineSaleSeal,
  type OfflineSaleSealer,
  type SealableSale,
} from './offline-sale-seal';
import { offlineSaleSealValid, recordedSaleSealHash, sealOfflineSale } from './offline-sale-seal-node';

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
import { offlinePriceCheckRows, offlineSaleRows } from './counter-offline-catalogue';
import { installCounterSnapshots } from './counter-offline-session';
import {
  addToOfflineDraft,
  composeOfflineCashSale,
  newOfflineDraft,
  OFFLINE_SELLING_OFF_MESSAGE,
  offlineCashSellingOn,
  offlineLinePrice,
  offlineSaleReceipt,
  priceOfflineBill,
  pruneOfflineDraft,
} from './counter-offline-sale';
import { buildCounterReplayRequest, type CounterLeaseCursor } from './counter-command-queue';
import {
  readReconcileIndex,
  readReconcileRecord,
  reconcileSalesCsv,
  reconcileSalesOf,
  settleReconciledSale,
} from './counter-reconcile';
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

/** A throwaway counter secret for these tests only (never a real one). */
const DEVICE_SECRET = `pcd_${randomBytes(32).toString('base64url')}`;
let sealer: OfflineSaleSealer | null = null;
/** The counter seals each sale with its non-extractable key, as the hook does. */
async function counterSealer(): Promise<OfflineSaleSealer> {
  sealer ??= counterSaleSealer(await importCounterSigningKey(DEVICE_SECRET));
  return sealer;
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
  return runtime.enqueue(composed.input, composed.matrix, {
    draftId: draft.draftId,
    sealer: await counterSealer(),
    lineTotalsMinor: composed.lineTotalsMinor,
  });
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

describe('DEV-957 phase 2 (review B1): offline cash selling follows the owner switch in the signed rules', () => {
  it.each([
    ['off', false],
    ['missing (a price list signed before the switch existed)', undefined],
  ] as const)('refuses every offline sale when the switch is %s, and the price check still works', async (_label, value) => {
    const { runtime } = await openCounter();
    const payloads = fixtureSalePayloads({ offlineCashSelling: value ?? false });
    if (value === undefined) delete (payloads.RULES as { offlineCashSelling?: boolean }).offlineCashSelling;
    for (const kind of KINDS) {
      const snapshot = signedSnapshot(kind, payloads[kind as keyof typeof payloads]);
      await runtime.installSnapshot({
        ...snapshot,
        payloadHash: await browserSnapshotPayloadHash(snapshot.payload),
        nowMs: Date.now(),
      });
    }
    await runtime.adoptQuotas(payloads.LOT_BALANCES);
    await runtime.adoptLeases([lease('lease_a', 501, 600)]);
    expect(offlineCashSellingOn(runtime.snapshot())).toBe(false);
    // The price check still lists what this counter holds.
    expect(rowsOf(runtime).length).toBeGreaterThan(0);
    // Review round 2: with nothing set aside, it lists the signed price list itself, one
    // row per lot, with no units to sell.
    const priceCheck = offlinePriceCheckRows(runtime.snapshot(), Date.now());
    expect(priceCheck.map((row) => row.inventoryLotId).sort()).toEqual(
      [...new Set(payloads.PRICES.map((lot: { id: string }) => lot.id))].sort()
    );
    expect(priceCheck.every((row) => row.unitsLeft === 0)).toBe(true);
    const composed = composeOfflineCashSale({
      state: runtime.snapshot(),
      rows: rowsOf(runtime),
      draft: bill(runtime, [['lot_brufen', 'STRIP', 1]]),
      cashReceivedMinor: 1_000,
      nowMs: Date.now(),
    });
    expect(composed).toEqual({ ok: false, message: OFFLINE_SELLING_OFF_MESSAGE });
    // Review round 2: and the counter's own queue refuses it too, whatever is composed.
    const forced = await runtime.enqueue(
      {
        deviceId: FIXTURE_SCOPE.deviceId,
        action: 'CASH_OTC_SALE',
        clientOriginAt: new Date().toISOString(),
        payload: {},
        buckets: [{ inventoryLotId: 'lot_brufen', stockLocationId: 'loc_front', units: 1 }],
      },
      {
        nowMs: Date.now(),
        cachedCreditRemainingMinor: 0,
        controlledMedicinesPermittedOffline: false,
        originalSaleAvailable: false,
        deviceUsable: true,
      }
    );
    expect(forced).toMatchObject({ ok: false, reason: 'SELLING_OFF' });
    expect(runtime.snapshot().queue?.commands).toEqual([]);
    expect(runtime.snapshot().queue?.leases[0]?.nextNumber).toBe(501);
  });
});

describe('DEV-957 phase 2 (hardening 4): each sale is sealed when it is taken, in a chain', () => {
  const SEAL_SCOPE = { ...FIXTURE_SCOPE };

  /** Three sales taken one after another, as the server would receive them. */
  async function threeSales() {
    const { runtime } = await openCounter();
    await prepare(runtime);
    const bodies = [];
    for (const picks of [
      [['lot_brufen', 'STRIP', 1]],
      [['lot_panadol_a', 'PACK', 1]],
      [['lot_brufen', 'UNIT', 3]],
    ] as Array<Array<[string, 'PACK' | 'STRIP' | 'UNIT', number]>>) {
      const sold = await sell(runtime, bill(runtime, picks));
      if (!sold.ok) throw new Error(sold.message);
      const request = await buildCounterReplayRequest(runtime.snapshot().queue!, sold.command, () => ({
        command: 'c',
        receipt: 'r',
      }));
      bodies.push(request.body as unknown as SealableSale & { seal: OfflineSaleSeal });
    }
    return { runtime, bodies };
  }

  /** What the server checks: the seal's MAC, then the chain against the sale before. */
  function serverCheck(bodies: Array<SealableSale & { seal: OfflineSaleSeal }>) {
    for (const body of bodies)
      if (!offlineSaleSealValid(SEAL_SCOPE, body, body.seal, DEVICE_SECRET)) return 'bad_seal';
    const chain = verifyLocalChain(
      bodies.map((body) => ({
        sequence: body.sequence,
        previousHash: body.seal.previousHash,
        hash: recordedSaleSealHash(SEAL_SCOPE, body)!,
      }))
    );
    return chain.ok ? 'ok' : chain.reason;
  }

  it('seals the whole sale with the counter key and chains each sale to the one before', async () => {
    const { runtime, bodies } = await threeSales();
    expect(serverCheck(bodies)).toBe('ok');
    expect(bodies[0]!.seal.previousHash).toBeNull();
    const queued = runtime.snapshot().queue!;
    expect(bodies[1]!.seal.previousHash).toBe(queued.commands[0]!.sealHash);
    expect(bodies[2]!.seal.previousHash).toBe(queued.commands[1]!.sealHash);
    expect(queued.lastSealHash).toBe(queued.commands[2]!.sealHash);
    // The line totals are sealed and add up to the bill.
    for (const body of bodies)
      expect(body.seal.lineTotalsMinor.reduce((sum, total) => sum + total, 0)).toBe(body.amountMinor);
    // The server's own hash of each recorded sale is the hash the counter chained.
    expect(bodies.map((body) => recordedSaleSealHash(SEAL_SCOPE, body))).toEqual(
      queued.commands.map((command) => command.sealHash)
    );
  });

  it('detects an edited sale: a lower total, a lower line, or another cashier', async () => {
    const { bodies } = await threeSales();
    const lowered = structuredClone(bodies);
    lowered[1]!.amountMinor -= 100;
    lowered[1]!.seal.lineTotalsMinor[0]! -= 100;
    expect(serverCheck(lowered)).toBe('bad_seal');
    const fewer = structuredClone(bodies);
    fewer[2]!.lines[0]!.quantity = 1;
    expect(serverCheck(fewer)).toBe('bad_seal');
    const otherTime = structuredClone(bodies);
    otherTime[0]!.leasedReceipt.originalSaleAt = new Date(Date.now() - 86_400_000).toISOString();
    expect(serverCheck(otherTime)).toBe('bad_seal');
    const otherNumber = structuredClone(bodies);
    otherNumber[0]!.leasedReceipt.receiptNumber! += 1;
    expect(serverCheck(otherNumber)).toBe('bad_seal');
  });

  it('detects a dropped sale', async () => {
    const { bodies } = await threeSales();
    expect(serverCheck([bodies[0]!, bodies[2]!])).toBe('gap');
    expect(serverCheck([bodies[1]!, bodies[2]!])).toBe('gap');
  });

  it('detects reordered sales', async () => {
    const { bodies } = await threeSales();
    expect(serverCheck([bodies[0]!, bodies[2]!, bodies[1]!])).not.toBe('ok');
    // Swapping their sequences breaks their seals.
    const swapped = structuredClone(bodies);
    [swapped[1]!.sequence, swapped[2]!.sequence] = [swapped[2]!.sequence, swapped[1]!.sequence];
    expect(serverCheck(swapped)).toBe('bad_seal');
  });

  it('detects an inserted sale, even one sealed with the right key', async () => {
    const { bodies } = await threeSales();
    // Without the key: the forged seal does not verify.
    const forged = structuredClone(bodies[1]!);
    forged.idempotencyKey = 'inserted-sale';
    expect(serverCheck([bodies[0]!, forged, bodies[1]!, bodies[2]!])).toBe('bad_seal');
    // With the key (someone driving the live counter key): the chain still breaks where it
    // was inserted, because the next real sale names the sale before the insert.
    const inserted = { ...structuredClone(bodies[1]!), idempotencyKey: 'inserted-sale' };
    inserted.seal = sealOfflineSale(
      SEAL_SCOPE,
      inserted,
      {
        previousHash: recordedSaleSealHash(SEAL_SCOPE, bodies[0]!),
        lineTotalsMinor: inserted.seal.lineTotalsMinor,
      },
      DEVICE_SECRET
    ).seal;
    const renumbered = [bodies[0]!, inserted, { ...bodies[1]!, sequence: 3 }, { ...bodies[2]!, sequence: 4 }];
    expect(serverCheck(renumbered)).toBe('bad_seal');
    expect(
      verifyLocalChain(
        [bodies[0]!, inserted, bodies[1]!].map((body, index) => ({
          sequence: index + 1,
          previousHash: body.seal.previousHash,
          hash: recordedSaleSealHash(SEAL_SCOPE, body)!,
        }))
      )
    ).toEqual({ ok: false, at: 3, reason: 'edited' });
  });

  it('keeps one copy of each price list, not one per sale, and puts it back when sending', async () => {
    const { runtime, bodies } = await threeSales();
    const queue = runtime.snapshot().queue!;
    for (const command of queue.commands)
      for (const carried of command.payload.snapshots as Array<{ payload?: unknown }>)
        expect(carried.payload).toBeUndefined();
    expect(queue.snapshotArchive).toHaveLength(KINDS.length);
    for (const body of bodies)
      expect(body.snapshots.every((carried) => carried.payload !== undefined)).toBe(true);
  });

  it('takes no sale when the counter cannot seal it, and spends no number or unit', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    const composed = composeOfflineCashSale({
      state: runtime.snapshot(),
      rows: rowsOf(runtime),
      draft: bill(runtime, [['lot_brufen', 'STRIP', 1]]),
      cashReceivedMinor: 1_000,
      nowMs: Date.now(),
    });
    if (!composed.ok) throw new Error(composed.message);
    const refused = await runtime.enqueue(composed.input, composed.matrix, {
      sealer: async () => {
        throw new Error('no key');
      },
      lineTotalsMinor: composed.lineTotalsMinor,
    });
    expect(refused).toMatchObject({ ok: false, reason: 'SEAL_FAILED' });
    expect(runtime.snapshot().queue?.commands).toEqual([]);
    expect(runtime.snapshot().queue?.leases[0]?.nextNumber).toBe(501);
  });
});

describe('DEV-957 phase 2 (review B2): a revoke never deletes an unsent sale', () => {
  async function counterWithTwoSales(driver = createMemoryDriver()) {
    const { runtime } = await openCounter(driver);
    await prepare(runtime);
    const first = await sell(runtime, bill(runtime, [['lot_brufen', 'STRIP', 1]]), 1_000);
    const second = await sell(runtime, bill(runtime, [['lot_panadol_a', 'PACK', 1]]), 5_000);
    if (!first.ok || !second.ok) throw new Error('not sold');
    return { runtime, driver, sold: [first.command, second.command] };
  }

  it('keeps every unsent sale, unchanged and read-only, when the counter is revoked', async () => {
    const { runtime, driver, sold } = await counterWithTwoSales();
    const before = structuredClone(runtime.snapshot().queue!.commands);
    expect(await runtime.revoke({ counterName: 'Front till', reason: 'REVOKED' })).toEqual({
      commands: 2,
    });
    // The counter itself is gone and stopped: nothing to sell, send or print from.
    expect(await driver.read(terminalScopeKey(FIXTURE_SCOPE))).toBeUndefined();
    expect(runtime.snapshot().queue).toMatchObject({ replay: 'STOPPED_REVOKED', commands: [], leases: [] });
    // The sales are kept exactly as they were taken, seal included.
    const [entry] = await readReconcileIndex(driver);
    expect(entry).toMatchObject({
      organizationId: FIXTURE_SCOPE.organizationId,
      branchId: FIXTURE_SCOPE.branchId,
      deviceId: FIXTURE_SCOPE.deviceId,
      counterName: 'Front till',
    });
    const record = (await readReconcileRecord(driver, entry!.recordKey))!;
    expect(record.sales).toEqual(before);
    expect(record.sales.map((sale) => sale.commandId)).toEqual(sold.map((sale) => sale.commandId));
    expect(findForbiddenPersistPath(record)).toBeNull();
    // What a manager reads and exports.
    const rows = reconcileSalesOf(record, entry!.recordKey);
    expect(rows.map((row) => [row.receiptNumber, row.amountMinor, row.cashierName])).toEqual([
      [501, 330, 'Ayesha Khan'],
      [502, 3_500, 'Ayesha Khan'],
    ]);
    expect(rows[1]!.lines[0]).toMatchObject({ saleUnit: 'PACK', quantity: 1, lineTotalMinor: 3_500 });
    expect(rows[0]!.lines[0]!.medicineName).toBeTruthy();
    const csv = reconcileSalesCsv(rows);
    expect(csv.split('\n')[0]).toContain('Receipt number');
    expect(csv).toContain('501');
    expect(csv).toContain('35.00');
    // Revoked: it can never take another sale or bill.
    const composed = composeOfflineCashSale({
      state: runtime.snapshot(),
      rows: rowsOf(runtime),
      draft: newOfflineDraft(OPERATOR.userId, new Date()),
      cashReceivedMinor: 1_000,
      nowMs: Date.now(),
    });
    expect(composed.ok).toBe(false);
  });

  it('keeps them too when the server says so during a replay', async () => {
    const { runtime, driver } = await counterWithTwoSales();
    const outcome = await runtime.replay(
      async () => ({ status: 403, serverMessage: 'This device has been revoked.' }),
      async () => ({ command: 'c', receipt: 'r' })
    );
    expect(outcome.state).toBe('STOPPED');
    const [entry] = await readReconcileIndex(driver);
    expect((await readReconcileRecord(driver, entry!.recordKey))!.sales).toHaveLength(2);
  });

  it('lets a sale go only once a manager recorded it, and drops the record with the last one', async () => {
    const { runtime, driver, sold } = await counterWithTwoSales();
    await runtime.revoke({ counterName: 'Front till' });
    const [entry] = await readReconcileIndex(driver);
    const left = await settleReconciledSale(driver, entry!.recordKey, sold[0]!.commandId);
    expect(left!.sales.map((sale) => sale.commandId)).toEqual([sold[1]!.commandId]);
    expect(await settleReconciledSale(driver, entry!.recordKey, sold[1]!.commandId)).toBeNull();
    expect(await readReconcileIndex(driver)).toEqual([]);
    expect(await driver.read(entry!.recordKey)).toBeUndefined();
  });

  it('keeps the stopped counter document, sales and all, when the sales cannot be set aside', async () => {
    const base = createMemoryDriver();
    const driver = {
      ...base,
      read: base.read.bind(base),
      writeIfRevision: base.writeIfRevision.bind(base),
      remove: base.remove.bind(base),
      close: base.close.bind(base),
      write: async (key: string, value: unknown) => {
        if (key.endsWith('::reconcile')) throw new Error('quota exceeded');
        return base.write(key, value);
      },
    };
    const { runtime } = await counterWithTwoSales(driver);
    await runtime.revoke();
    const stored = (await base.read(terminalScopeKey(FIXTURE_SCOPE))) as {
      queue: { replay: string; commands: unknown[]; leases: unknown[] };
    };
    expect(stored.queue.replay).toBe('STOPPED_REVOKED');
    expect(stored.queue.commands).toHaveLength(2);
    expect(stored.queue.leases).toEqual([]);
  });

  it('a revoked counter with nothing unsent keeps nothing', async () => {
    const driver = createMemoryDriver();
    const { runtime } = await openCounter(driver);
    await prepare(runtime);
    expect(await runtime.revoke()).toEqual({ commands: 0 });
    expect(await readReconcileIndex(driver)).toEqual([]);
  });

  it('never lets a spreadsheet read an exported cell as a formula', () => {
    const csv = reconcileSalesCsv([
      {
        recordKey: 'k',
        counterName: '=HYPERLINK("x")',
        deviceId: 'd',
        commandId: 'c',
        sequence: 1,
        receiptNumber: 1,
        soldAt: '2026-11-20T10:00:00.000Z',
        amountMinor: 100,
        cashReceivedMinor: 100,
        cashierName: '+cmd',
        sealHash: null,
        lines: [],
      },
    ]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain("'+cmd");
  });
});

describe('DEV-957 phase 2 (review B3): a quota the server released stops selling at the next contact', () => {
  it('refuses that lot offline from then on, even with sales waiting, and keeps the others', async () => {
    const { runtime } = await openCounter();
    await prepare(runtime);
    const sold = await sell(runtime, bill(runtime, [['lot_panadol_a', 'UNIT', 2]]), 1_000);
    expect(sold.ok).toBe(true);
    // A recall, quarantine or expiry removal released lot_brufen's quota on the server; the
    // next signed list no longer carries it.
    const payloads = fixtureSalePayloads();
    const released = payloads.LOT_BALANCES.filter((row) => row.inventoryLotId !== 'lot_brufen');
    const fresh = KINDS.map((kind) =>
      signedSnapshot(kind, kind === 'LOT_BALANCES' ? released : payloads[kind as keyof typeof payloads], {
        version: 2,
      })
    );
    const report = await installCounterSnapshots(runtime, 'token', {
      driver: createMemoryDriver(),
      verifier: webCryptoSnapshotVerifier(),
      transport: {
        establish: async () => {
          throw new Error('unused');
        },
        snapshots: async () => ({ snapshots: fresh, publicKey: fixturePublicKey() }),
        lease: async () => null,
        quota: async () => null,
      },
      payloadHash: (payload) => browserSnapshotPayloadHash(payload),
      now: () => Date.now(),
    });
    expect(report.installed).toContain('LOT_BALANCES');
    const quotas = runtime.snapshot().queue!.quotas;
    const brufen = quotas.find((quota) => quota.inventoryLotId === 'lot_brufen')!;
    expect(brufen.quotaUnits - brufen.consumedUnits).toBe(0);
    // Its own debit on the other lot is kept, not reset to the server's older figure.
    const panadol = quotas.find((quota) => quota.inventoryLotId === 'lot_panadol_a')!;
    expect(panadol.consumedUnits).toBe(2);
    expect(rowsOf(runtime).map((row) => row.inventoryLotId)).toEqual(['lot_panadol_a']);
  });
});
