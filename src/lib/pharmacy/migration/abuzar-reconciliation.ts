import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  amountMinor,
  packUnits,
  unitMinor,
  stockReason,
  type Prepared,
} from '../../../../tools/abuzar-import/prepared';
type Snapshot = {
  products: Set<string>;
  stock: Map<string, { units: number; value: string }>;
  balances: Map<string, string>;
  balanceAccounts?: Map<string, string>;
};
export function reconciliation(data: Prepared, branch: string, snapshot: Snapshot) {
  const source = new Map(data.tables.products.map((p) => [p.ICode, p]));
  const party = new Map(data.tables.parties.map((p) => [p.RowID, p.Kind]));
  const differences: Record<string, number | string>[] = [];
  const expected = {
    products: source.size,
    stockUnits: BigInt(0),
    stockValueMinor: BigInt(0),
    customerBalanceMinor: BigInt(0),
    supplierBalanceMinor: BigInt(0),
  };
  const actual = { ...expected, products: 0 };
  data.tables.products.forEach((p, i) => {
    if (snapshot.products.has(p.ICode)) actual.products++;
    else differences.push({ table: 'products', row: i + 2, reason: 'no imported medicine' });
  });
  data.tables.stock.forEach((s, i) => {
    if (s.Branch !== branch) return;
    const p = source.get(s.ICode),
      reason = stockReason(s, p);
    const posted = snapshot.stock.get(s.RowID),
      actualUnits = BigInt(posted?.units ?? 0),
      actualValue = BigInt(posted?.value ?? 0);
    actual.stockUnits += actualUnits;
    actual.stockValueMinor += actualValue;
    if (reason) {
      differences.push({
        table: 'stock',
        row: i + 2,
        reason,
        sourceUnits: s.Quantity,
        actualUnits: String(actualUnits),
      });
      return;
    }
    const units = BigInt(Number(s.Quantity)),
      value = units * unitMinor(p!.PurPrice, packUnits(p!.PackUnits))!;
    expected.stockUnits += units;
    expected.stockValueMinor += value;
    if (!posted || units !== actualUnits || value !== actualValue)
      differences.push({
        table: 'stock',
        row: i + 2,
        expectedUnits: String(units),
        actualUnits: String(actualUnits),
        expectedValueMinor: String(value),
        actualValueMinor: String(actualValue),
      });
  });
  data.tables.balances.forEach((b, i) => {
    if (b.Branch !== branch) return;
    const value = amountMinor(b.Amount),
      posted = snapshot.balances.get(b.RowID),
      persisted = BigInt(posted ?? 0);
    const kind = party.get(b.PartyID);
    if (value === null || (kind !== 'supplier' && kind !== 'customer')) {
      differences.push({
        table: 'balances',
        row: i + 2,
        reason: 'unreadable source amount or party',
      });
      return;
    }
    const key = kind === 'supplier' ? 'supplierBalanceMinor' : 'customerBalanceMinor';
    expected[key] += value;
    actual[key] += persisted;
    if (posted === undefined || persisted !== value)
      differences.push({
        table: 'balances',
        row: i + 2,
        expectedMinor: String(value),
        actualMinor: String(persisted),
      });
  });
  for (const id of snapshot.products) {
    if (source.has(id)) continue;
    actual.products++;
    differences.push({
      table: 'products',
      sourceId: id,
      reason: 'persisted product absent from source',
    });
  }
  const sourceStock = new Set(
    data.tables.stock.filter((s) => s.Branch === branch).map((s) => s.RowID)
  );
  for (const [id, posted] of snapshot.stock) {
    if (sourceStock.has(id)) continue;
    actual.stockUnits += BigInt(posted.units);
    actual.stockValueMinor += BigInt(posted.value);
    differences.push({
      table: 'stock',
      sourceId: id,
      reason: 'persisted opening absent from source',
      actualUnits: posted.units,
      actualValueMinor: posted.value,
    });
  }
  const sourceBalances = new Set(
    data.tables.balances.filter((b) => b.Branch === branch).map((b) => b.RowID)
  );
  for (const [id, value] of snapshot.balances) {
    if (sourceBalances.has(id)) continue;
    const account = snapshot.balanceAccounts?.get(id);
    if (account === 'ACCOUNTS_PAYABLE') actual.supplierBalanceMinor += BigInt(value);
    if (account === 'ACCOUNTS_RECEIVABLE') actual.customerBalanceMinor += BigInt(value);
    differences.push({
      table: 'balances',
      sourceId: id,
      reason: 'persisted opening absent from source',
      actualMinor: value,
    });
  }
  const display = (t: typeof expected) => ({
    ...t,
    stockUnits: String(t.stockUnits),
    stockValueMinor: String(t.stockValueMinor),
    customerBalanceMinor: String(t.customerBalanceMinor),
    supplierBalanceMinor: String(t.supplierBalanceMinor),
  });
  return { expected: display(expected), actual: display(actual), differences };
}
export async function readReconciliation(
  db: ScopedDb,
  org: string,
  branchId: string,
  sourceBranch: string,
  data: Prepared
) {
  const products = await db.pharmacyStagedMedicineLink.findMany({
    where: {
      organizationId: org,
      medicineId: { not: null },
      sourceKey: { startsWith: 'abuzar-item:' },
      batch: { profilerVersion: 'abuzar/2', source: { kind: 'ABUZAR' } },
    },
    select: { sourceKey: true },
  });
  const stock = await db.$queryRaw<
    { sourceId: string; units: number; value: string }[]
  >`SELECT a."sourceId",COALESCE(m."quantityUnits",0) AS units,(COALESCE(m."quantityUnits",0)::bigint*lot."unitCostMinor")::text AS value
    FROM pharmacy_abuzar_openings a JOIN pharmacy_opening_stock_lines l ON l."organizationId"=a."organizationId" AND l.id=a."openingLineId"
    JOIN pharmacy_inventory_lots lot ON lot."organizationId"=l."organizationId" AND lot.id=l."postedLotId"
    LEFT JOIN pharmacy_stock_movements m ON m."organizationId"=l."organizationId" AND m.id=l."postedMovementId"
    WHERE a."organizationId"=${org} AND a."branchId"=${branchId} AND a."sourceBranch"=${sourceBranch}`;
  const balances = await db.$queryRaw<
    { sourceId: string; value: string; account: string }[]
  >`SELECT a."sourceId",e.account::text AS account,(CASE WHEN e.account='ACCOUNTS_PAYABLE' THEN -e."balanceMinor" ELSE e."balanceMinor" END)::text AS value
    FROM pharmacy_abuzar_openings a JOIN pharmacy_opening_ledger_entries e ON e."organizationId"=a."organizationId" AND e.id=a."ledgerEntryId"
    WHERE a."organizationId"=${org} AND a."branchId"=${branchId} AND a."sourceBranch"=${sourceBranch}`;
  return reconciliation(data, sourceBranch, {
    products: new Set(products.map((p) => p.sourceKey.slice('abuzar-item:'.length))),
    stock: new Map(stock.map((s) => [s.sourceId, s])),
    balances: new Map(balances.map((b) => [b.sourceId, b.value])),
    balanceAccounts: new Map(balances.map((b) => [b.sourceId, b.account])),
  });
}
