/**
 * DEV-957 phase 2 (review B2): offline sales a counter took and never sent are NEVER
 * deleted, by a revoke, a "Remove from this computer", a wipe or a sign-out.
 *
 * When a counter is revoked (or removed from this computer) its offline queue stops for
 * good: its price lists, receipt blocks, stock and unfinished bills are dropped and it
 * can never sell again. Its unsent sales are moved, exactly as they were taken (seal
 * included), into a READ-ONLY record of their own next to the counter's document, listed
 * in a small index. The counter page shows them under "Sales to reconcile"; a manager
 * can export them and record what was done with each one (audited on the server). A sale
 * leaves the record only once a manager has recorded it, or the server already holds it.
 *
 * Nothing here can sell, edit or send a sale: there is no transition that changes one.
 * The record passes the local store's forbidden-field guard like every other document.
 */
import {
  assertPersistSafe,
  terminalScopeKey,
  type TerminalScope,
  type TerminalStorageDriver,
} from '@/lib/retail-terminal/local-store';

import type { ArchivedSnapshotPayload, CounterQueuedCommand } from './counter-command-queue';

/** Where the list of reconcile records lives, in the counter's own store. */
export const COUNTER_RECONCILE_INDEX_KEY = 'pharmacy-counter-reconcile-index';
const RECORD_KIND = 'pharmacy-counter-reconcile';
const RECORD_VERSION = 1;

export type CounterRetiredReason = 'REVOKED' | 'REMOVED';

export type CounterReconcileRecord = {
  kind: typeof RECORD_KIND;
  version: typeof RECORD_VERSION;
  scope: TerminalScope;
  counterName: string | null;
  retiredAt: string;
  reason: CounterRetiredReason;
  /** The unsent sales, oldest first, unchanged. */
  sales: CounterQueuedCommand[];
  /** The price lists those sales were priced from (one copy each). */
  snapshotArchive: ArchivedSnapshotPayload[];
};

export type CounterReconcileIndexEntry = {
  recordKey: string;
  organizationId: string;
  branchId: string;
  deviceId: string;
  counterName: string | null;
  retiredAt: string;
};

export function reconcileRecordKey(scope: TerminalScope): string {
  return `${terminalScopeKey(scope)}::reconcile`;
}

function isIndexEntry(value: unknown): value is CounterReconcileIndexEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.recordKey === 'string' &&
    typeof entry.organizationId === 'string' &&
    typeof entry.branchId === 'string' &&
    typeof entry.deviceId === 'string' &&
    (entry.counterName === null || typeof entry.counterName === 'string') &&
    typeof entry.retiredAt === 'string'
  );
}

export async function readReconcileIndex(
  driver: TerminalStorageDriver
): Promise<CounterReconcileIndexEntry[]> {
  const raw = await driver.read(COUNTER_RECONCILE_INDEX_KEY);
  const entries = raw && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : null;
  return Array.isArray(entries) ? entries.filter(isIndexEntry) : [];
}

async function writeReconcileIndex(
  driver: TerminalStorageDriver,
  entries: CounterReconcileIndexEntry[]
): Promise<void> {
  const document = { kind: 'pharmacy-counter-reconcile-index', entries };
  assertPersistSafe(document);
  await driver.write(COUNTER_RECONCILE_INDEX_KEY, document);
}

function isRecord(value: unknown, key: string): value is CounterReconcileRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CounterReconcileRecord>;
  return (
    record.kind === RECORD_KIND &&
    record.version === RECORD_VERSION &&
    !!record.scope &&
    reconcileRecordKey(record.scope) === key &&
    Array.isArray(record.sales) &&
    Array.isArray(record.snapshotArchive)
  );
}

export async function readReconcileRecord(
  driver: TerminalStorageDriver,
  recordKey: string
): Promise<CounterReconcileRecord | null> {
  const raw = await driver.read(recordKey);
  return isRecord(raw, recordKey) ? raw : null;
}

