import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  DRAP_REGISTRY_CONNECTOR_ID,
  DRAP_REGISTRY_RIGHTS,
  type ConnectorRights,
} from './reference-connectors';

/**
 * DEV-683: the add-medicine form pre-fills an unsaved draft from the organisation's own imported
 * DRAP reference rows. Only these fields are ever copied; a price is never read or filled, and the
 * prescription-only and controlled flags come only from the stored reference row.
 */
export const DRAP_AUTOFILL_FIELDS = [
  'productName',
  'strength',
  'dosageForm',
  'drapRegistrationNumber',
  'rx',
  'controlled',
] as const;

type TextField = 'productName' | 'strength' | 'dosageForm' | 'drapRegistrationNumber';
const TEXT_FIELDS: readonly TextField[] = [
  'productName',
  'strength',
  'dosageForm',
  'drapRegistrationNumber',
];

export interface DrapAutofillValues {
  productName?: string;
  strength?: string;
  dosageForm?: string;
  drapRegistrationNumber?: string;
  rx?: boolean;
  controlled?: boolean;
}

export interface DrapReferenceRow {
  referenceId: string;
  inputDigest: string;
  rowSourceKey: string;
  batchId: string;
  fileName: string;
  retrievedAt: Date;
  values: DrapAutofillValues;
}

