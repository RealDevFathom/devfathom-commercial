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

export class ManualFileConnector implements MedicineReferenceConnector<ManualFileInput> {
  readonly id = 'manual-file';
  readonly label = 'Manual CSV / Excel';
  readonly sourceType = 'IMPORT' as const;
  readonly enabled = true;
  readonly rights = MANUAL_FILE_RIGHTS;

  async fetch(input: ManualFileInput): Promise<MedicineReferenceFetchResult> {
    const fetchedAt = input.retrievedAt ?? new Date().toISOString();
    const rows = input.rows.map((sourceRow, index) => {
      const fallbackKey = `row-${index + 2}`;
      const rowSourceKey = cell(sourceRow, input.mapping.rowSourceKey) ?? fallbackKey;
      const targetMedicineId = cell(sourceRow, input.mapping.targetMedicineId);
      const values: Partial<Record<MedicineReferenceField, string>> = {};
      const assertions: MedicineReferenceAssertion[] = [];

      for (const field of MEDICINE_REFERENCE_FIELDS) {
        const value = cell(sourceRow, input.mapping[field]);
        if (!value) continue;
        values[field] = value;
        assertions.push({
          field,
          value,
          source: input.fileName,
          sourceType: this.sourceType,
          retrievedAt: fetchedAt,
          batchId: input.batchId,
          rowSourceKey,
          rights: this.rights,
        });
      }

      const blockingIssues: NormalizedMedicineReferenceRow['blockingIssues'] = [];
      if (!values.productName) blockingIssues.push('MISSING_PRODUCT_NAME');
      if (!values.strength) blockingIssues.push('MISSING_STRENGTH');
      if (!values.dosageForm) blockingIssues.push('MISSING_DOSAGE_FORM');
      if (!values.pack) blockingIssues.push('MISSING_PACK');
      for (const field of ['rx', 'restricted', 'controlled'] as const) {
        const value = values[field]?.toLowerCase();
        if (value && !['true', 'false'].includes(value)) {
          blockingIssues.push('INVALID_SCHEDULE_CLASSIFICATION');
          break;
        }
      }

      return {
        batchId: input.batchId,
        rowSourceKey,
        ...(targetMedicineId ? { targetMedicineId } : {}),
        values,
        assertions,
        blockingIssues,
      };
    });

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
