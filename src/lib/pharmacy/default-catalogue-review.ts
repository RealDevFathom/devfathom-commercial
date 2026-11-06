import 'server-only';

import { TRPCError } from '@trpc/server';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { presentationLabel } from './default-catalogue-seed';
import { parseSimpleMedicineStrength } from './medicine';
import type { ConnectorRights, MedicineReferenceField } from './reference-connectors';

/**
 * Platform default medicine catalogue — the pharmacist's half.
 *
 * Every catalogue copy starts `saleable: false` with no reviewable
 * `MedicineProvenance`, and a hand-entered medicine linked to a NARCOTICS item
 * is held the same way. This module is how a pharmacist finds and completes
 * them through the existing reference review workbench, without any of them
 * reaching a sale path first:
 *
 *  - {@link catalogueAwaitingReviewWhere} selects them (copies, and NARCOTICS
 *    links) for the workbench's catalogue views. Every one is `saleable: false`;
 *    sale paths keep filtering on `saleable: true` and never see them.
 *  - {@link draftCatalogueReview} seeds UNREVIEWED assertions from the
 *    catalogue item (or, for a link, the pharmacy's own record) plus what the
 *    pharmacist entered — pack, DRAP registration, the controlled decision.
 *    From there the medicine follows the ordinary path: the pharmacist's ACCEPT
 *    (`recordReviewDecision`) and `publishAssertions`, whose saleable gate and
 *    NARCOTICS hold are unchanged. Nothing here makes a medicine saleable.
 *  - {@link matchCatalogueMedicine} lets a reference import row without a
 *    target id find the catalogue copy it describes instead of creating a
 *    duplicate.
 *  - {@link catalogueReviewSummary} gives the workbench its counts, including
 *    how many hand-entered medicines are held from sale.
 */

export const CATALOGUE_REVIEW_CONNECTOR = 'platform-default';

/** Rights recorded on assertions drafted from the platform default catalogue. */
export const CATALOGUE_REVIEW_RIGHTS: ConnectorRights = {
  acquisition: 'Platform default medicine catalogue, loaded by the platform',
  cache: 'Tenant copy of shared platform reference data',
  redistribution: 'Not permitted outside the tenant workspace',
  deletion: 'Subject to tenant retention and legal-hold policy',
};

/** The fields a pharmacist may supply or correct when drafting a catalogue review. */
export const CATALOGUE_REVIEW_FIELDS = [
  'productName',
  'brandName',
  'manufacturer',
  'drapRegistrationNumber',
  'strength',
  'dosageForm',
  'pack',
  'barcode',
  'alias',
  'controlled',
] as const satisfies readonly MedicineReferenceField[];
export type CatalogueReviewField = (typeof CATALOGUE_REVIEW_FIELDS)[number];

/** Where a drafted value came from, recorded on its assertion. */
export type CatalogueReviewOrigin = 'catalogue' | 'medicine' | 'pharmacist';
export type CatalogueReviewValue = { value: string; origin: CatalogueReviewOrigin };
export type CatalogueReviewValues = Partial<Record<CatalogueReviewField, CatalogueReviewValue>>;

type ProductFamily = 'PHARMACEUTICAL' | 'BIOLOGICAL' | 'DEVICE' | 'ALTERNATIVE' | 'FRONT_SHOP';

const OPEN_ASSERTIONS: Prisma.MedicineProvenanceWhereInput = {
  OR: [
    { status: 'UNREVIEWED' },
    {
      status: { in: ['ACCEPTED', 'CORRECTED'] },
      publicationEntries: { none: { batch: { status: 'PUBLISHED' } } },
    },
  ],
};

/**
 * Unsaleable medicines the default catalogue left for a pharmacist: every copy
 * it created, and every hand-entered medicine linked to a NARCOTICS item.
 * `controlledOnly` narrows to NARCOTICS-flagged ones; `query` matches product
 * or brand name (case-insensitive) or the exact catalogue source key.
 */
export function catalogueAwaitingReviewWhere(
  options: { controlledOnly?: boolean; query?: string } = {}
): Prisma.MedicineWhereInput {
  const query = options.query?.trim();
  return {
    saleable: false,
    catalogueProvenance: {
      is: options.controlledOnly
        ? { controlledCandidate: true }
        : { OR: [{ linkedExisting: false }, { controlledCandidate: true }] },
    },
    ...(query
      ? {
          OR: [
            { productName: { contains: query, mode: 'insensitive' } },
            { brandName: { contains: query, mode: 'insensitive' } },
            { catalogueProvenance: { is: { sourceKey: query } } },
          ],
        }
      : {}),
  };
}

