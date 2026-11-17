/**
 * PH-MIG / MIG-01, MIG-02 — the source profiler contract and the single
 * exception-deriving pass every adapter shares.
 *
 * READ-ONLY BY CONSTRUCTION. A profiler receives an already-parsed `SourceTable`
 * and returns a plain result object. Nothing in this file, or in any adapter
 * implementing `SourceProfiler`, can open, write, move, or re-encode the source
 * file — MIG-01's "source never modified" is a property of the shape, not a rule
 * someone has to remember.
 *
 * NOTHING IS SILENTLY DEFAULTED. `deriveExceptions` is the only place a missing
 * or unreadable value is handled, and the only thing it can do with one is emit
 * an exception row. There is no fallback constant anywhere in this module.
 */
import { MIGRATION_TARGET_KEYS, naturalKey, type MigrationTargetKey } from './mapping-targets';
import {
  isBlank,
  readExpiryDate,
  readMoneyMinor,
  readPackFactor,
  readQuantity,
  readText,
  type SourceTable,
} from './source-values';

export type MigrationSourceKind = 'ABUZAR' | 'EXCEL_CSV' | 'TALLY_XML' | 'MARG_EXCEL';

export type ExceptionBucket =
  | 'MISSING_BATCH'
  | 'MISSING_EXPIRY'
  | 'MISSING_MRP'
  | 'UNIT_AMBIGUOUS'
  | 'DUPLICATE_PRODUCT'
  | 'PARTY_UNMATCHED'
  | 'BALANCE_MISMATCH';

export type ExceptionSeverity = 'BLOCKING' | 'WARNING';

/**
 * Severity is a property of the bucket, not of the row, so a workbench queue
 * sorts identically across sources and adapters cannot quietly downgrade their
 * own defects.
 *
 * BLOCKING means the value cannot be invented and the import cannot proceed
 * until a human supplies or waives it. PARTY_UNMATCHED is the one WARNING: an
 * unrecognised supplier is created on acceptance, which loses no money and
 * misstates no stock.
 */
export const EXCEPTION_SEVERITY: Readonly<Record<ExceptionBucket, ExceptionSeverity>> = {
  MISSING_BATCH: 'BLOCKING',
  MISSING_EXPIRY: 'BLOCKING',
  MISSING_MRP: 'BLOCKING',
  UNIT_AMBIGUOUS: 'BLOCKING',
  DUPLICATE_PRODUCT: 'BLOCKING',
  PARTY_UNMATCHED: 'WARNING',
  BALANCE_MISMATCH: 'BLOCKING',
};

/** The logical columns a profiler locates. Every one is optional in a source. */
export type SourceField =
  | 'sourceKey'
  | 'product'
  | 'pack'
  | 'barcode'
  | 'batch'
  | 'expiry'
  | 'mrp'
  | 'cost'
  | 'quantity'
  | 'supplier'
  | 'customer'
  | 'balance';

/** Logical field → zero-based index into `SourceTable.headers`. */
export type ColumnMap = Partial<Record<SourceField, number>>;

/**
 * The adapter interface. An incumbent format is implemented by supplying
 * `resolveColumns`; the derivation below is shared so that two adapters cannot
 * disagree about what "missing MRP" means.
 */
export interface SourceProfiler {
  readonly kind: MigrationSourceKind;
  /**
   * Recorded on every batch. Bump it when a column map or a parsing rule
   * changes, so a re-profile that produces different rows is attributable.
   */
  readonly version: string;
  /** `null` when this table is not the format the adapter recognises. */
  resolveColumns(table: SourceTable): ColumnMap | null;
  /**
   * Optional. For a format that legitimately lists one product once per batch
   * (Tally batch allocations, Marg Batch Stock), returns the part of a row's
   * identity BEYOND its product natural key, so two batches of one product are
   * not reported as DUPLICATE_PRODUCT. Two rows with the same natural key AND
   * the same discriminator are still duplicates. Absent means the natural key
   * alone decides, which is the original behaviour for every existing adapter.
   */
  duplicateDiscriminator?(row: ProfiledRow): string;
}