export const DRAP_SEARCH_MIN_LENGTH = 2;
const DRAP_SEARCH_RESULTS = 10;
// Repeated exports store the same registration row more than once; read enough to deduplicate.
const DRAP_SEARCH_SCAN = 50;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function flag(value: unknown): boolean | undefined {
  // The upload already reduced official wording to true/false; anything else is not a value.
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Copies only the auto-fill fields from stored reference values. */
export function drapAutofillValues(values: unknown): DrapAutofillValues {
  const source = record(values);
  const picked: DrapAutofillValues = {};
  for (const field of TEXT_FIELDS) {
    const value = source[field];
    if (typeof value === 'string' && value.trim()) picked[field] = value.trim();
  }
  const rx = flag(source.rx);
  if (rx !== undefined) picked.rx = rx;
  const controlled = flag(source.controlled);
  if (controlled !== undefined) picked.controlled = controlled;
  return picked;
}

type ProposalRow = {
  id: string;
  inputDigest: string;
  rowSourceKey: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
};

function referenceRow(proposal: ProposalRow): DrapReferenceRow {
  const payload = record(proposal.payload);
  const source = record(payload.source);
  return {
    referenceId: proposal.id,
    inputDigest: proposal.inputDigest,
    rowSourceKey: proposal.rowSourceKey,
    batchId: typeof source.batchId === 'string' ? source.batchId : proposal.inputDigest,
    fileName: typeof source.fileName === 'string' ? source.fileName : 'DRAP registry file',
    retrievedAt: proposal.createdAt,
    values: drapAutofillValues(payload.values),
  };
}

const proposalSelect = {
  id: true,
  inputDigest: true,
  rowSourceKey: true,
  payload: true,
  createdAt: true,
} as const;

async function drapConnectorId(db: ScopedDb, organizationId: string) {
  const connector = await db.pharmacyReferenceConnector.findFirst({
    where: { organizationId, key: DRAP_REGISTRY_CONNECTOR_ID },
    select: { id: true },
  });
  return connector?.id ?? null;
}

/** Escapes LIKE wildcards so a search term is matched literally. */
export function literalSearchTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Searches this organisation's imported DRAP rows by product name or registration number. Only
 * pending rows not yet linked to a catalogue medicine are offered (a row a pharmacist rejected is
 * not), and rows whose registration number is already in the catalogue are marked so the form does
 * not add a duplicate.
 */
export async function searchDrapReference(
  db: ScopedDb,
  organizationId: string,
  rawQuery: string
): Promise<{
  hasReferenceData: boolean;
  matches: Array<DrapReferenceRow & { inCatalogue: boolean }>;
}> {
  const connectorId = await drapConnectorId(db, organizationId);
  if (!connectorId) return { hasReferenceData: false, matches: [] };
  const anyRow = await db.pharmacyReferenceConnectorProposal.findFirst({
    where: { organizationId, connectorId },
    select: { id: true },
  });
  if (!anyRow) return { hasReferenceData: false, matches: [] };
  const trimmed = rawQuery.trim();
  if (trimmed.length < DRAP_SEARCH_MIN_LENGTH) return { hasReferenceData: true, matches: [] };
  const query = literalSearchTerm(trimmed);

  const proposals = await db.pharmacyReferenceConnectorProposal.findMany({
    where: {
      organizationId,
      connectorId,
      status: 'PENDING',
      targetMedicineId: null,
      OR: (['productName', 'drapRegistrationNumber'] as const).map((field) => ({
        payload: {
          path: ['values', field],
          string_contains: query,
          mode: 'insensitive' as const,
        },
      })),
    },
    select: proposalSelect,
    orderBy: { createdAt: 'desc' },
    take: DRAP_SEARCH_SCAN,
  });
  const seen = new Set<string>();
  const rows: DrapReferenceRow[] = [];
  for (const proposal of proposals) {
    const row = referenceRow(proposal);
    if (!row.values.productName) continue;
    const key = row.values.drapRegistrationNumber ?? row.rowSourceKey;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    if (rows.length === DRAP_SEARCH_RESULTS) break;
  }
  const registrations = rows.flatMap((row) =>
    row.values.drapRegistrationNumber ? [row.values.drapRegistrationNumber] : []
  );
  const existing = registrations.length
    ? await db.medicine.findMany({
        where: { drapRegistrationNumber: { in: registrations } },
        select: { drapRegistrationNumber: true },
      })
    : [];
  const inCatalogue = new Set(existing.map((medicine) => medicine.drapRegistrationNumber));
  return {
    hasReferenceData: true,
    matches: rows.map((row) => ({
      ...row,
      inCatalogue: Boolean(
        row.values.drapRegistrationNumber && inCatalogue.has(row.values.drapRegistrationNumber)
      ),
    })),
  };
}

/** Loads one of this organisation's pending, unlinked DRAP reference rows, or null. */
export async function loadDrapReference(
  db: ScopedDb,
  organizationId: string,
  referenceId: string
): Promise<DrapReferenceRow | null> {
  const connectorId = await drapConnectorId(db, organizationId);
  if (!connectorId) return null;
  const proposal = await db.pharmacyReferenceConnectorProposal.findFirst({
    where: {
      id: referenceId,
      organizationId,
      connectorId,
      status: 'PENDING',
      targetMedicineId: null,
    },
    select: proposalSelect,
  });
  return proposal ? referenceRow(proposal) : null;
}

function registrationFilter(registration: string) {
  return { path: ['values', 'drapRegistrationNumber'], equals: registration };
}

/**
 * The newest DRAP row this organisation imported for a registration number, whatever its review
 * state. The server applies its stated flags to every draft carrying that number, so the lock does
 * not depend on the form having sent a reference row.
 */
export async function findDrapReferenceByRegistration(
  db: ScopedDb,
  organizationId: string,
  registration: string
): Promise<DrapReferenceRow | null> {
  const connectorId = await drapConnectorId(db, organizationId);
  if (!connectorId) return null;
  const proposal = await db.pharmacyReferenceConnectorProposal.findFirst({
    where: { organizationId, connectorId, payload: registrationFilter(registration) },
    select: proposalSelect,
    orderBy: { createdAt: 'desc' },
  });
  return proposal ? referenceRow(proposal) : null;
}

/**
 * Links the pending DRAP rows a draft was made from to that draft, so confirming one later
 * updates this medicine instead of creating a second one. The chosen row must still be pending
 * and unlinked; other pending rows for the same registration number are linked too.
 */
export async function linkDrapReferenceRows(
  db: ScopedDb,
  organizationId: string,
  input: { referenceId?: string; registration: string; medicineId: string }
): Promise<{ referenceLinked: boolean }> {
  const connectorId = await drapConnectorId(db, organizationId);
  if (!connectorId) return { referenceLinked: false };
  const pending = {
    organizationId,
    connectorId,
    status: 'PENDING' as const,
    targetMedicineId: null,
  };
  const data = { targetMedicineId: input.medicineId };
  let referenceLinked = false;
  if (input.referenceId) {
    const linked = await db.pharmacyReferenceConnectorProposal.updateMany({
      where: { ...pending, id: input.referenceId },
      data,
    });
    referenceLinked = linked.count === 1;
  }
  await db.pharmacyReferenceConnectorProposal.updateMany({
    where: { ...pending, payload: registrationFilter(input.registration) },
    data,
  });
  return { referenceLinked };
}

export const ADD_MEDICINE_FORM_SOURCE = 'add-medicine-form';
export const ADD_MEDICINE_FORM_RIGHTS: ConnectorRights = {
  acquisition: 'Entered by an authorized catalogue editor',
  cache: 'Tenant-controlled operational cache',
  redistribution: 'Not permitted outside the tenant workspace',
  deletion: 'Subject to tenant retention and legal-hold policy',
};

export interface AddMedicineDraftInput {
  productName: string;
  strength: string;
  dosageForm: string;
  pack: string;
  drapRegistrationNumber: string;
  rx: boolean;
  controlled: boolean;
}

const DRAFT_FIELDS = [
  'productName',
  'strength',
  'dosageForm',
  'pack',
  'drapRegistrationNumber',
  'rx',
  'controlled',
] as const;

/**
 * Unreviewed assertions for a confirmed draft. A value equal to the DRAP reference row is recorded
 * as regulator data with that row's provenance; anything the person typed or changed is recorded
 * as their own entry. Both wait for the independent catalogue review before publication.
 */
export function addMedicineDraftProvenance(
  input: AddMedicineDraftInput,
  reference: DrapReferenceRow | null,
  options: { editorId: string; entryId: string; now: Date }
): Prisma.MedicineProvenanceCreateWithoutMedicineInput[] {
  return DRAFT_FIELDS.map((field) => {
    const value = String(input[field]).trim();
    const referenceValue = reference?.values[field as keyof DrapAutofillValues];
    const fromReference = referenceValue !== undefined && String(referenceValue) === value;
    if (fromReference && reference)
      return {
        field,
        editorId: options.editorId,
        source: `${DRAP_REGISTRY_CONNECTOR_ID}:${reference.inputDigest}:${reference.rowSourceKey}`,
        sourceType: 'REGULATOR' as const,
        retrievedAt: reference.retrievedAt,
        status: 'UNREVIEWED' as const,
        assertedValue: {
          value,
          connectorId: DRAP_REGISTRY_CONNECTOR_ID,
          sourceLabel: reference.fileName,
          batchId: reference.batchId,
          rowSourceKey: reference.rowSourceKey,
          rights: { ...DRAP_REGISTRY_RIGHTS },
          blockingIssues: [],
        },
      };
    return {
      field,
      editorId: options.editorId,
      source: 'Add medicine form',
      sourceType: 'USER' as const,
      retrievedAt: options.now,
      status: 'UNREVIEWED' as const,
      assertedValue: {
        value,
        connectorId: ADD_MEDICINE_FORM_SOURCE,
        sourceLabel: 'Add medicine form',
        batchId: options.entryId,
        rowSourceKey: 'manual-entry',
        rights: { ...ADD_MEDICINE_FORM_RIGHTS },
        blockingIssues: [],
      },
    };
  });
}