const collapse = (value: string) => value.trim().replace(/\s+/g, ' ');

function stringValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = collapse(value);
  return collapsed.length ? collapsed : null;
}

/**
 * What a review draft starts from. A copy starts from its catalogue item (the
 * medicine's own name fields win where the pharmacy has since edited them);
 * its pack defaults to the presentation the catalogue created, so publishing
 * it unchanged completes that presentation rather than adding a second one. A
 * linked hand-entered medicine starts from its own record — the catalogue
 * never wrote its fields and the draft does not either.
 */
export function catalogueReviewDefaults(input: {
  linkedExisting: boolean;
  item: {
    productName: string;
    brandName: string | null;
    manufacturer: string | null;
    strength: string | null;
    dosageForm: string | null;
  } | null;
  medicine: {
    productName: string;
    brandName: string | null;
    manufacturer: string | null;
    drapRegistrationNumber: string | null;
    strengths: ReadonlyArray<{ value: { toString(): string } | number | string; unit: string }>;
    presentations: ReadonlyArray<{ dosageForm: string | null; presentation: string }>;
  };
}): CatalogueReviewValues {
  const out: CatalogueReviewValues = {};
  const put = (
    field: CatalogueReviewField,
    value: string | null | undefined,
    origin: CatalogueReviewOrigin
  ) => {
    const clean = stringValue(value);
    if (clean) out[field] = { value: clean, origin };
  };
  const { medicine, item } = input;
  const firstStrength = medicine.strengths[0];
  const firstPresentation = medicine.presentations[0];

  if (input.linkedExisting || !item) {
    put('productName', medicine.productName, 'medicine');
    put('brandName', medicine.brandName, 'medicine');
    put('manufacturer', medicine.manufacturer, 'medicine');
    put('drapRegistrationNumber', medicine.drapRegistrationNumber, 'medicine');
    if (firstStrength) {
      put('strength', `${firstStrength.value.toString()} ${firstStrength.unit}`, 'medicine');
    }
    put('dosageForm', firstPresentation?.dosageForm, 'medicine');
    put('pack', firstPresentation?.presentation, 'medicine');
    return out;
  }

  const fromRecord = (field: 'productName' | 'brandName' | 'manufacturer') => {
    const own = stringValue(medicine[field]);
    const catalogue = stringValue(item[field]);
    // Unchanged since the copy: the catalogue's. Edited (or cleared) by the
    // pharmacy: the pharmacy's — a cleared field is not put back.
    if (own === catalogue) put(field, catalogue, 'catalogue');
    else put(field, own, 'medicine');
  };
  fromRecord('productName');
  fromRecord('brandName');
  fromRecord('manufacturer');
  put('drapRegistrationNumber', medicine.drapRegistrationNumber, 'medicine');
  put('strength', item.strength, 'catalogue');
  put('dosageForm', item.dosageForm, 'catalogue');
  const label = presentationLabel(item);
  const placeholder = medicine.presentations.find(
    (presentation) =>
      presentation.presentation === label && (presentation.dosageForm ?? null) === item.dosageForm
  );
  if (placeholder) put('pack', placeholder.presentation, 'catalogue');
  return out;
}

/**
 * The draft: defaults overlaid with what the pharmacist entered (an entry equal
 * to the default keeps the default's origin), checked against what
 * publication will demand, so a draft that could never publish is refused up
 * front with every problem named.
 */
