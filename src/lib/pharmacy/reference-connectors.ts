import { csvSafeText } from '@/lib/csv';

export const MEDICINE_REFERENCE_FIELDS = [
  'productName',
  'brandName',
  'manufacturer',
  'drapRegistrationNumber',
  'strength',
  'dosageForm',
  'pack',
  'barcode',
  'alias',
  'rx',
  'restricted',
  'controlled',
] as const;

export type MedicineReferenceField = (typeof MEDICINE_REFERENCE_FIELDS)[number];
export type MedicineReferenceSourceType =
  'REGULATOR' | 'MANUFACTURER' | 'SCRAPED' | 'USER' | 'IMPORT';

export interface ConnectorRights {
  acquisition: string;
  cache: string;
  redistribution: string;
  deletion: string;
}

export const MANUAL_FILE_RIGHTS: ConnectorRights = {
  acquisition: 'Uploaded by an authorized workspace administrator',
  cache: 'Tenant-controlled operational cache',
  redistribution: 'Not permitted outside the tenant workspace',
  deletion: 'Subject to tenant retention and legal-hold policy',
};

export interface MedicineReferenceAssertion {
  field: MedicineReferenceField;
  value: string;
  source: string;
  sourceType: MedicineReferenceSourceType;
  retrievedAt: string;
  confidence?: number;
  batchId: string;
  rowSourceKey: string;
  rights: ConnectorRights;
}

export interface NormalizedMedicineReferenceRow {
  batchId: string;
  rowSourceKey: string;
  targetMedicineId?: string;
  values: Partial<Record<MedicineReferenceField, string>>;
  assertions: MedicineReferenceAssertion[];
  blockingIssues: Array<
    | 'MISSING_PRODUCT_NAME'
    | 'MISSING_STRENGTH'
    | 'MISSING_DOSAGE_FORM'
    | 'MISSING_PACK'
    | 'INVALID_SCHEDULE_CLASSIFICATION'
  >;
}

export type ConnectorSchedule =
  { kind: 'MANUAL' } | { kind: 'EXPLICIT_CALL'; expression: string; timezone: string };

export interface MedicineReferenceConnectorState {
  identity: { id: string; label: string };
  schedule: ConnectorSchedule;
  lastRunState: 'NEVER' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  cursor: { inputDigest: string; offset: number } | null;
}

export interface MedicineReferenceFetchResult {
  connectorId: string;
  batchId: string;
  fetchedAt: string;
  rows: NormalizedMedicineReferenceRow[];
}

export interface MedicineReferenceConnector<TInput = unknown> {
  readonly id: string;
  readonly label: string;
  readonly sourceType: MedicineReferenceSourceType;
  readonly rights: ConnectorRights;
  readonly enabled: boolean;
  fetch(input: TInput, cursor?: number): Promise<MedicineReferenceFetchResult>;
}

export type ManualMappingTemplate = Partial<
  Record<MedicineReferenceField | 'rowSourceKey' | 'targetMedicineId', string>
>;

export interface ManualFileInput {
  batchId: string;
  fileName: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  mapping: ManualMappingTemplate;
  retrievedAt?: string;
}

function cell(row: Record<string, unknown>, column: string | undefined): string | undefined {
  if (!column) return undefined;
  const raw = row[column];
  if (raw === null || raw === undefined) return undefined;
  const value = String(raw).trim();
  return value.length ? value : undefined;
}

type ScheduleFlagField = 'rx' | 'restricted' | 'controlled';
const SCHEDULE_FLAG_FIELDS: readonly ScheduleFlagField[] = ['rx', 'restricted', 'controlled'];

interface NormalizeOptions {
  sourceType: MedicineReferenceSourceType;
  rights: ConnectorRights;
  /** Returns the canonical value, or `null` when the source value cannot be trusted. */
  scheduleFlag: (field: ScheduleFlagField, value: string) => string | null;
  fallbackRowSourceKey: (values: Partial<Record<MedicineReferenceField, string>>) => string | null;
}