/**
 * Keep these unsent sales, read-only, for a manager. Sales already held for the same
 * counter are kept too (a counter is retired once; a second call only adds). The record
 * is written before the index, so a failure part-way never loses a sale: at worst the
 * record exists without its index entry, and the caller does not purge.
 */
export async function keepUnsentSales(
  driver: TerminalStorageDriver,
  input: {
    scope: TerminalScope;
    counterName: string | null;
    reason: CounterRetiredReason;
    retiredAt: string;
    sales: readonly CounterQueuedCommand[];
    snapshotArchive: readonly ArchivedSnapshotPayload[];
  }
): Promise<void> {
  const key = reconcileRecordKey(input.scope);
  const held = await readReconcileRecord(driver, key);
  const known = new Set((held?.sales ?? []).map((sale) => sale.commandId));
  const sales = [...(held?.sales ?? []), ...input.sales.filter((sale) => !known.has(sale.commandId))]
    .sort((a, b) => a.sequence - b.sequence);
  const archive = [...(held?.snapshotArchive ?? [])];
  for (const entry of input.snapshotArchive)
    if (!archive.some((kept) => kept.payloadHash === entry.payloadHash)) archive.push(entry);
  const record: CounterReconcileRecord = {
    kind: RECORD_KIND,
    version: RECORD_VERSION,
    scope: { ...input.scope },
    counterName: held?.counterName ?? input.counterName,
    retiredAt: held?.retiredAt ?? input.retiredAt,
    reason: held?.reason ?? input.reason,
    sales,
    snapshotArchive: archive,
  };
  assertPersistSafe(record);
  await driver.write(key, record);
  const entries = (await readReconcileIndex(driver)).filter((entry) => entry.recordKey !== key);
  await writeReconcileIndex(driver, [
    ...entries,
    {
      recordKey: key,
      organizationId: input.scope.organizationId,
      branchId: input.scope.branchId,
      deviceId: input.scope.deviceId,
      counterName: record.counterName,
      retiredAt: record.retiredAt,
    },
  ]);
}

/**
 * A manager recorded what was done with this sale (or the server already holds it): it
 * leaves the record. The record and its index entry go once no sale is left.
 */
export async function settleReconciledSale(
  driver: TerminalStorageDriver,
  recordKey: string,
  commandId: string
): Promise<CounterReconcileRecord | null> {
  const record = await readReconcileRecord(driver, recordKey);
  if (!record) return null;
  const sales = record.sales.filter((sale) => sale.commandId !== commandId);
  if (sales.length === record.sales.length) return record;
  if (sales.length === 0) {
    await driver.remove(recordKey);
    await writeReconcileIndex(
      driver,
      (await readReconcileIndex(driver)).filter((entry) => entry.recordKey !== recordKey)
    );
    return null;
  }
  const needed = new Set(
    sales.flatMap((sale) =>
      (Array.isArray(sale.payload.snapshots) ? sale.payload.snapshots : []).map(
        (row) => (row as { envelope?: { payloadHash?: unknown } }).envelope?.payloadHash
      )
    )
  );
  const next: CounterReconcileRecord = {
    ...record,
    sales,
    snapshotArchive: record.snapshotArchive.filter((entry) => needed.has(entry.payloadHash)),
  };
  assertPersistSafe(next);
  await driver.write(recordKey, next);
  return next;
}

export type ReconcileSaleLine = {
  medicineName: string | null;
  medicineId: string;
  saleUnit: string;
  quantity: number;
  lineTotalMinor: number | null;
};

export type ReconcileSale = {
  recordKey: string;
  counterName: string | null;
  deviceId: string;
  commandId: string;
  sequence: number;
  receiptNumber: number | null;
  soldAt: string;
  amountMinor: number;
  cashReceivedMinor: number | null;
  cashierName: string | null;
  sealHash: string | null;
  lines: ReconcileSaleLine[];
};