export function resolveCatalogueReview(input: {
  defaults: CatalogueReviewValues;
  entered: Partial<Record<CatalogueReviewField, string | undefined>>;
  productFamily: ProductFamily;
  controlledCandidate: boolean;
}): { values: CatalogueReviewValues; problems: string[] } {
  const values: CatalogueReviewValues = { ...input.defaults };
  for (const field of CATALOGUE_REVIEW_FIELDS) {
    const entered = stringValue(input.entered[field]);
    if (!entered) continue;
    const value = field === 'controlled' ? entered.toLowerCase() : entered;
    if (values[field]?.value === value) continue;
    values[field] = { value, origin: 'pharmacist' };
  }

  const problems: string[] = [];
  const missing = (['productName', 'strength', 'dosageForm', 'pack'] as const).filter(
    (field) => !values[field]
  );
  if (missing.length) problems.push(`Enter ${missing.join(', ')} before review.`);
  const strength = values.strength?.value;
  if (strength && !parseSimpleMedicineStrength(strength)) {
    problems.push(
      `Strength "${strength}" cannot be structured; enter one number and unit, e.g. 500 mg.`
    );
  }
  if (input.productFamily !== 'FRONT_SHOP' && !values.drapRegistrationNumber) {
    problems.push('Enter the DRAP registration number before review.');
  }
  const controlled = values.controlled?.value;
  if (controlled !== undefined && controlled !== 'true' && controlled !== 'false') {
    problems.push('The controlled decision must be true or false.');
  }
  if (input.controlledCandidate && controlled === undefined) {
    problems.push(
      'This item was filed under NARCOTICS in the default catalogue; record a controlled decision (true or false).'
    );
  }
  return { values, problems };
}

/**
 * Seed UNREVIEWED assertions for one catalogue medicine awaiting review. Run
 * inside the caller's transaction, in the tenant scope. Refused when the
 * medicine is not awaiting catalogue review, already has assertions in review,
 * or the draft could not be published.
 */
export async function draftCatalogueReview(
  db: ScopedDb | Prisma.TransactionClient,
  input: {
    organizationId: string;
    medicineId: string;
    actorId: string;
    values: Partial<Record<CatalogueReviewField, string | undefined>>;
    now?: Date;
  }
) {
  const medicine = await db.medicine.findFirst({
    where: {
      id: input.medicineId,
      organizationId: input.organizationId,
      ...catalogueAwaitingReviewWhere(),
    },
    include: {
      catalogueProvenance: true,
      presentations: { orderBy: { createdAt: 'asc' } },
      strengths: { orderBy: { createdAt: 'asc' } },
      provenance: { where: OPEN_ASSERTIONS, select: { id: true }, take: 1 },
    },
  });
  const provenance = medicine?.catalogueProvenance;
  if (!medicine || !provenance) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'No default-catalogue medicine awaiting review was found.',
    });
  }
  if (medicine.provenance.length) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'This medicine already has assertions in review; accept, reject or publish them first.',
    });
  }
  const item = await db.platformMedicineCatalogueItem.findUnique({
    where: {
      versionId_sourceKey: {
        versionId: provenance.catalogueVersionId,
        sourceKey: provenance.sourceKey,
      },
    },
  });
  const { values, problems } = resolveCatalogueReview({
    defaults: catalogueReviewDefaults({
      linkedExisting: provenance.linkedExisting,
      item,
      medicine,
    }),
    entered: input.values,
    productFamily: medicine.productFamily,
    controlledCandidate: provenance.controlledCandidate,
  });
  if (problems.length) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: problems.join(' ') });
  }

  const retrievedAt = input.now ?? new Date();
  const version = `${provenance.catalogueKey}:v${provenance.catalogueVersion}`;
  const catalogueSource = `${provenance.source}:${version}:${provenance.sourceKey}`;
  const catalogueLabel = `Default catalogue ${version}`;
  const batchId = `catalogue-review:${provenance.id}:${retrievedAt.getTime()}`;
  const assertions = [];
  for (const field of CATALOGUE_REVIEW_FIELDS) {
    const entry = values[field];
    if (!entry) continue;
    const origin = {
      catalogue: {
        source: catalogueSource,
        sourceType: 'IMPORT' as const,
        connectorId: CATALOGUE_REVIEW_CONNECTOR,
        sourceLabel: catalogueLabel,
      },
      medicine: {
        source: `medicine-record:${medicine.id}`,
        sourceType: 'USER' as const,
        connectorId: 'medicine-record',
        sourceLabel: 'Pharmacy medicine record',
      },
      pharmacist: {
        source: `pharmacist:${input.actorId}`,
        sourceType: 'USER' as const,
        connectorId: 'pharmacist-entry',
        sourceLabel: 'Entered by the pharmacist',
      },
    }[entry.origin];
    assertions.push(
      await db.medicineProvenance.create({
        data: {
          organizationId: input.organizationId,
          medicineId: medicine.id,
          field,
          source: origin.source,
          sourceType: origin.sourceType,
          retrievedAt,
          status: 'UNREVIEWED',
          assertedValue: {
            value: entry.value,
            connectorId: origin.connectorId,
            sourceLabel: origin.sourceLabel,
            batchId,
            rowSourceKey: provenance.sourceKey,
            rights: {
              acquisition: CATALOGUE_REVIEW_RIGHTS.acquisition,
              cache: CATALOGUE_REVIEW_RIGHTS.cache,
              redistribution: CATALOGUE_REVIEW_RIGHTS.redistribution,
              deletion: CATALOGUE_REVIEW_RIGHTS.deletion,
            },
            blockingIssues: [],
          },
        },
      })
    );
  }
  return {
    medicineId: medicine.id,
    assertionIds: assertions.map((assertion) => assertion.id),
    fields: Object.fromEntries(
      assertions.map((assertion) => [assertion.field, assertion.id])
    ) as Partial<Record<CatalogueReviewField, string>>,
  };
}