function normalizeReferenceRows(
  input: ManualFileInput,
  options: NormalizeOptions
): MedicineReferenceFetchResult['rows'] {
  const fetchedAt = input.retrievedAt ?? new Date().toISOString();
  return input.rows.map((sourceRow, index) => {
    const targetMedicineId = cell(sourceRow, input.mapping.targetMedicineId);
    const values: Partial<Record<MedicineReferenceField, string>> = {};
    let invalidSchedule = false;

    for (const field of MEDICINE_REFERENCE_FIELDS) {
      const raw = cell(sourceRow, input.mapping[field]);
      if (!raw) continue;
      if ((SCHEDULE_FLAG_FIELDS as readonly string[]).includes(field)) {
        const flag = options.scheduleFlag(field as ScheduleFlagField, raw);
        if (flag === null) {
          invalidSchedule = true;
          values[field] = raw;
          continue;
        }
        values[field] = flag;
      } else values[field] = raw;
    }

    const rowSourceKey =
      cell(sourceRow, input.mapping.rowSourceKey) ??
      options.fallbackRowSourceKey(values) ??
      `row-${index + 2}`;
    const assertions: MedicineReferenceAssertion[] = Object.entries(values).map(
      ([field, value]) => ({
        field: field as MedicineReferenceField,
        value,
        source: input.fileName,
        sourceType: options.sourceType,
        retrievedAt: fetchedAt,
        batchId: input.batchId,
        rowSourceKey,
        rights: options.rights,
      })
    );

    const blockingIssues: NormalizedMedicineReferenceRow['blockingIssues'] = [];
    if (!values.productName) blockingIssues.push('MISSING_PRODUCT_NAME');
    // DEV-852: legacy imports carry no strength; it is stored as not recorded, not blocked.
    if (!values.strength && options.sourceType !== 'IMPORT')
      blockingIssues.push('MISSING_STRENGTH');
    if (!values.dosageForm) blockingIssues.push('MISSING_DOSAGE_FORM');
    if (!values.pack) blockingIssues.push('MISSING_PACK');
    if (invalidSchedule) blockingIssues.push('INVALID_SCHEDULE_CLASSIFICATION');

    return {
      batchId: input.batchId,
      rowSourceKey,
      ...(targetMedicineId ? { targetMedicineId } : {}),
      values,
      assertions,
      blockingIssues,
    };
  });
}

export class ManualFileConnector implements MedicineReferenceConnector<ManualFileInput> {
  readonly id = 'manual-file';
  readonly label = 'Manual CSV / Excel';
  readonly sourceType = 'IMPORT' as const;
  readonly enabled = true;
  readonly rights = MANUAL_FILE_RIGHTS;

  async fetch(input: ManualFileInput): Promise<MedicineReferenceFetchResult> {
    const fetchedAt = input.retrievedAt ?? new Date().toISOString();
    const rows = normalizeReferenceRows(
      { ...input, retrievedAt: fetchedAt },
      {
        sourceType: this.sourceType,
        rights: this.rights,
        scheduleFlag: (_field, value) =>
          ['true', 'false'].includes(value.toLowerCase()) ? value : null,
        fallbackRowSourceKey: () => null,
      }
    );
    return { connectorId: this.id, batchId: input.batchId, fetchedAt, rows };
  }
}

/** Connector key for an official DRAP registered-products export uploaded by an administrator. */
export const DRAP_REGISTRY_CONNECTOR_ID = 'drap-registry';
export const DRAP_REGISTRY_LABEL = 'DRAP registry file';

export const DRAP_REGISTRY_RIGHTS: ConnectorRights = {
  acquisition:
    'Official DRAP registered-product data uploaded by an authorized workspace administrator',
  cache: 'Tenant-controlled operational cache',
  redistribution: 'Not permitted outside the tenant workspace',
  deletion: 'Subject to tenant retention and legal-hold policy',
};

/** Header aliases found in DRAP registered-product exports, most specific first. */
const DRAP_COLUMN_ALIASES: Record<MedicineReferenceField | 'rowSourceKey', readonly string[]> = {
  drapRegistrationNumber: [
    'drapregistrationnumber',
    'registrationnumber',
    'registrationno',
    'regno',
    'registration',
  ],
  productName: ['productname', 'brandname', 'medicinename', 'drugname', 'product', 'name'],
  brandName: ['brandname', 'brand'],
  manufacturer: ['manufacturer', 'manufacturername', 'company', 'companyname', 'firm'],
  strength: ['strength', 'potency'],
  dosageForm: ['dosageform', 'form', 'dosage'],
  pack: ['packsize', 'pack', 'packing', 'presentation'],
  barcode: ['barcode', 'gtin'],
  alias: ['genericname', 'generic', 'composition', 'formulation', 'molecule', 'salt'],
  rx: ['prescriptionstatus', 'prescriptiononly', 'prescription', 'legalstatus', 'rx'],
  restricted: ['restricted'],
  controlled: ['controlledstatus', 'controlleddrug', 'controlled'],
  rowSourceKey: [],
};

