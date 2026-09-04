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
  values: Partial<Record<MedicineReferenceField, string>>;
  assertions: MedicineReferenceAssertion[];
  blockingIssues: Array<
    'MISSING_PRODUCT_NAME' | 'MISSING_STRENGTH' | 'MISSING_DOSAGE_FORM' | 'MISSING_PACK'
  >;
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
  fetch(input: TInput): Promise<MedicineReferenceFetchResult>;
}

export type ManualMappingTemplate = Partial<
  Record<MedicineReferenceField | 'rowSourceKey', string>
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

      return { batchId: input.batchId, rowSourceKey, values, assertions, blockingIssues };
    });

    return { connectorId: this.id, batchId: input.batchId, fetchedAt, rows };
  }
}

export function formulaSafeCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}