export type ProfiledRow = {
  sourceKey: string;
  rowNumber: number;
  rawPayload: Record<string, string>;
  targetModelKey: MigrationTargetKey;
  targetNaturalKey: string | null;
  productName: string | null;
  packLabel: string | null;
  packFactor: bigint | null;
  barcode: string | null;
  batchNumber: string | null;
  expiryDate: Date | null;
  mrpMinor: bigint | null;
  costMinor: bigint | null;
  quantityCanonical: bigint | null;
  supplierName: string | null;
  customerName: string | null;
  balanceMinor: bigint | null;
};

export type ProfiledException = {
  /** Index into `ProfileResult.rows`, or `null` for a batch-level exception. */
  rowIndex: number | null;
  bucket: ExceptionBucket;
  severity: ExceptionSeverity;
  detail: string;
};

export type ProfileResult = {
  columnMap: ColumnMap;
  quantityUnit: QuantityUnit | null;
  rows: ProfiledRow[];
  exceptions: ProfiledException[];
};

/**
 * Facts the receiving organization already knows, used for the two buckets that
 * cannot be decided from the source alone. Party facts are optional: absent
 * context means those buckets are not evaluated, never that they passed.
 * A missing quantity choice always leaves product quantities unresolved.
 */
export type ProfileContext = {
  /** Natural keys of parties that already exist, from `naturalKey(PARTY, …)`. */
  knownPartyKeys?: ReadonlySet<string>;
  /** Party natural key → the balance the pharmacy's own statement declares. */
  declaredPartyBalanceMinor?: ReadonlyMap<string, bigint>;
  /**
   * Column-mapping choice: what the quantity column counts. No choice leaves
   * canonical quantities null and raises UNIT_AMBIGUOUS. PACKS converts by
   * the row's pack factor. The choice is stored on the batch, never in row evidence.
   */
  quantityUnit?: QuantityUnit;
};

export type QuantityUnit = 'UNITS' | 'PACKS';

export class UnrecognisedSourceError extends Error {
  constructor(kind: MigrationSourceKind) {
    super(`The supplied table does not match the ${kind} source format.`);
    this.name = 'UnrecognisedSourceError';
  }
}

/**
 * Profile one table. Pure: same table in, same result out, no I/O.
 *
 * @throws {UnrecognisedSourceError} when the adapter does not recognise the
 * table. Refusing is the honest outcome — profiling an unrecognised sheet with a
 * partial column map would report confident nonsense.
 */
export function profileTable(
  profiler: SourceProfiler,
  table: SourceTable,
  context: ProfileContext = {}
): ProfileResult {
  const columnMap = profiler.resolveColumns(table);
  if (!columnMap) throw new UnrecognisedSourceError(profiler.kind);

  const quantityUnit =
    context.quantityUnit === 'PACKS' || context.quantityUnit === 'UNITS'
      ? context.quantityUnit
      : null;
  const rows = table.rows.map((cells, index) =>
    buildRow(table, columnMap, cells, index, quantityUnit)
  );
  const exceptions = deriveExceptions(rows, table, columnMap, context, profiler);

  return { columnMap, quantityUnit, rows, exceptions };
}

function cellAt(
  columnMap: ColumnMap,
  cells: readonly string[],
  field: SourceField
): string | undefined {
  const index = columnMap[field];
  return index === undefined ? undefined : cells[index];
}

