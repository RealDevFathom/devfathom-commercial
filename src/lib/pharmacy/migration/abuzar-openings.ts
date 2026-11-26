import 'server-only';
import {
  eligibleOpeningWitness,
  verifyOpeningWitness,
  appendOpeningRegister,
} from './abuzar-witness';
import { createHash } from 'node:crypto';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { assertPostingPeriodsOpen } from '@/lib/finance/journal';
import { postOpeningStockEntry } from '../finance-postings';
import { packConversions } from '../pack-conversion';
import { expiryInstant, type LedgerScope } from '../stock-ledger';
import {
  createOpeningSession,
  draftLine,
  postOpeningSession,
  postOpeningLedger,
} from './opening-stock';
import {
  amountMinor,
  packUnits,
  unitMinor,
  stockReason,
  unverifiedBatch,
  type Prepared,
} from '../../../../tools/abuzar-import/prepared';

type Options = {
  sourceBranch: string;
  cutover?: string;
  witnessId?: string;
  stockLocationId?: string;
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function openingContext(
  db: ScopedDb,
  scope: LedgerScope,
  options: Options,
  step: 'stock' | 'balances'
) {
  if (!options.cutover || !/^\d{4}-\d\d-\d\d$/.test(options.cutover))
    throw new Error('Choose the opening date.');
  const at = new Date(options.cutover + 'T00:00:00Z');
  if (!Number.isFinite(at.getTime()) || at.toISOString().slice(0, 10) !== options.cutover)
    throw new Error('Invalid opening date.');
  const period = await db.pharmacyAccountingPeriod.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
      startsAt: { lte: at },
      endsAt: { gt: at },
    },
    select: { id: true },
  });
  const entries = await db.$queryRaw<
    { sourceId: string; rowHash: string; branchId: string; partyId: string | null }[]
  >`SELECT "sourceId","rowHash","branchId","partyId" FROM pharmacy_abuzar_openings WHERE "organizationId"=${scope.organizationId} AND "sourceBranch"=${options.sourceBranch} AND step=${step}`;
  const prior = new Map(entries.map((e) => [e.sourceId, e]));
  return { at, period, prior, entries };
}
export async function balanceDecision(
  db: ScopedDb,
  scope: LedgerScope,
  options: Options,
  data: Prepared
) {
  // Family accounts and their events require the verified active branch in this transaction.
  await db.$queryRaw`SELECT set_config('app.current_branch_id', ${scope.branchId}, true)`;
  const { at, period, prior, entries } = await openingContext(db, scope, options, 'balances');
  const parties = await db.$queryRaw<
    { sourceId: string; customerId: string | null; supplierId: string | null }[]
  >`SELECT "sourceId","customerId","supplierId" FROM pharmacy_abuzar_parties WHERE "organizationId"=${scope.organizationId}`;
  const ids = new Map(parties.map((p) => [p.sourceId, p]));
  const counts = new Map<string, number>();
  for (const r of data.tables.balances)
    if (r.Branch === options.sourceBranch) counts.set(r.PartyID, (counts.get(r.PartyID) ?? 0) + 1);
  const importedParties = new Set(
    entries.filter((e) => e.branchId === scope.branchId).map((e) => e.partyId)
  );
  const names = new Map(data.tables.parties.map((p) => [p.RowID, p.Name]));
  const rows = data.tables.balances.map((row, i) => {
    const amount = amountMinor(row.Amount),
      party = ids.get(row.PartyID),
      old = prior.get(row.RowID);
    const rowHash = hash([row, options.cutover]);
    let reason: string | null = null;
    if (row.Branch !== options.sourceBranch) reason = 'other source branch';
    else if (old)
      reason =
        old.rowHash === rowHash && old.branchId === scope.branchId
          ? 'already imported'
          : 'opening balance changed';
    else if (!period) reason = 'choose an open accounting period';
    else if (!party || !names.has(row.PartyID)) reason = 'party has not been imported';
    else if (counts.get(row.PartyID)! > 1 || importedParties.has(row.PartyID))
      reason = 'duplicate party opening balance';
    else if (amount === null || amount > BigInt(2147483647) || amount < BigInt(-2147483647))
      reason = 'invalid balance';
    return { row, index: i + 2, party, amount, rowHash, reason };
  });
  return {
    rows,
    apply: async () => {
      await assertPostingPeriodsOpen(db, scope.organizationId, at, scope.branchId);
      for (const d of rows) {
        if (d.reason || !d.party || d.amount === null) continue;
        const session = await createOpeningSession(db, scope, { openingAt: at });
        const account = d.party.customerId ? 'ACCOUNTS_RECEIVABLE' : 'ACCOUNTS_PAYABLE';
        await postOpeningLedger(db, scope, {
          sessionId: session.id,
          balances: [
            {
              account,
              balanceMinor: d.party.customerId ? d.amount : -d.amount,
              sourceRef: 'Abuzar opening ' + d.rowHash,
            },
          ],
        });
        const entry = await db.pharmacyOpeningLedgerEntry.findFirstOrThrow({
          where: { organizationId: scope.organizationId, sessionId: session.id, account },
          select: { id: true },
        });
        if (d.party.customerId && d.amount !== BigInt(0)) {
          const family = await db.pharmacyFamilyAccount.create({
            data: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              payerCustomerId: d.party.customerId,
              displayName: names.get(d.row.PartyID)!,
            },
          });
          const member = await db.pharmacyFamilyMember.create({
            data: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              familyAccountId: family.id,
              customerId: d.party.customerId,
            },
          });
          await db.pharmacyKhataEvent.create({
            data: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              familyAccountId: family.id,
              memberId: member.id,
              actorId: scope.actorId,
              kind: d.amount > BigInt(0) ? 'OPENING_DEBIT' : 'OPENING_CREDIT',
              amountMinor: Math.abs(Number(d.amount)),
              occurredAt: at,
              note: 'Imported from Abuzar',
            },
          });
        }
        await db.$executeRaw`INSERT INTO pharmacy_abuzar_openings ("organizationId","branchId","sourceBranch",step,"sourceId","rowHash","ledgerEntryId","partyId") VALUES (${scope.organizationId},${scope.branchId},${options.sourceBranch},'balances',${d.row.RowID},${d.rowHash},${entry.id},${d.row.PartyID})`;
      }
    },
  };
}
export async function stockDecision(
  db: ScopedDb,
  scope: LedgerScope,
  options: Options,
  data: Prepared,
  witnessSecret?: string
) {
  const { at, period, prior } = await openingContext(db, scope, options, 'stock');
  const witness =
    options.witnessId && (await eligibleOpeningWitness(db, scope, options.witnessId))
      ? options.witnessId
      : null;
  const location =
    options.stockLocationId &&
    (await db.pharmacyStockLocation.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        id: options.stockLocationId,
        active: true,
      },
      select: { id: true },
    }));
  const source = new Map(data.tables.products.map((p) => [p.ICode, p]));
  const links = await db.pharmacyStagedMedicineLink.findMany({
    where: {
      organizationId: scope.organizationId,
      sourceKey: { in: data.tables.products.map((p) => 'abuzar-item:' + p.ICode) },
      medicineId: { not: null },
    },
    select: {
      sourceKey: true,
      medicineId: true,
      mrpMinor: true,
      purchasePriceMinor: true,
      unitsPerPack: true,
    },
  });
  const byCode = new Map(links.map((l) => [l.sourceKey.slice('abuzar-item:'.length), l]));
  const medicines = await db.medicine.findMany({
    where: {
      organizationId: scope.organizationId,
      id: { in: links.flatMap((l) => (l.medicineId ? [l.medicineId] : [])) },
    },
    select: { id: true, controlled: true, presentations: { select: { packLevels: true } } },
  });
  const byMedicine = new Map(medicines.map((m) => [m.id, m]));
  const rows = data.tables.stock.map((row, i) => {
    const product = source.get(row.ICode),
      link = byCode.get(row.ICode),
      medicine = link?.medicineId ? byMedicine.get(link.medicineId) : null;
    const units = packUnits(product?.PackUnits ?? ''),
      cost = unitMinor(product?.PurPrice ?? '', units),
      mrp = amountMinor(product?.SalePrice ?? '');
    const candidates =
      medicine?.presentations.flatMap((p) =>
        packConversions(p.packLevels).filter(
          (c) =>
            c.canonicalUnitsPerPack === units &&
            p.packLevels.some((l) => l.id === c.packLevelId && !l.parentPackLevelId)
        )
      ) ?? [];
    const old = prior.get(row.RowID),
      rowHash = hash([
        row,
        product?.PackUnits,
        product?.SalePrice,
        product?.PurPrice,
        options.cutover,
        options.stockLocationId,
      ]);
    const held = unverifiedBatch(row),
      expiry = held ? null : new Date(row.Expiry + 'T00:00:00Z');
    let reason = stockReason(row, product);
    if (row.Branch !== options.sourceBranch) reason = 'other source branch';
    else if (old)
      reason =
        old.rowHash === rowHash && old.branchId === scope.branchId
          ? 'already imported'
          : 'opening stock changed';
    else if (!reason) {
      if (!period || !location) reason = 'choose an open period and active stock location';
      else if (!medicine || !link || !units || candidates.length !== 1)
        reason = 'catalogue approval or matching pack required';
      else if (medicine.controlled && Number(row.Quantity) > 0 && !witness)
        reason = 'controlled opening requires a witnessed register entry';
      else if (
        !mrp ||
        mrp <= BigInt(0) ||
        Number(mrp) !== link.mrpMinor ||
        Number(amountMinor(product!.PurPrice)) !== link.purchasePriceMinor ||
        units !== link.unitsPerPack
      )
        reason = 'approved price or cost required';
      else if (
        expiry &&
        (!Number.isFinite(expiry.getTime()) || expiry.toISOString().slice(0, 10) !== row.Expiry)
      )
        reason = 'invalid expiry';
    }
    return {
      row,
      index: i + 2,
      rowHash,
      held,
      expiry,
      units,
      cost,
      mrp,
      controlled: medicine?.controlled === true,
      medicineId: medicine?.id,
      packId: candidates[0]?.packLevelId,
      reason,
    };
  });
  return {
    rows,
    apply: async () => {
      await assertPostingPeriodsOpen(db, scope.organizationId, at, scope.branchId);
      const needsWitness = rows.some(
        (d) => !d.reason && d.controlled && Number(d.row.Quantity) > 0
      );
      if (
        needsWitness &&
        (!witness || !witnessSecret || !(await verifyOpeningWitness(scope, witness, witnessSecret)))
      )
        throw new Error('Independent pharmacist approval required.');
      const heldLines = new Set<string>();
      const session = await createOpeningSession(db, scope, { openingAt: at });
      for (const d of rows) {
        if (d.reason) continue;
        const batchNumber = d.held ? null : d.row.Batch;
        const expiresAt = d.expiry && expiryInstant(d.expiry, 'DAY');
        const known =
          batchNumber &&
          (await db.pharmacyManufacturingBatch.findFirst({
            where: { organizationId: scope.organizationId, medicineId: d.medicineId!, batchNumber },
          }));
        if (
          known &&
          (known.expiresAt?.getTime() !== expiresAt?.getTime() || known.state !== 'ACTIVE')
        )
          throw new Error('Review existing batch before posting.');
        const batch =
          known ||
          (await db.pharmacyManufacturingBatch.create({
            data: {
              organizationId: scope.organizationId,
              medicineId: d.medicineId!,
              batchNumber,
              expiresAt,
              state: d.held ? 'QUARANTINED' : 'ACTIVE',
              stateChangedAt: d.held ? new Date() : null,
              stateReason: d.held
                ? 'Unverified batch from Abuzar. Correct at first stock count.'
                : null,
            },
          }));
        const { line } = await draftLine(db, scope, {
          sessionId: session.id,
          sourceRef: 'abuzar:' + d.rowHash,
          manufacturingBatchId: batch.id,
          batchNumber,
          expiryDate: d.expiry,
          expiryPrecision: d.expiry ? 'DAY' : null,
          printedMrpMinor: Number(d.mrp),
          unitCostMinor: Number(d.cost),
          stockLocationId: options.stockLocationId!,
          packLevelId: d.packId!,
          unitsPerPack: d.units!,
          expectedUnits: Number(d.row.Quantity),
          countedUnits: Number(d.row.Quantity),
        });
        if (d.held) heldLines.add(line.id);
        await db.$executeRaw`INSERT INTO pharmacy_abuzar_openings ("organizationId","branchId","sourceBranch",step,"sourceId","rowHash","openingLineId","unverifiedBatch") VALUES (${scope.organizationId},${scope.branchId},${options.sourceBranch},'stock',${d.row.RowID},${d.rowHash},${line.id},${d.held})`;
      }
      const { total } = await postOpeningSession(db, scope, {
        sessionId: session.id,
        idempotencyKeyPrefix: session.id,
        quarantinedLineIds: heldLines,
      });
      if (needsWitness && witness) await appendOpeningRegister(db, scope, session.id, witness);
      if (total.totalValueMinor > BigInt(0))
        await postOpeningStockEntry(db, scope, { sessionId: session.id, at });
    },
  };
}
