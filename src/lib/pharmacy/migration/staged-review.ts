/** Read-only presentation of source evidence. Never a publication decision. */
import type { Prisma } from '@/generated/prisma/client';
import { naturalKey, MIGRATION_TARGET_KEYS } from './mapping-targets';
import type { ExceptionBucket } from './profiler';

export const SOURCE_REFERENCE_COLUMNS = [
  'Name',
  'aliasname',
  'active',
  'saleprice',
  'purprice',
  'PackUnits',
  'QTY',
  'name',
  'classname',
  'Category',
  'UnitPrice',
  'PackQty',
  'StockValue',
] as const;

const QUANTITY_HEADERS = ['qty', 'quantity', 'stock', 'stockqty', 'onhand', 'balanceqty', 'closingqty'];

export function exceptionWorkflow(bucket: ExceptionBucket) {
  if (bucket === 'MISSING_BATCH' || bucket === 'MISSING_EXPIRY') return 'Opening stock';
  if (bucket === 'MISSING_MRP') return 'Verified price';
  if (bucket === 'UNIT_AMBIGUOUS') return 'Pack / unit review';
  if (bucket === 'DUPLICATE_PRODUCT') return 'Identity review';
  return 'Party / balance review';
}

export type ReviewRow = {
  id: string;
  sourceKey: string;
  rowNumber: number;
  productName: string | null;
  packLabel: string | null;
  packFactor?: bigint | null;
  quantityCanonical: bigint | null;
  rawPayload: Prisma.JsonValue;
  exceptions: { bucket: ExceptionBucket; status: string; severity: string }[];
};

export function stagedReference(
  row: ReviewRow,
  source: { id: string; contentHash: string },
  batchId: string,
  /** The batch's recorded mapping choice; null means a legacy batch that recorded none. */
  batchQuantityUnit: string | null = null
) {
  const raw =
    row.rawPayload && typeof row.rawPayload === 'object' && !Array.isArray(row.rawPayload)
      ? row.rawPayload
      : {};
  // Do not coerce numbers: a JSON number cannot prove the original decimal spelling.
  const cell = (key: string): string | null => (typeof raw[key] === 'string' ? raw[key] : null);
  const references = Object.fromEntries(
    SOURCE_REFERENCE_COLUMNS.map((key) => [key, cell(key)])
  ) as Record<(typeof SOURCE_REFERENCE_COLUMNS)[number], string | null>;
  const sourceHash = cell('__source_sha256');
  const sourceRow = cell('__source_row');
  // Only the batch is authoritative; row JSON (an uploaded column) never records a choice.
  const quantityUnit =
    batchQuantityUnit === 'PACKS' || batchQuantityUnit === 'UNITS' ? batchQuantityUnit : null;
  const quantityKey = Object.keys(raw).find((key) =>
    QUANTITY_HEADERS.includes(key.toLowerCase().replace(/[^a-z]/g, ''))
  );
  const suppliedQuantity = (quantityKey ? cell(quantityKey) : null)?.trim() ?? '';
  const canonical = row.quantityCanonical;
  const packFactor = row.packFactor;
  const quantityReview = {
    unit: quantityUnit,
    choiceLabel:
      quantityUnit === 'PACKS'
        ? 'Packs'
        : quantityUnit === 'UNITS'
          ? 'Units'
          : 'not recorded (staged as raw count)',
    // Packs are only claimed when the mapping says so and the factor is known.
    packs:
      quantityUnit === 'PACKS' && canonical !== null && packFactor
        ? (canonical / packFactor).toString()
        : null,
    units: canonical?.toString() ?? null,
    unitsPerPack: packFactor?.toString() ?? null,
    label:
      canonical === null
        ? suppliedQuantity && quantityUnit
          ? `Unresolved: "${suppliedQuantity}" ${quantityUnit === 'PACKS' ? 'packs' : 'units'} (no countable ${quantityUnit === 'PACKS' ? 'pack factor' : 'whole count'})`
          : suppliedQuantity
            ? `Unresolved: "${suppliedQuantity}" (choose packs or units)`
            : null
        : quantityUnit === null
          ? `${canonical} (staged as raw count)`
          : quantityUnit === 'PACKS' && packFactor
            ? `${canonical / packFactor} packs × ${packFactor} = ${canonical} units`
            : `${canonical} units`,
  };
  const flags = cell('__review_flags')?.split(';').filter(Boolean) ?? [];
  const lineage =
    sourceHash === null
      ? 'Unrecorded source checksum'
      : sourceHash === source.contentHash &&
          sourceRow === String(row.rowNumber) &&
          row.sourceKey === `sha256:${source.contentHash}:row:${row.rowNumber}`
        ? 'Source lineage matches'
        : 'Source lineage mismatch';
  return {
    id: row.id,
    sourceId: source.id,
    batchId,
    sourceKey: row.sourceKey,
    rowNumber: row.rowNumber,
    contentHash: source.contentHash,
    sourceHash,
    sourceRow,
    lineage,
    productName: row.productName,
    packLabel: row.packLabel,
    references,
    flags,
    normalizedNamePreview: row.productName?.trim().replace(/\s+/g, ' ') || null,
    naturalKeyPreview: row.productName
      ? naturalKey(MIGRATION_TARGET_KEYS.PRODUCT, row.productName)
      : null,
    canonicalQuantity: row.quantityCanonical?.toString() ?? null,
    quantityReview,
    status: 'Staged — unverified' as const,
    catalogueStatus: 'Identity / pack review required' as const,
    draftStatus: 'No linked draft established' as const,
    verified: false as const,
    sellable: false as const,
    collision:
      flags.includes('NORMALIZED_NAME_COLLISION_NO_MERGE') ||
      row.exceptions.some((e) => e.bucket === 'DUPLICATE_PRODUCT'),
    exceptions: row.exceptions.map((e) => ({ ...e, workflow: exceptionWorkflow(e.bucket) })),
  };
}
export type StagedReference = ReturnType<typeof stagedReference>;

/** Spreadsheet protection applies only to the derived export, never source evidence. */
export function spreadsheetCell(value: string | null): string {
  const text = value ?? '';
  const safe =
    /^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function stagedReferencesCsv(rows: readonly StagedReference[]): string {
  const header = [
    'sourceId',
    'batchId',
    'sourceKey',
    'rowNumber',
    'sourceSHA256',
    'status',
    ...SOURCE_REFERENCE_COLUMNS,
  ];
  return [
    header,
    ...rows.map((row) => [
      row.sourceId,
      row.batchId,
      row.sourceKey,
      String(row.rowNumber),
      row.contentHash,
      row.status,
      ...SOURCE_REFERENCE_COLUMNS.map((key) => row.references[key]),
    ]),
  ]
    .map((cells) => cells.map(spreadsheetCell).join(','))
    .join('\r\n');
}