export type CatalogueMedicineMatch =
  | { kind: 'none' }
  | { kind: 'match'; medicineId: string; by: 'sourceKey' | 'name' }
  | { kind: 'ambiguous'; medicineIds: string[] };

/**
 * The tenant medicine a reference row without a target id describes, when the
 * default catalogue already put it there: first the medicine holding the row's
 * source key as catalogue provenance (exact string, as everywhere), else the
 * one catalogue copy with the same product name and manufacturer, compared
 * case-insensitively with whitespace collapsed (a row with no manufacturer
 * matches a copy with none). More than one candidate is `ambiguous`: the caller
 * must refuse rather than guess or create another duplicate.
 */
export async function matchCatalogueMedicine(
  db: ScopedDb | Prisma.TransactionClient,
  input: {
    organizationId: string;
    rowSourceKey: string;
    productName?: string | null;
    manufacturer?: string | null;
  }
): Promise<CatalogueMedicineMatch> {
  const keyed = [
    ...new Set(
      (
        await db.medicineCatalogueProvenance.findMany({
          where: { organizationId: input.organizationId, sourceKey: input.rowSourceKey },
          select: { medicineId: true },
          orderBy: { medicineId: 'asc' },
          take: 10,
        })
      ).map((row) => row.medicineId)
    ),
  ];
  if (keyed.length === 1) return { kind: 'match', medicineId: keyed[0]!, by: 'sourceKey' };
  if (keyed.length > 1) return { kind: 'ambiguous', medicineIds: keyed };

  const productName = stringValue(input.productName);
  if (!productName) return { kind: 'none' };
  const manufacturer = stringValue(input.manufacturer);
  const named = await db.medicine.findMany({
    where: {
      organizationId: input.organizationId,
      productName: { equals: productName, mode: 'insensitive' },
      manufacturer: manufacturer ? { equals: manufacturer, mode: 'insensitive' } : null,
      catalogueProvenance: { is: { linkedExisting: false } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 10,
  });
  if (named.length === 1) return { kind: 'match', medicineId: named[0]!.id, by: 'name' };
  if (named.length > 1) return { kind: 'ambiguous', medicineIds: named.map(({ id }) => id) };
  return { kind: 'none' };
}

export type CatalogueReviewSummary = {
  /** Every catalogue medicine awaiting review: copies plus NARCOTICS links. */
  awaitingReview: number;
  /** Unsaleable catalogue copies. */
  copiesAwaitingReview: number;
  /** Of `awaitingReview`, the NARCOTICS-flagged ones (copies and links). */
  controlledAwaitingReview: number;
  /**
   * Hand-entered medicines linked to a NARCOTICS item and held from sale until a
   * pharmacist publishes a reviewed controlled decision.
   */
  heldFromSale: number;
};

export async function catalogueReviewSummary(
  db: ScopedDb | Prisma.TransactionClient,
  organizationId: string
): Promise<CatalogueReviewSummary> {
  const count = (where: Prisma.MedicineWhereInput) =>
    db.medicine.count({ where: { organizationId, ...where } });
  const [awaitingReview, copiesAwaitingReview, controlledAwaitingReview, heldFromSale] =
    await Promise.all([
      count(catalogueAwaitingReviewWhere()),
      count({ saleable: false, catalogueProvenance: { is: { linkedExisting: false } } }),
      count(catalogueAwaitingReviewWhere({ controlledOnly: true })),
      count({
        saleable: false,
        catalogueProvenance: { is: { linkedExisting: true, controlledCandidate: true } },
      }),
    ]);
  return { awaitingReview, copiesAwaitingReview, controlledAwaitingReview, heldFromSale };
}
