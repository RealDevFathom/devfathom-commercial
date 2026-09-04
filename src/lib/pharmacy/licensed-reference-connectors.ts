import 'server-only';

import { z } from 'zod';

import type {
  ConnectorRights,
  MedicineReferenceConnector,
  MedicineReferenceFetchResult,
} from './reference-connectors';

const MAX_LICENSED_ROWS = 500;
const licensedField = z.enum([
  'productName',
  'brandName',
  'manufacturer',
  'drapRegistrationNumber',
  'strength',
  'dosageForm',
  'pack',
  'barcode',
  'alias',
]);
const licensedRow = z
  .object({
    rowSourceKey: z.string().trim().min(1).max(300),
    values: z.partialRecord(licensedField, z.string().trim().min(1).max(1_000)),
  })
  .strict();
const licensedFeed = z
  .object({
    batchId: z.string().trim().min(1).max(150),
    rows: z.array(licensedRow).max(MAX_LICENSED_ROWS),
  })
  .strict();

type LicensedFeedConfig = {
  endpoint?: string;
  token?: string;
  rightsReference?: string;
};

abstract class LicensedJsonFeedConnector implements MedicineReferenceConnector<void> {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly sourceType: 'REGULATOR' | 'MANUFACTURER';
  abstract readonly rights: ConnectorRights;

  constructor(protected readonly config: LicensedFeedConfig = {}) {}

  get enabled() {
    return Boolean(this.config.endpoint && this.config.token && this.config.rightsReference);
  }

  async fetch(): Promise<MedicineReferenceFetchResult> {
    if (!this.enabled)
      throw new Error(`${this.label} is disabled until feed and rights configuration is complete.`);
    const response = await fetch(this.config.endpoint!, {
      headers: { Authorization: `Bearer ${this.config.token}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${this.label} returned HTTP ${response.status}.`);
    const body = licensedFeed.parse(await response.json());
    const fetchedAt = new Date().toISOString();
    const batchId = `${this.id}:${body.batchId}`;
    return {
      connectorId: this.id,
      batchId,
      fetchedAt,
      rows: body.rows.map((row) => {
        const values = Object.fromEntries(
          Object.entries(row.values).map(([field, value]) => [field, value.trim()])
        );
        const blockingIssues = [
          ...(!values.productName ? (['MISSING_PRODUCT_NAME'] as const) : []),
          ...(!values.strength ? (['MISSING_STRENGTH'] as const) : []),
          ...(!values.dosageForm ? (['MISSING_DOSAGE_FORM'] as const) : []),
          ...(!values.pack ? (['MISSING_PACK'] as const) : []),
        ];
        return {
          batchId,
          rowSourceKey: row.rowSourceKey,
          values,
          blockingIssues,
          assertions: Object.entries(values).map(([field, value]) => ({
            field: licensedField.parse(field),
            value,
            source: this.label,
            sourceType: this.sourceType,
            retrievedAt: fetchedAt,
            batchId,
            rowSourceKey: row.rowSourceKey,
            rights: this.rights,
          })),
        };
      }),
    };
  }
}

export class DrapReferenceConnector extends LicensedJsonFeedConnector {
  readonly id = 'drap';
  readonly label = 'DRAP licensed feed';
  readonly sourceType = 'REGULATOR' as const;
  readonly rights: ConnectorRights = {
    acquisition: this.config.rightsReference ?? 'Configuration required',
    cache: 'Per DRAP licence terms',
    redistribution: 'Per DRAP licence terms',
    deletion: 'Per DRAP licence and tenant retention policy',
  };
}

export class CommercialMedicineConnector extends LicensedJsonFeedConnector {
  readonly id = 'commercial-catalog';
  readonly label = 'Authorized commercial catalog';
  readonly sourceType = 'MANUFACTURER' as const;
  readonly rights: ConnectorRights = {
    acquisition: this.config.rightsReference ?? 'Configuration required',
    cache: 'Per commercial licence terms',
    redistribution: 'Not permitted unless explicitly licensed',
    deletion: 'Per commercial licence and tenant retention policy',
  };
}

export function medicineConnectorHealth() {
  const connectors = [
    new DrapReferenceConnector({
      endpoint: process.env.DRAP_MEDICINE_FEED_URL,
      token: process.env.DRAP_MEDICINE_FEED_TOKEN,
      rightsReference: process.env.DRAP_MEDICINE_RIGHTS_REFERENCE,
    }),
    new CommercialMedicineConnector({
      endpoint: process.env.COMMERCIAL_MEDICINE_FEED_URL,
      token: process.env.COMMERCIAL_MEDICINE_FEED_TOKEN,
      rightsReference: process.env.COMMERCIAL_MEDICINE_RIGHTS_REFERENCE,
    }),
  ];
  return [
    {
      id: 'manual-file',
      label: 'Manual CSV / Excel',
      enabled: true,
      status: 'READY' as const,
      detail: 'Tenant upload; review required before publication',
    },
    ...connectors.map((connector) => ({
      id: connector.id,
      label: connector.label,
      enabled: connector.enabled,
      status: connector.enabled ? ('READY' as const) : ('DISABLED' as const),
      detail: connector.enabled
        ? 'Licensed configuration present'
        : 'Feed or rights configuration absent',
    })),
  ];
}
