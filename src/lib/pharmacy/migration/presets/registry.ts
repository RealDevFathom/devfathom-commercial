import {
  mapHeadersBySynonym,
  normalizeHeader,
  type ColumnMapping,
  type PresetTargetField,
} from './synonyms';

export {
  HEADER_SYNONYMS,
  lookupHeaderSynonym,
  mapHeadersBySynonym,
  normalizeHeader,
} from './synonyms';
export type { ColumnMapping, PresetTargetField } from './synonyms';
export { parseMappedRow, parseTallyXml } from './parsers';

export type PresetStatus = 'VERIFIED' | 'PROVISIONAL';
export type ApplyPresetOptions = Readonly<{ provisionalMappingReviewed?: boolean }>;
export const PROVISIONAL_NOTE =
  'built from inferred columns; to be finalised from real sample exports';
export type PresetDescriptor = Readonly<{
  id: string;
  name: string;
  status: PresetStatus;
  note?: string;
  forceMappingReview: boolean;
}>;
type Definition = PresetDescriptor & {
  fingerprints: readonly string[];
  overrides?: Readonly<Record<string, PresetTargetField>>;
};

const provisional = (id: string, name: string, fingerprints: readonly string[]): Definition => ({
  id,
  name,
  fingerprints,
  status: 'PROVISIONAL',
  note: PROVISIONAL_NOTE,
  forceMappingReview: true,
});

// Ordering is a public product decision. Detection uses score first and this order to break ties.
const DEFINITIONS: readonly Definition[] = [
  {
    id: 'generic-register',
    name: 'Generic Excel/CSV mapper',
    status: 'VERIFIED',
    forceMappingReview: false,
    fingerprints: [],
  },
  {
    id: 'medipos',
    name: 'MediPOS',
    status: 'VERIFIED',
    forceMappingReview: false,
    fingerprints: [
      'name',
      'generic',
      'sku',
      'base_unit',
      'pack_size',
      'opening_qty',
      'batch_no',
      'expiry',
      'unit_cost',
    ],
  },
  {
    id: 'tally-excel',
    name: 'Tally Excel',
    status: 'VERIFIED',
    forceMappingReview: false,
    fingerprints: [
      'item-name',
      'conversion factor for base units',
      'maintain in batches',
      'batch',
      'expiry date',
      'opening qty',
    ],
  },
  {
    id: 'tally-xml',
    name: 'Tally XML',
    status: 'VERIFIED',
    forceMappingReview: false,
    fingerprints: ['stockitem', 'batchname', 'expiryperiod', 'baseunits'],
  },
  provisional('marg-erp', 'Marg ERP batch stock', [
    'item name',
    'company',
    'batch',
    'expiry',
    'mrp',
    'qty',
  ]),
  provisional('busy', 'Busy', ['item name', 'alias', 'group', 'unit', 'hsn', 'opening stock']),
  provisional('local-pk', 'Local PK vendors (Abuzar, PharmaSys, Mint, Moneypex)', [
    'medicine name',
    'generic',
    'company',
    'packing',
    'batch no',
    'expiry',
    'tp',
    'stock',
  ]),
  {
    id: 'quickbooks-products',
    name: 'QuickBooks Online products',
    status: 'VERIFIED',
    forceMappingReview: false,
    fingerprints: [
      'product/service',
      'type',
      'memo/description',
      'purchase price',
      'sales price',
      'quantity on hand',
    ],
  },
  {
    id: 'quickbooks-customers',
    name: 'QuickBooks Online customers',
    status: 'VERIFIED',
    forceMappingReview: false,
    fingerprints: ['customer', 'customer full name', 'email', 'phone', 'bill street'],
  },
  {
    id: 'quickbooks-suppliers',
    name: 'QuickBooks Online suppliers',
    status: 'VERIFIED',
    forceMappingReview: false,
    fingerprints: ['supplier', 'company', 'email', 'phone', 'bill street'],
  },
];

export function listPresets(): readonly PresetDescriptor[] {
  return DEFINITIONS.map(({ fingerprints: _fingerprints, overrides: _overrides, ...descriptor }) =>
    Object.freeze(descriptor)
  );
}

export function detectPreset(headers: string[]): { presetId: string; confidence: number } {
  const available = new Set(headers.map(normalizeHeader));
  let winner = DEFINITIONS[0]!;
  let confidence = 0;
  for (const preset of DEFINITIONS.slice(1)) {
    const hits = preset.fingerprints.filter((header) =>
      available.has(normalizeHeader(header))
    ).length;
    const score = preset.fingerprints.length === 0 ? 0 : hits / preset.fingerprints.length;
    if (score > confidence) {
      winner = preset;
      confidence = score;
    }
  }
  // Generic is useful even with one known column, but low evidence must not claim a vendor.
  if (confidence < 0.5)
    return { presetId: 'generic-register', confidence: headers.length === 0 ? 0 : 0.25 };
  return { presetId: winner.id, confidence: Number(confidence.toFixed(3)) };
}

export function applyPreset(
  presetId: string,
  headers: string[],
  options: ApplyPresetOptions = {}
): ColumnMapping {
  const preset = DEFINITIONS.find(({ id }) => id === presetId);
  if (!preset) throw new RangeError(`Unknown pharmacy migration preset: ${presetId}`);
  if (preset.forceMappingReview && options.provisionalMappingReviewed !== true) {
    throw new Error(`Provisional pharmacy migration preset requires mapping review: ${presetId}`);
  }
  const mapping = { ...mapHeadersBySynonym(headers) } as Record<string, PresetTargetField>;
  for (const header of headers) {
    const override = preset.overrides?.[normalizeHeader(header)];
    if (override) mapping[header] = override;
  }
  return Object.freeze(mapping);
}