/** Maps DRAP export headers to reference fields without manual column picking. */
export function drapRegistryMapping(headers: readonly string[]): ManualMappingTemplate {
  const normalized = headers.map((header) => header.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const mapping: ManualMappingTemplate = {};
  for (const [field, candidates] of Object.entries(DRAP_COLUMN_ALIASES)) {
    for (const candidate of candidates) {
      const index = normalized.indexOf(candidate);
      if (index >= 0) {
        mapping[field as keyof ManualMappingTemplate] = headers[index]!;
        break;
      }
    }
  }
  return mapping;
}

const TRUE_WORDS = ['true', 'yes', 'y', '1'];
const FALSE_WORDS = ['false', 'no', 'n', '0'];

/**
 * Reads a DRAP schedule flag. Only explicit official wording is accepted; anything else blocks
 * the row so a guessed Rx or controlled flag never reaches review as a value.
 */
export function drapScheduleFlag(field: ScheduleFlagField, raw: string): 'true' | 'false' | null {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
  if (TRUE_WORDS.includes(value)) return 'true';
  if (FALSE_WORDS.includes(value)) return 'false';
  if (field === 'rx') {
    if (['rx', 'prescription', 'prescription only', 'pom', 'prescription required'].includes(value))
      return 'true';
    if (['otc', 'over the counter', 'non prescription'].includes(value)) return 'false';
  }
  if (field === 'controlled') {
    if (['controlled', 'narcotic', 'psychotropic'].includes(value)) return 'true';
    if (['not controlled', 'non controlled'].includes(value)) return 'false';
  }
  return null;
}

export class DrapRegistryFileConnector implements MedicineReferenceConnector<ManualFileInput> {
  readonly id = DRAP_REGISTRY_CONNECTOR_ID;
  readonly label = DRAP_REGISTRY_LABEL;
  readonly sourceType = 'REGULATOR' as const;
  readonly enabled = true;
  readonly rights = DRAP_REGISTRY_RIGHTS;

  async fetch(input: ManualFileInput): Promise<MedicineReferenceFetchResult> {
    const fetchedAt = input.retrievedAt ?? new Date().toISOString();
    const rows = normalizeReferenceRows(
      { ...input, retrievedAt: fetchedAt },
      {
        sourceType: this.sourceType,
        rights: this.rights,
        scheduleFlag: drapScheduleFlag,
        // The registration number identifies a DRAP row across repeated exports.
        fallbackRowSourceKey: (values) =>
          values.drapRegistrationNumber ? `drap-${values.drapRegistrationNumber}` : null,
      }
    );
    return { connectorId: this.id, batchId: input.batchId, fetchedAt, rows };
  }
}

export function formulaSafeCell(value: unknown): string {
  return csvSafeText(value);
}

/** Rows accepted by one `runReferenceConnectorNow` request. Shared with the server schema. */
export const REFERENCE_BATCH_MAX_ROWS = 500;
/** Rows accepted from one uploaded reference file before it is split into batches. */
export const REFERENCE_FILE_MAX_ROWS = 20_000;

export interface ReferenceUploadChunk {
  batchId: string;
  part: number;
  rows: NormalizedMedicineReferenceRow[];
}

export function referenceFileRowLimitMessage(rowCount: number): string | null {
  return rowCount > REFERENCE_FILE_MAX_ROWS
    ? `This file has ${rowCount.toLocaleString('en-US')} rows. A reference file is limited to ${REFERENCE_FILE_MAX_ROWS.toLocaleString('en-US')} rows; split it into smaller files and upload each one.`
    : null;
}

/**
 * Splits rows normalized from one file into server-sized batches. A single-batch file keeps its
 * batch ID; larger files get `<fileBatchId>-pNN` per part. Row source keys are left untouched so
 * a retried part produces the same server input digest and replays as a no-op.
 */
export function chunkReferenceRows(
  fileBatchId: string,
  rows: ReadonlyArray<NormalizedMedicineReferenceRow>,
  size: number = REFERENCE_BATCH_MAX_ROWS
): ReferenceUploadChunk[] {
  const limitMessage = referenceFileRowLimitMessage(rows.length);
  if (limitMessage) throw new Error(limitMessage);
  const total = Math.ceil(rows.length / size);
  const digits = Math.max(2, String(total).length);
  return Array.from({ length: total }, (_, index) => {
    const batchId =
      total === 1 ? fileBatchId : `${fileBatchId}-p${String(index + 1).padStart(digits, '0')}`;
    return {
      batchId,
      part: index + 1,
      rows: rows.slice(index * size, (index + 1) * size).map((row) => ({
        ...row,
        batchId,
        assertions: row.assertions.map((assertion) => ({ ...assertion, batchId })),
      })),
    };
  });
}