function buildRow(
  table: SourceTable,
  columnMap: ColumnMap,
  cells: readonly string[],
  index: number,
  quantityUnit: QuantityUnit | null
): ProfiledRow {
  const rawPayload: Record<string, string> = {};
  table.headers.forEach((header, position) => {
    rawPayload[header] = cells[position] ?? '';
  });

  const productName = readText(cellAt(columnMap, cells, 'product'));
  const packLabel = readText(cellAt(columnMap, cells, 'pack'));
  const barcode = readText(cellAt(columnMap, cells, 'barcode'));
  const supplierName = readText(cellAt(columnMap, cells, 'supplier'));
  const customerName = readText(cellAt(columnMap, cells, 'customer'));
  const balanceMinor = readMoneyMinor(cellAt(columnMap, cells, 'balance'));

  // The incumbent's own row identity when it exports one; otherwise the sheet
  // position, which is stable for a given file and is what MIG-01 requires the
  // imported row to keep.
  const rowNumber = index + 1;
  const sourceKey = readText(cellAt(columnMap, cells, 'sourceKey')) ?? `row:${rowNumber}`;

  const targetModelKey = classify({
    productName,
    supplierName,
    customerName,
    balanceMinor,
    columnMap,
  });

  const packFactor = readPackFactor(cellAt(columnMap, cells, 'pack'));
  const sourceQuantity = readQuantity(cellAt(columnMap, cells, 'quantity'));
  // A pack count is only convertible with a known pack factor; never assume 1.
  const quantityCanonical =
    sourceQuantity === null || quantityUnit === null
      ? null
      : quantityUnit === 'PACKS'
        ? packFactor === null
          ? null
          : sourceQuantity * packFactor
        : sourceQuantity;

  return {
    sourceKey,
    rowNumber,
    rawPayload,
    targetModelKey,
    targetNaturalKey: deriveNaturalKey(targetModelKey, {
      productName,
      packLabel,
      barcode,
      supplierName,
      customerName,
    }),
    productName,
    packLabel,
    packFactor,
    barcode,
    batchNumber: readText(cellAt(columnMap, cells, 'batch')),
    expiryDate: readExpiryDate(cellAt(columnMap, cells, 'expiry')),
    mrpMinor: readMoneyMinor(cellAt(columnMap, cells, 'mrp')),
    costMinor: readMoneyMinor(cellAt(columnMap, cells, 'cost')),
    quantityCanonical,
    supplierName,
    customerName,
    balanceMinor,
  };
}

/**
 * Decide what a row becomes, from what it actually names.
 *
 * A row that names a product is a product row even on a sheet that also carries
 * a supplier column (a stock export names the supplier per line). A row that
 * names only a party is a party row, and one that also carries a balance is a
 * balance row. A row that names neither falls back to the sheet's own shape,
 * which is what its column map already established.
 */
function classify(input: {
  productName: string | null;
  supplierName: string | null;
  customerName: string | null;
  balanceMinor: bigint | null;
  columnMap: ColumnMap;
}): MigrationTargetKey {
  if (input.productName) return MIGRATION_TARGET_KEYS.PRODUCT;
  if (input.supplierName || input.customerName) {
    return input.balanceMinor === null
      ? MIGRATION_TARGET_KEYS.PARTY
      : MIGRATION_TARGET_KEYS.PARTY_BALANCE;
  }
  if (input.columnMap.product !== undefined) return MIGRATION_TARGET_KEYS.PRODUCT;
  if (input.columnMap.balance !== undefined) return MIGRATION_TARGET_KEYS.PARTY_BALANCE;
  return MIGRATION_TARGET_KEYS.PARTY;
}

function deriveNaturalKey(
  target: MigrationTargetKey,
  input: {
    productName: string | null;
    packLabel: string | null;
    barcode: string | null;
    supplierName: string | null;
    customerName: string | null;
  }
): string | null {
  if (target === MIGRATION_TARGET_KEYS.PRODUCT) {
    // A barcode is the incumbent's own globally unique identity; fall back to
    // name plus pack, which is the pair a pharmacist uses to tell two rows apart.
    if (input.barcode) return naturalKey(MIGRATION_TARGET_KEYS.BARCODE, input.barcode);
    if (input.productName) {
      return naturalKey(MIGRATION_TARGET_KEYS.PRODUCT, input.productName, input.packLabel ?? '');
    }
    return null;
  }

  const party = input.supplierName ?? input.customerName;
  return party ? naturalKey(MIGRATION_TARGET_KEYS.PARTY, party) : null;
}

/**
 * The single place a defect becomes an exception row.
 *
 * The batch/expiry/MRP buckets apply only to product rows: a supplier has no
 * expiry, and raising one against a party sheet would bury the real defects.
 */
