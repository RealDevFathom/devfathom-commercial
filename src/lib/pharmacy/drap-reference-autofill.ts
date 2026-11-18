import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { parseSimpleMedicineStrength } from './medicine';
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

/**
 * The one registration-number normalisation: trimmed, case-folded, whitespace collapsed. The
 * lookup of DRAP rows, the duplicate check and the lock key all use it, matching the counter's
 * case-insensitive registration search.
 */
export function normalizeDrapRegistration(registration: string): string {
  return registration.trim().toLowerCase().replace(/\s+/g, ' ');
}

// The same normalisation in SQL: lower-case, collapse whitespace, then trim.
const normalizedSql = (column: Prisma.Sql) =>
  Prisma.sql`btrim(regexp_replace(lower(${column}), '[[:space:]]+', ' ', 'g'))`;

/**
 * Serializes every draft save and DRAP confirmation for one registration number in this
 * organisation until the transaction ends. Two-key form, so it has its own lock key space.
 */
export async function lockDrapRegistration(
  db: ScopedDb,
  organizationId: string,
  registration: string
): Promise<void> {
  await db.$queryRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    'pharmacy-medicine-registration',
    `${organizationId}:${normalizeDrapRegistration(registration)}`
  );
}

/** Catalogue medicines of this organisation carrying a registration number, normalised. */
export async function findMedicinesByRegistration(
  db: ScopedDb,
  organizationId: string,
  registration: string
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM pharmacy_medicines
     WHERE "organizationId" = ${organizationId}
       AND ${normalizedSql(Prisma.sql`"drapRegistrationNumber"`)} = ${normalizeDrapRegistration(registration)}
     ORDER BY id LIMIT 2`);
  return rows.map((row) => row.id);
}

/**
 * Catalogue medicine ids per normalised registration number, for many numbers in one query.
 * A number carried by more than one medicine maps to all of them.
 */
export async function findMedicinesByRegistrations(
  db: ScopedDb,
  organizationId: string,
  registrations: readonly string[]
): Promise<Map<string, string[]>> {
  const normalized = [...new Set(registrations.map(normalizeDrapRegistration))];
  if (!normalized.length) return new Map();
  const rows = await db.$queryRaw<Array<{ id: string; registration: string }>>(Prisma.sql`
    SELECT id, ${normalizedSql(Prisma.sql`"drapRegistrationNumber"`)} AS registration
      FROM pharmacy_medicines
     WHERE "organizationId" = ${organizationId}
       AND ${normalizedSql(Prisma.sql`"drapRegistrationNumber"`)} = ANY(${normalized}::text[])
     ORDER BY id`);
  const byRegistration = new Map<string, string[]>();
  for (const row of rows)
    byRegistration.set(row.registration, [...(byRegistration.get(row.registration) ?? []), row.id]);
  return byRegistration;
}

/**
 * The newest pending or confirmed DRAP row this organisation imported for a registration number
 * (normalised). A row a pharmacist rejected does not lock a draft. The server applies the stated
 * flags of this row to every draft carrying the number, so the lock does not depend on the form.
 */
export async function findDrapReferenceByRegistration(
  db: ScopedDb,
  organizationId: string,
  registration: string
): Promise<DrapReferenceRow | null> {
  const connectorId = await drapConnectorId(db, organizationId);
  if (!connectorId) return null;
  const [row] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM pharmacy_reference_connector_proposals
     WHERE "organizationId" = ${organizationId}
       AND "connectorId" = ${connectorId}
       AND status IN ('PENDING', 'CONFIRMED')
       AND ${normalizedSql(Prisma.sql`(payload #>> '{values,drapRegistrationNumber}')`)} = ${normalizeDrapRegistration(registration)}
     ORDER BY "createdAt" DESC, id DESC LIMIT 1`);
  if (!row) return null;
  const proposal = await db.pharmacyReferenceConnectorProposal.findFirst({
    where: { id: row.id, organizationId },
    select: proposalSelect,
  });
  return proposal ? referenceRow(proposal) : null;
}

/** What a reviewer compares a DRAP row with before it updates an existing medicine. */
export interface CatalogueMedicineSnapshot {
  id: string;
  productName: string;
  strength: string | null;
  dosageForm: string | null;
  drapRegistrationNumber: string | null;
  rx: boolean;
  controlled: boolean;
}

function assertedText(value: Prisma.JsonValue | null): string | null {
  const envelope = record(value);
  return typeof envelope.value === 'string' ? envelope.value : null;
}

/**
 * Current name, strength, form and flags of catalogue medicines. Strength and form come from the
 * newest current assertion (a draft has no presentation yet), else the published structure.
 */
export async function catalogueMedicineSnapshots(
  db: ScopedDb,
  medicineIds: readonly string[]
): Promise<Map<string, CatalogueMedicineSnapshot>> {
  if (!medicineIds.length) return new Map();
  const medicines = await db.medicine.findMany({
    where: { id: { in: [...medicineIds] } },
    select: {
      id: true,
      productName: true,
      drapRegistrationNumber: true,
      rx: true,
      controlled: true,
      presentations: { select: { dosageForm: true }, orderBy: { id: 'asc' }, take: 1 },
      strengths: { select: { value: true, unit: true }, orderBy: { id: 'asc' }, take: 1 },
      provenance: {
        where: {
          field: { in: ['strength', 'dosageForm'] },
          status: { in: ['UNREVIEWED', 'ACCEPTED', 'CORRECTED'] },
          supersededBy: { none: {} },
        },
        select: { field: true, assertedValue: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  return new Map(
    medicines.map((medicine) => {
      const asserted = (field: string) =>
        assertedText(
          medicine.provenance.find((item) => item.field === field)?.assertedValue ?? null
        );
      const structured = medicine.strengths[0];
      return [
        medicine.id,
        {
          id: medicine.id,
          productName: medicine.productName,
          strength:
            asserted('strength') ??
            (structured ? `${String(structured.value)} ${structured.unit}` : null),
          dosageForm: asserted('dosageForm') ?? medicine.presentations[0]?.dosageForm ?? null,
          drapRegistrationNumber: medicine.drapRegistrationNumber,
          rx: medicine.rx,
          controlled: medicine.controlled,
        },
      ];
    })
  );
}

const IDENTITY_FIELDS = [
  ['productName', 'name'],
  ['strength', 'strength'],
  ['dosageForm', 'form'],
] as const;

// Separators kept when they sit between two digits, each held by a placeholder while the rest of
// the punctuation is removed. A decimal comma reads as a decimal point.
const DIGIT_SEPARATORS: Record<string, string> = {
  '.': '\uE000',
  ',': '\uE000',
  '/': '\uE001',
  '+': '\uE002',
  '-': '\uE003',
};
const RESTORED: Record<string, string> = {
  '\uE000': '.',
  '\uE001': '/',
  '\uE002': '+',
  '\uE003': '-',
};

/**
 * Text for an identity comparison: case, spacing and punctuation are ignored, but a decimal point
 * or comma, '/', '+' or '-' between two digits is kept, so "2.5 mg" never equals "25 mg", "25.0"
 * never "250", and "40/12.5 mg" never "401/2.5 mg". (normalizeMedicineText drops them, which is
 * right for search but not for identity.)
 */
export function identityText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en')
    .replace(/(\p{N})\s*([.,/+-])\s*(?=\p{N})/gu, (_, digit: string, separator: string) => {
      return `${digit}${DIGIT_SEPARATORS[separator]}`;
    })
    .replace(/[^\p{L}\p{N}\uE000-\uE003]+/gu, '')
    .replace(/[\uE000-\uE003]/g, (placeholder) => RESTORED[placeholder]!);
}

function sameStrengthPart(proposed: string, current: string): boolean {
  const left = parseSimpleMedicineStrength(proposed);
  const right = parseSimpleMedicineStrength(current);
  if (left && right)
    return left.value === right.value && left.unit.toLowerCase() === right.unit.toLowerCase();
  return identityText(proposed) === identityText(current);
}

/**
 * A combination strength ("500 mg/125 mg", "40/12.5 mg") is split on '/' and '+' and compared part
 * by part with the numeric rule; a different number of parts is a different strength.
 */
function sameStrength(proposed: string, current: string): boolean {
  const parts = (strength: string) =>
    strength
      .split(/[/+]/)
      .map((part) => part.trim())
      .filter(Boolean);
  const left = parts(proposed);
  const right = parts(current);
  if (left.length !== right.length) return false;
  return left.every((part, index) => sameStrengthPart(part, right[index]!));
}

/**
 * Identity fields where a DRAP row and the catalogue medicine with its registration number name
 * different products. Strengths compare by value and unit when both parse; otherwise, like the
 * name and form, by text that keeps decimal points. A value either side leaves unstated is not a
 * difference.
 */
export function registrationIdentityConflicts(
  values: Partial<Record<string, string>>,
  medicine: CatalogueMedicineSnapshot
): string[] {
  return IDENTITY_FIELDS.flatMap(([field, label]) => {
    const proposed = values[field];
    const current = medicine[field];
    if (!proposed || !current) return [];
    const same =
      field === 'strength'
        ? sameStrength(proposed, current)
        : identityText(proposed) === identityText(current);
    return same ? [] : [label];
  });
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