function archived(record: CounterReconcileRecord, sale: CounterQueuedCommand, kind: string): unknown {
  const carried = Array.isArray(sale.payload.snapshots) ? sale.payload.snapshots : [];
  const ref = carried.find(
    (row) => (row as { envelope?: { kind?: unknown } }).envelope?.kind === kind
  ) as { envelope?: { payloadHash?: unknown }; payload?: unknown } | undefined;
  if (!ref) return null;
  if (ref.payload !== undefined) return ref.payload;
  return (
    record.snapshotArchive.find((entry) => entry.payloadHash === ref.envelope?.payloadHash)
      ?.payload ?? null
  );
}

function medicineName(catalog: unknown, medicineId: string): string | null {
  if (!Array.isArray(catalog)) return null;
  for (const row of catalog) {
    if (!row || typeof row !== 'object') continue;
    const value = row as Record<string, unknown>;
    // The signed CATALOG lists each medicine as { id, productName, presentations }.
    if (value.id === medicineId && typeof value.productName === 'string' && value.productName.trim())
      return value.productName.trim();
  }
  return null;
}

/** The record as rows a person reads (and exports). */
export function reconcileSalesOf(record: CounterReconcileRecord, recordKey: string): ReconcileSale[] {
  return record.sales.map((sale) => {
    const payload = sale.payload as Record<string, unknown>;
    const catalog = archived(record, sale, 'CATALOG');
    const rules = archived(record, sale, 'RULES') as { operator?: { name?: unknown } } | null;
    const seal = payload.seal as { lineTotalsMinor?: unknown } | undefined;
    const totals = Array.isArray(seal?.lineTotalsMinor) ? (seal.lineTotalsMinor as unknown[]) : [];
    const lines = Array.isArray(payload.lines) ? (payload.lines as Array<Record<string, unknown>>) : [];
    return {
      recordKey,
      counterName: record.counterName,
      deviceId: record.scope.deviceId,
      commandId: sale.commandId,
      sequence: sale.sequence,
      receiptNumber: sale.receiptNumber,
      soldAt: sale.clientOriginAt,
      amountMinor: typeof payload.amountMinor === 'number' ? payload.amountMinor : 0,
      cashReceivedMinor:
        typeof payload.cashReceivedMinor === 'number' ? payload.cashReceivedMinor : null,
      cashierName:
        typeof rules?.operator?.name === 'string' && rules.operator.name ? rules.operator.name : null,
      sealHash: sale.sealHash ?? null,
      lines: lines.map((line, index) => ({
        medicineId: String(line.medicineId ?? ''),
        medicineName: medicineName(catalog, String(line.medicineId ?? '')),
        saleUnit: String(line.saleUnit ?? ''),
        quantity: typeof line.quantity === 'number' ? line.quantity : 0,
        lineTotalMinor: typeof totals[index] === 'number' ? (totals[index] as number) : null,
      })),
    };
  });
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  // Spreadsheet formula injection: a cell never starts with =, +, - or @.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV a manager downloads: one row per line of each unsent sale. Amounts in rupees. */
export function reconcileSalesCsv(sales: readonly ReconcileSale[]): string {
  const rupees = (minor: number | null) => (minor === null ? null : (minor / 100).toFixed(2));
  const header = [
    'Counter',
    'Receipt number',
    'Sold at',
    'Cashier',
    'Bill total (Rs)',
    'Cash received (Rs)',
    'Medicine',
    'Unit',
    'Quantity',
    'Line total (Rs)',
    'Sequence',
    'Seal',
  ];
  const rows = sales.flatMap((sale) =>
    (sale.lines.length ? sale.lines : [null]).map((line) => [
      sale.counterName ?? sale.deviceId,
      sale.receiptNumber,
      sale.soldAt,
      sale.cashierName,
      rupees(sale.amountMinor),
      rupees(sale.cashReceivedMinor),
      line ? (line.medicineName ?? line.medicineId) : null,
      line?.saleUnit ?? null,
      line?.quantity ?? null,
      line ? rupees(line.lineTotalMinor) : null,
      sale.sequence,
      sale.sealHash,
    ])
  );
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}