function deriveExceptions(
  rows: readonly ProfiledRow[],
  table: SourceTable,
  columnMap: ColumnMap,
  context: ProfileContext,
  profiler?: Pick<SourceProfiler, 'duplicateDiscriminator'>
): ProfiledException[] {
  const exceptions: ProfiledException[] = [];
  const quantityUnit =
    context.quantityUnit === 'PACKS' || context.quantityUnit === 'UNITS'
      ? context.quantityUnit
      : null;
  const raise = (rowIndex: number | null, bucket: ExceptionBucket, detail: string) => {
    exceptions.push({ rowIndex, bucket, severity: EXCEPTION_SEVERITY[bucket], detail });
  };

  const seenProductKeys = new Map<string, ProfiledRow>();

  rows.forEach((row, index) => {
    const cells = table.rows[index] ?? [];
    const where = `source key ${row.sourceKey}`;

    if (row.targetModelKey === MIGRATION_TARGET_KEYS.PRODUCT) {
      if (!row.batchNumber) {
        raise(index, 'MISSING_BATCH', `No batch number for ${where}; it cannot be inferred.`);
      }
      if (!row.expiryDate) {
        raise(
          index,
          'MISSING_EXPIRY',
          rawOf(columnMap, cells, 'expiry')
            ? `Expiry "${rawOf(columnMap, cells, 'expiry')}" for ${where} is not a date this profiler reads.`
            : `No expiry for ${where}; it cannot be inferred.`
        );
      }
      if (row.mrpMinor === null) {
        raise(
          index,
          'MISSING_MRP',
          rawOf(columnMap, cells, 'mrp')
            ? `MRP "${rawOf(columnMap, cells, 'mrp')}" for ${where} is not an exact money amount.`
            : `No MRP for ${where}; it cannot be inferred.`
        );
      }

      const packRaw = rawOf(columnMap, cells, 'pack');
      if (packRaw && row.packFactor === null) {
        raise(index, 'UNIT_AMBIGUOUS', `Pack "${packRaw}" for ${where} names no countable unit.`);
      }
      const quantityRaw = rawOf(columnMap, cells, 'quantity');
      if ((quantityRaw || !quantityUnit) && row.quantityCanonical === null) {
        raise(
          index,
          'UNIT_AMBIGUOUS',
          !quantityUnit
            ? `Choose whether quantity counts PACKS or UNITS for ${where}.`
            : quantityUnit === 'PACKS' &&
                readQuantity(quantityRaw ?? undefined) !== null
              ? `Quantity "${quantityRaw}" packs for ${where} cannot be converted: no countable pack factor.`
              : `Quantity "${quantityRaw}" for ${where} is not a whole count of a canonical unit.`
        );
      }

      if (row.targetNaturalKey) {
        const discriminator = profiler?.duplicateDiscriminator?.(row);
        const identity =
          discriminator === undefined
            ? row.targetNaturalKey
            : `${row.targetNaturalKey}\u0000${discriminator}`;
        const previous = seenProductKeys.get(identity);
        if (previous) {
          raise(
            index,
            'DUPLICATE_PRODUCT',
            `${where} resolves to the same product as source key ${previous.sourceKey} (${row.targetNaturalKey}).`
          );
        } else {
          seenProductKeys.set(identity, row);
        }
      }
    }

    const partyName = row.supplierName ?? row.customerName;
    if (partyName && context.knownPartyKeys) {
      const key = naturalKey(MIGRATION_TARGET_KEYS.PARTY, partyName);
      if (!context.knownPartyKeys.has(key)) {
        raise(
          index,
          'PARTY_UNMATCHED',
          `Party "${partyName}" for ${where} matches no known party.`
        );
      }
    }

    if (partyName && row.balanceMinor !== null && context.declaredPartyBalanceMinor) {
      const key = naturalKey(MIGRATION_TARGET_KEYS.PARTY, partyName);
      const declared = context.declaredPartyBalanceMinor.get(key);
      if (declared !== undefined && declared !== row.balanceMinor) {
        raise(
          index,
          'BALANCE_MISMATCH',
          `Balance ${row.balanceMinor} for "${partyName}" at ${where} differs from the declared ${declared}.`
        );
      }
    }
  });

  return exceptions;
}

function rawOf(columnMap: ColumnMap, cells: readonly string[], field: SourceField): string | null {
  const raw = cellAt(columnMap, cells, field);
  return isBlank(raw) ? null : raw!.trim();
}
