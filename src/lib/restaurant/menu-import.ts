import 'server-only';

import { createFixtureMenuExtractionAdapter } from './menu-extraction-fixtures';

import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import {
  createProduct,
  createCategory,
  createVariant,
  ensureDefaultBrand,
} from '@/lib/restaurant/catalog';
import type {
  RestaurantJobContext,
  RestaurantJobHandler,
} from '@/lib/restaurant/job-handlers-core';
import {
  LOW_CONFIDENCE_THRESHOLD,
  MenuExtractionError,
  normalizeProductKey,
  type MenuExtractionAdapter,
  type MenuExtractionAdapterName,
  type MenuExtractionResult,
  type MenuLineFlag,
} from '@/lib/restaurant/menu-extraction';
import { createVisionMenuExtractionAdapter } from '@/lib/restaurant/menu-extraction-vision';
import {
  menuImportObjectName,
  validateMenuUpload,
  type MenuUploadMimeType,
} from '@/lib/restaurant/menu-import-uploads';
import { createMenu, createMenuItem, createMenuSection } from '@/lib/restaurant/menus';
import { addPriceListEntry, createPriceListVersion } from '@/lib/restaurant/price-lists';
import { enqueue } from '@/lib/restaurant/scheduler';
import {
  assertStorageAvailable,
  getStorageAvailability,
  deleteUpload,
  getUpload,
  putUpload,
} from '@/lib/storage';
import { readAIAvailability } from '@/lib/ai/provider';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { isDemoTenant } from '@/lib/tenancy/demo-isolation';

/**
 * R-lane / WHA-194 — the menu-import domain: upload -> asynchronous extraction
 * -> human review -> one transactional catalog import.
 *
 * The invariant the whole module exists to hold is HUMAN REVIEW IS MANDATORY.
 * Extraction never writes a catalog row; it writes candidates. `commitMenuImport`
 * refuses to run while any line is still undecided, so there is no path — not a
 * retry, not a replay, not a high-confidence shortcut — by which OCR output
 * becomes a sellable product without a person saying so.
 *
 * Two more properties are load-bearing and easy to lose:
 *
 *  - IDEMPOTENCY at every boundary. Uploading the same bytes twice resumes one
 *    draft; the extraction job can run repeatedly; commit is a no-op after the
 *    first success. Background work retries, so anything that is not idempotent
 *    is a duplicate-catalog bug waiting for a bad night.
 *  - NO SILENT PUBLISH. Commit creates catalog rows, a DRAFT menu and entries on
 *    a DRAFT price-list version. It never creates a branch publication and never
 *    activates a version, so nothing reaches a till until someone publishes it
 *    through the existing M3 surfaces.
 */

export const MENU_IMPORT_EXTRACT_JOB = 'menu.import.extract';

/** Uploaded sources and abandoned drafts are purged after this long. */
export const MENU_IMPORT_DRAFT_TTL_DAYS = 14;

/** Statuses in which an import is still working towards a review. */
const OPEN_STATUSES = ['PENDING_EXTRACTION', 'EXTRACTING', 'AWAITING_REVIEW'] as const;

export type MenuImportErrorReason =
  | 'NOT_FOUND'
  | 'INVALID'
  | 'INVALID_STATE'
  | 'ALREADY_IMPORTED'
  | 'REVIEW_INCOMPLETE'
  | 'NOTHING_TO_IMPORT'
  | 'MERGE_TARGET_NOT_FOUND'
  | 'PRICE_REQUIRED'
  | 'VARIANTS_REVIEW_REQUIRED'
  | 'CURRENCY_MISMATCH';

export class MenuImportError extends Error {
  constructor(
    message: string,
    readonly reason: MenuImportErrorReason
  ) {
    super(message);
    this.name = 'MenuImportError';
  }
}

// ── Runtime seams ─────────────────────────────────────────────────────────────

/**
 * The side-effecting collaborators, injected so the acceptance battery can drive
 * the real database with a deterministic adapter and an in-memory object store.
 */
export type MenuImportRuntime = {
  resolveAdapter: (name: MenuExtractionAdapterName) => MenuExtractionAdapter;
  putSource: (
    organizationId: string,
    objectName: string,
    content: Buffer,
    contentType: string
  ) => Promise<void>;
  readSource: (organizationId: string, objectName: string) => Promise<Buffer>;
  deleteSource: (organizationId: string, objectName: string) => Promise<void>;
  /** Test-only failure seam at durable ingestion and cleanup boundaries. */
  afterBoundary?: (
    boundary:
      | 'row-created'
      | 'upload-stored'
      | 'enqueue'
      | 'metadata-recorded'
      | 'committed-before-delete'
      | 'source-deleted',
    importId: string
  ) => Promise<void>;
};

export const defaultMenuImportRuntime: MenuImportRuntime = {
  resolveAdapter: (name) => {
    if (name === 'VISION') return createVisionMenuExtractionAdapter();
    if (name === 'FIXTURE' && configuredAdapterName() === 'FIXTURE') {
      return createFixtureMenuExtractionAdapter();
    }
    throw new MenuExtractionError('Menu extraction is unavailable.', 'ADAPTER_UNAVAILABLE');
  },
  putSource: putUpload,
  readSource: getUpload,
  deleteSource: deleteUpload,
};

/** Resolve only explicitly enabled extraction; fixtures never run in production. */
export function configuredAdapterName(
  env: Record<string, string | undefined> = process.env
): MenuExtractionAdapterName {
  const name = env.MENU_IMPORT_ADAPTER?.trim().toUpperCase();
  if (name === 'VISION' && readAIAvailability(env).available) return 'VISION';
  if (name === 'FIXTURE' && (env.NODE_ENV === 'test' || env.NODE_ENV === 'development')) {
    return 'FIXTURE';
  }
  throw new MenuExtractionError('Menu extraction is unavailable.', 'ADAPTER_UNAVAILABLE');
}

function assertMenuAdapterAvailable(name: MenuExtractionAdapterName): void {
  if (configuredAdapterName() !== name) {
    throw new MenuExtractionError('Menu extraction is unavailable.', 'ADAPTER_UNAVAILABLE');
  }
}

/** Public availability contains no provider or storage configuration. */
export function getMenuImportAvailability(): { available: boolean; explanation: string | null } {
  try {
    configuredAdapterName();
  } catch {
    return {
      available: false,
      explanation:
        'Menu extraction is unavailable. You can still edit menus manually and review existing imports.',
    };
  }
  if (!getStorageAvailability().available) {
    return {
      available: false,
      explanation:
        'Menu uploads are unavailable. You can still edit menus manually and review existing imports.',
    };
  }
  return { available: true, explanation: null };
}

/** Open one tenant-scoped interactive transaction (same shape as the M5-M7 domains). */
function runImportTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

// ── Ingestion ─────────────────────────────────────────────────────────────────

export type CreateMenuImportInput = {
  fileName: string;
  content: Buffer;
  /** What the client claims; cross-checked against the bytes, never trusted. */
  declaredMimeType?: string | null;
  createdById: string;
  /** Defaults to the configured adapter. */
  adapter?: MenuExtractionAdapterName;
  /** The org's currency, used only to flag a mismatched price for review. */
  defaultCurrency?: string | null;
  /**
   * Override the idempotency anchor. Omitted, it is the file checksum, so a
   * double-submitted upload resumes one draft instead of paying twice.
   */
  idempotencyKey?: string;
};

export type CreateMenuImportResult = {
  importId: string;
  status: string;
  deduplicated: boolean;
  pageCount: number;
};

/**
 * Validate, store and register an upload, then enqueue its extraction. Storage
 * happens BEFORE the row exists only in the sense of ordering; the object name
 * is derived from the row id, so the row is created first and the file is
 * written under a key nothing else can collide with.
 */
export async function createMenuImport(
  db: ScopedDb,
  organizationId: string,
  input: CreateMenuImportInput,
  options: { runtime?: MenuImportRuntime; now?: Date } = {}
): Promise<CreateMenuImportResult> {
  const runtime = options.runtime ?? defaultMenuImportRuntime;
  const now = options.now ?? new Date();

  const fileName = input.fileName?.trim();
  if (!fileName) {
    throw new MenuImportError('The upload needs a file name.', 'INVALID');
  }
  if (!input.createdById?.trim()) {
    throw new MenuImportError('The upload needs an uploading user.', 'INVALID');
  }

  const adapter = input.adapter ?? configuredAdapterName();
  assertMenuAdapterAvailable(adapter);
  assertStorageAvailable();

  const upload = validateMenuUpload({
    content: input.content,
    declaredMimeType: input.declaredMimeType,
  });
  const idempotencyKey = input.idempotencyKey?.trim() || upload.checksum;

  let existing = await db.restaurantMenuImport.findFirst({
    where: { idempotencyKey },
    select: {
      id: true,
      status: true,
      pageCount: true,
      checksum: true,
      mimeType: true,
      storageObjectName: true,
      extractionJobId: true,
    },
  });
  if (existing) {
    if (existing.checksum !== upload.checksum) {
      throw new MenuImportError(
        'This idempotency key already belongs to a different upload.',
        'INVALID'
      );
    }
    if (!(OPEN_STATUSES as readonly string[]).includes(existing.status)) {
      // A finished import is evidence, not a draft to resume. Re-importing the
      // same menu is legitimate but must be asked for explicitly, so nobody
      // duplicates a catalog by re-dragging yesterday's file into the uploader.
      throw new MenuImportError(
        `This file was already imported (${existing.status.toLowerCase()}). Supply an idempotency key to import it again.`,
        'ALREADY_IMPORTED'
      );
    }
  }

  let deduplicated = Boolean(existing);

  if (!existing) {
    try {
      existing = await db.restaurantMenuImport.create({
        data: {
          status: 'PENDING_EXTRACTION',
          adapter,
          fileName: fileName.slice(0, 255),
          mimeType: upload.mimeType,
          byteSize: upload.byteSize,
          pageCount: upload.pageCount,
          checksum: upload.checksum,
          defaultCurrency: input.defaultCurrency?.trim().toUpperCase() || null,
          idempotencyKey,
          createdById: input.createdById,
        },
        select: {
          id: true,
          status: true,
          pageCount: true,
          checksum: true,
          mimeType: true,
          storageObjectName: true,
          extractionJobId: true,
        },
      });
      await runtime.afterBoundary?.('row-created', existing.id);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      existing = await db.restaurantMenuImport.findFirst({
        where: { idempotencyKey },
        select: {
          id: true,
          status: true,
          pageCount: true,
          checksum: true,
          mimeType: true,
          storageObjectName: true,
          extractionJobId: true,
        },
      });
      if (!existing || existing.checksum !== upload.checksum) {
        throw new MenuImportError(
          'This idempotency key already belongs to a different upload.',
          'INVALID'
        );
      }
      deduplicated = true;
    }
  }

  const objectName = menuImportObjectName(existing.id, existing.mimeType as MenuUploadMimeType);
  if (!existing.storageObjectName) {
    await runtime.putSource(organizationId, objectName, upload.content, upload.mimeType);
    await runtime.afterBoundary?.('upload-stored', existing.id);
    await db.restaurantMenuImport.update({
      where: { id: existing.id },
      data: { storageObjectName: objectName },
    });
  }

  if (!existing.extractionJobId) {
    const enqueueInput = {
      type: MENU_IMPORT_EXTRACT_JOB,
      payload: { importId: existing.id },
      idempotencyKey: `${MENU_IMPORT_EXTRACT_JOB}:${existing.id}`,
    } as const;
    let job;
    try {
      ({ job } = await enqueue(db, enqueueInput, now));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('reason' in error) ||
        error.reason !== 'DUPLICATE_ENQUEUE'
      ) {
        throw error;
      }
      ({ job } = await enqueue(db, enqueueInput, now));
    }
    await runtime.afterBoundary?.('enqueue', existing.id);
    await db.restaurantMenuImport.update({
      where: { id: existing.id },
      data: { extractionJobId: job.id },
    });
    await runtime.afterBoundary?.('metadata-recorded', existing.id);
  }

  return {
    importId: existing.id,
    status: existing.status,
    deduplicated,
    pageCount: existing.pageCount,
  };
}

// ── Extraction (asynchronous, idempotent) ─────────────────────────────────────

const EXTRACT_PAYLOAD = z.object({ importId: z.string().min(1) }).strict();

/** Decimal or null — a menu that states no price must not become a zero price. */
function toDecimal(amount: string | null): Prisma.Decimal | null {
  return amount === null ? null : new Prisma.Decimal(amount);
}

/**
 * Persist one adapter result as review rows. Runs inside the caller's
 * transaction and REPLACES any previous pages for the import, so a re-extraction
 * (retry, or a re-run after an adapter upgrade) converges on one set of
 * candidates instead of appending a second copy.
 */
async function persistExtraction(
  tx: ScopedDb,
  importId: string,
  result: MenuExtractionResult
): Promise<number> {
  await tx.restaurantMenuImportPage.deleteMany({ where: { importId } });

  // Collision detection against the live catalog. Loaded once per extraction and
  // folded through the same key function the adapter uses, so "Chicken Tikka"
  // and "chicken  tikka" are one dish.
  const products = await tx.restaurantProduct.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, name: true },
  });
  const existingKeys = new Set(
    products.map((product) => normalizeProductKey(product.name)).filter(Boolean) as string[]
  );

  let lineCount = 0;
  for (const page of result.pages) {
    const createdPage = await tx.restaurantMenuImportPage.create({
      data: { importId, pageNumber: page.pageNumber, warnings: page.warnings },
      select: { id: true },
    });

    for (const line of page.lines) {
      const matchKey = normalizeProductKey(line.productName);
      const flags: MenuLineFlag[] = [...line.flags];
      if (matchKey && existingKeys.has(matchKey) && !flags.includes('EXISTING_PRODUCT_MATCH')) {
        flags.push('EXISTING_PRODUCT_MATCH');
      }

      await tx.restaurantMenuImportLine.create({
        data: {
          importId,
          pageId: createdPage.id,
          sortOrder: line.sortOrder,
          extractedCategoryName: line.categoryName,
          extractedProductName: line.productName,
          extractedDescription: line.description,
          extractedIngredients: line.ingredients,
          extractedPriceAmount: toDecimal(line.price.amount),
          extractedCurrency: line.price.currency,
          extractedPriceRaw: line.price.raw,
          extractedVariants: line.variants as unknown as Prisma.InputJsonValue,
          extractedModifiers: line.modifiers as unknown as Prisma.InputJsonValue,
          confidence: line.confidence as unknown as Prisma.InputJsonValue,
          flags: flags.sort(),
          matchKey,
        },
      });
      lineCount += 1;
    }
  }
  return lineCount;
}

export type ExtractionOutcome = {
  importId: string;
  status: 'AWAITING_REVIEW' | 'EXTRACTION_FAILED' | 'SKIPPED';
  lineCount: number;
};

/**
 * Run extraction for one import. Exported separately from the job handler so it
 * can be driven directly by the acceptance battery and by an operator re-run.
 */
export async function runMenuImportExtraction(
  db: ScopedDb,
  importId: string,
  options: { runtime?: MenuImportRuntime; now?: Date; signal?: AbortSignal } = {}
): Promise<ExtractionOutcome> {
  const runtime = options.runtime ?? defaultMenuImportRuntime;
  const now = options.now ?? new Date();

  const record = await db.restaurantMenuImport.findUnique({
    where: { id: importId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      adapter: true,
      mimeType: true,
      pageCount: true,
      defaultCurrency: true,
      storageObjectName: true,
    },
  });

  // A discarded-and-purged import leaves its job behind. That is an expected
  // race, not a failure: succeed quietly rather than dead-letter the queue.
  if (!record) return { importId, status: 'SKIPPED', lineCount: 0 };
  if (record.status !== 'PENDING_EXTRACTION' && record.status !== 'EXTRACTING') {
    return { importId, status: 'SKIPPED', lineCount: 0 };
  }
  if (!record.storageObjectName) {
    await db.restaurantMenuImport.update({
      where: { id: importId },
      data: {
        status: 'EXTRACTION_FAILED',
        failureReason: 'The uploaded file is no longer available.',
        extractionCompletedAt: now,
      },
    });
    return { importId, status: 'EXTRACTION_FAILED', lineCount: 0 };
  }

  await db.restaurantMenuImport.update({
    where: { id: importId },
    data: { status: 'EXTRACTING', extractionStartedAt: now, failureReason: null },
  });

  let result: MenuExtractionResult;
  try {
    assertMenuAdapterAvailable(record.adapter);
    if (!getStorageAvailability().available) {
      throw new MenuExtractionError('Menu upload storage is unavailable.', 'ADAPTER_UNAVAILABLE');
    }
    const adapter = runtime.resolveAdapter(record.adapter);
    const content = await runtime.readSource(record.organizationId, record.storageObjectName);
    result = await adapter.extract({
      content,
      mimeType: record.mimeType as MenuUploadMimeType,
      pageCount: record.pageCount,
      defaultCurrency: record.defaultCurrency,
      importId: record.id,
      signal: options.signal,
    });
  } catch (error) {
    // A transient provider failure must go back on the queue; a misconfigured
    // provider or an unparseable response must not burn retries on something
    // that cannot succeed without a human.
    const transient = !(error instanceof MenuExtractionError) || error.reason === 'PROVIDER_FAILED';
    if (transient) throw error;

    await db.restaurantMenuImport.update({
      where: { id: importId },
      data: {
        status: 'EXTRACTION_FAILED',
        failureReason: error.message.slice(0, 500),
        extractionCompletedAt: now,
      },
    });
    return { importId, status: 'EXTRACTION_FAILED', lineCount: 0 };
  }

  const lineCount = await runImportTransaction(db, async (tx) => {
    const count = await persistExtraction(tx, importId, result);
    await tx.restaurantMenuImport.update({
      where: { id: importId },
      data: {
        status: 'AWAITING_REVIEW',
        adapterVersion: result.adapterVersion,
        extractionCompletedAt: now,
        failureReason: null,
      },
    });
    return count;
  });

  return { importId, status: 'AWAITING_REVIEW', lineCount };
}

/** Build the registered job handler, with the runtime injectable for tests. */
export function createMenuImportExtractHandler(runtime?: MenuImportRuntime): RestaurantJobHandler {
  return async ({ db, job }: RestaurantJobContext) => {
    const payload = EXTRACT_PAYLOAD.parse(job.payload);
    if (await isDemoTenant(db)) return;
    await runMenuImportExtraction(db, payload.importId, { runtime });
  };
}

export const menuImportExtractHandler = createMenuImportExtractHandler();

// ── Review ────────────────────────────────────────────────────────────────────

export type ReviewDecision = 'ACCEPTED' | 'REJECTED' | 'MERGED';

export type ReviewLineInput = {
  lineId: string;
  decision: ReviewDecision;
  reviewedById: string;
  /** Corrections. `undefined` leaves a field alone; `null` clears an override. */
  categoryName?: string | null;
  productName?: string | null;
  description?: string | null;
  priceAmount?: string | null;
  currency?: string | null;
  note?: string | null;
  /** Required for MERGED, forbidden otherwise. */
  mergeProductId?: string | null;
  mergeVariantId?: string | null;
  /**
   * The sizes exactly as the reviewer confirmed them. `undefined` keeps any
   * earlier confirmation; `[]` confirms the line has no sizes. Accepting a line
   * whose extraction found sizes requires a confirmation, because commit never
   * imports unconfirmed OCR size prices.
   */
  variants?: Array<{ name: string; priceAmount: string | null }>;
};

const PRICE_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
const MAX_REVIEWED_VARIANTS = 20;

/** Validate reviewer-confirmed sizes into the stored `extractedVariants` shape. */
function normalizeReviewedVariants(
  variants: Array<{ name: string; priceAmount: string | null }>,
  extracted: Array<{ name: string; amount: string | null; currency: string | null }>
): Array<{ name: string; price: { amount: string | null; currency: string | null; raw: null } }> {
  if (variants.length > MAX_REVIEWED_VARIANTS) {
    throw new MenuImportError(
      `A line can carry at most ${MAX_REVIEWED_VARIANTS} sizes.`,
      'INVALID'
    );
  }
  const seen = new Set<string>();
  return variants.map((variant) => {
    const name = variant.name?.trim().slice(0, 120) ?? '';
    if (!name) {
      throw new MenuImportError('Every confirmed size needs a name.', 'INVALID');
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new MenuImportError(`The size "${name}" is listed twice.`, 'INVALID');
    }
    seen.add(key);
    const raw = variant.priceAmount?.trim() ?? '';
    if (raw !== '' && !PRICE_PATTERN.test(raw)) {
      throw new MenuImportError('A size price must be a positive decimal amount.', 'INVALID');
    }
    const amount = raw === '' ? null : new Prisma.Decimal(raw);
    // Re-confirming the printed figure keeps the printed currency, so confirming
    // a foreign size price is never a silent relabel into the line's currency.
    // A genuinely new figure is in the line's confirmed currency (null =
    // inherit); commit re-checks both against the organization currency.
    const printed = extracted.find((size) => size.name.trim().toLowerCase() === key);
    const keepsPrinted =
      amount !== null &&
      printed?.amount != null &&
      amount.equals(new Prisma.Decimal(printed.amount));
    return {
      name,
      price: {
        amount: amount === null ? null : amount.toFixed(2),
        currency: keepsPrinted ? (printed?.currency?.toUpperCase() ?? null) : null,
        raw: null,
      },
    };
  });
}

function trimmedOrNull(value: string | null | undefined, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Record one reviewer decision. Accept, edit-then-accept, reject and
 * merge-into-existing are the same call: the decision is the verb and the
 * optional fields are the edit, which keeps the four review actions from
 * drifting into four subtly different write paths.
 */
export async function reviewMenuImportLine(
  db: ScopedDb,
  input: ReviewLineInput,
  now: Date = new Date()
) {
  if (!input.reviewedById?.trim()) {
    throw new MenuImportError('A review decision needs a reviewer.', 'INVALID');
  }

  const line = await db.restaurantMenuImportLine.findUnique({
    where: { id: input.lineId },
    select: {
      id: true,
      importId: true,
      extractedProductName: true,
      extractedPriceAmount: true,
      extractedCurrency: true,
      reviewedPriceAmount: true,
      reviewedCurrency: true,
      extractedVariants: true,
      reviewedVariants: true,
      import: { select: { status: true } },
    },
  });
  if (!line) {
    throw new MenuImportError('The import line does not exist.', 'NOT_FOUND');
  }
  if (line.import.status !== 'AWAITING_REVIEW') {
    throw new MenuImportError(
      `An import in ${line.import.status} is not open for review.`,
      'INVALID_STATE'
    );
  }

  const productName = trimmedOrNull(input.productName, 200);
  const categoryName = trimmedOrNull(input.categoryName, 200);
  const description = trimmedOrNull(input.description, 2_000);
  const note = trimmedOrNull(input.note, 1_000);
  const currency = trimmedOrNull(input.currency, 3)?.toUpperCase();

  let priceAmount: Prisma.Decimal | null | undefined;
  if (input.priceAmount !== undefined) {
    if (input.priceAmount === null || input.priceAmount.trim() === '') {
      priceAmount = null;
    } else {
      if (!PRICE_PATTERN.test(input.priceAmount.trim())) {
        throw new MenuImportError('The price must be a positive decimal amount.', 'INVALID');
      }
      priceAmount = new Prisma.Decimal(input.priceAmount.trim());
    }
  }

  // An amount is confirmed in a specific currency. When this review changes the
  // line's currency without supplying a genuinely new amount (omitted, or the
  // same figure that was already on the line, e.g. the editor's prepopulated
  // value), the earlier amount is a relabel, not a conversion. Drop the reviewed
  // amount so commit falls back to the extracted figure and its currency checks,
  // which demand a fresh conversion for a foreign price.
  const previousCurrency = (line.reviewedCurrency ?? line.extractedCurrency)?.toUpperCase() ?? null;
  const nextCurrency =
    currency === undefined
      ? previousCurrency
      : (currency ?? line.extractedCurrency?.toUpperCase() ?? null);
  if (nextCurrency !== previousCurrency) {
    const previousAmount = line.reviewedPriceAmount ?? line.extractedPriceAmount;
    const isFreshAmount =
      priceAmount !== undefined &&
      priceAmount !== null &&
      (previousAmount === null || !priceAmount.equals(previousAmount));
    if (!isFreshAmount) {
      priceAmount = null;
    }
  }

  const reviewedVariants =
    input.variants === undefined
      ? undefined
      : normalizeReviewedVariants(input.variants, resolveVariants(line.extractedVariants));
  const variantsUpdate =
    reviewedVariants === undefined
      ? {}
      : { reviewedVariants: reviewedVariants as unknown as Prisma.InputJsonValue };

  if (input.decision === 'MERGED') {
    const mergeProductId = input.mergeProductId?.trim();
    if (!mergeProductId) {
      throw new MenuImportError(
        'Merging into an existing product needs a target product.',
        'INVALID'
      );
    }
    // Resolved through the tenant-scoped client, so a target from another
    // organization simply does not exist here (the composite FK is the floor
    // under this, not the only check).
    const product = await db.restaurantProduct.findUnique({
      where: { id: mergeProductId },
      select: { id: true },
    });
    if (!product) {
      throw new MenuImportError(
        'The merge target product does not exist.',
        'MERGE_TARGET_NOT_FOUND'
      );
    }
    const mergeVariantId = input.mergeVariantId?.trim() || null;
    if (mergeVariantId) {
      const variant = await db.restaurantProductVariant.findUnique({
        where: { id: mergeVariantId },
        select: { id: true, productId: true },
      });
      if (!variant || variant.productId !== mergeProductId) {
        throw new MenuImportError(
          'The merge target variant does not belong to the target product.',
          'MERGE_TARGET_NOT_FOUND'
        );
      }
    }

    return db.restaurantMenuImportLine.update({
      where: { id: input.lineId },
      data: {
        reviewStatus: 'MERGED',
        reviewedById: input.reviewedById,
        reviewedAt: now,
        mergeProductId,
        mergeVariantId,
        ...(categoryName !== undefined ? { reviewedCategoryName: categoryName } : {}),
        ...(productName !== undefined ? { reviewedProductName: productName } : {}),
        ...(description !== undefined ? { reviewedDescription: description } : {}),
        ...(priceAmount !== undefined ? { reviewedPriceAmount: priceAmount } : {}),
        ...(currency !== undefined ? { reviewedCurrency: currency } : {}),
        ...(note !== undefined ? { reviewNote: note } : {}),
        ...variantsUpdate,
      },
    });
  }

  if (input.mergeProductId || input.mergeVariantId) {
    throw new MenuImportError('A merge target only applies to a MERGED decision.', 'INVALID');
  }

  if (input.decision === 'ACCEPTED') {
    // An accepted line must be importable on its own terms: a name to create the
    // product under and a price to put on the draft version. This is where a
    // blurred or price-less OCR row is forced back to a human rather than
    // becoming a product with an invented price.
    const effectiveName = productName ?? line.extractedProductName;
    if (!effectiveName) {
      throw new MenuImportError(
        'Accepting a line needs a product name; supply one to correct the extraction.',
        'INVALID'
      );
    }
    const effectivePrice = priceAmount ?? line.extractedPriceAmount;
    if (effectivePrice === null || effectivePrice === undefined) {
      throw new MenuImportError(
        'Accepting a line needs a price; the menu did not state one.',
        'PRICE_REQUIRED'
      );
    }
    // Sizes are prices too. When the menu showed sizes, the reviewer must have
    // seen and confirmed each one; approving the base line alone is not consent
    // to OCR size prices.
    const confirmed = reviewedVariants ?? line.reviewedVariants;
    if (resolveVariants(line.extractedVariants).length > 0 && confirmed === null) {
      throw new MenuImportError(
        'Accepting a line with sizes needs every size name and price confirmed.',
        'VARIANTS_REVIEW_REQUIRED'
      );
    }
  }

  return db.restaurantMenuImportLine.update({
    where: { id: input.lineId },
    data: {
      reviewStatus: input.decision,
      reviewedById: input.reviewedById,
      reviewedAt: now,
      mergeProductId: null,
      mergeVariantId: null,
      ...(categoryName !== undefined ? { reviewedCategoryName: categoryName } : {}),
      ...(productName !== undefined ? { reviewedProductName: productName } : {}),
      ...(description !== undefined ? { reviewedDescription: description } : {}),
      ...(priceAmount !== undefined ? { reviewedPriceAmount: priceAmount } : {}),
      ...(currency !== undefined ? { reviewedCurrency: currency } : {}),
      ...(note !== undefined ? { reviewNote: note } : {}),
      ...variantsUpdate,
    },
  });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Serialize a Decimal for tRPC transport (the M3 `.toString()` convention). */
function decimalString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

export async function listMenuImports(db: ScopedDb, options: { limit?: number } = {}) {
  const rows = await db.restaurantMenuImport.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    select: {
      id: true,
      status: true,
      adapter: true,
      adapterVersion: true,
      fileName: true,
      mimeType: true,
      byteSize: true,
      pageCount: true,
      failureReason: true,
      sourceDeletedAt: true,
      createdById: true,
      createdAt: true,
      committedAt: true,
      committedMenuId: true,
      committedPriceListVersionId: true,
      _count: { select: { lines: true } },
    },
  });
  return rows.map(({ _count, ...row }) => ({ ...row, lineCount: _count.lines }));
}

export async function getMenuImport(db: ScopedDb, importId: string) {
  const record = await db.restaurantMenuImport.findUnique({
    where: { id: importId },
    include: {
      pages: {
        orderBy: { pageNumber: 'asc' },
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
      },
    },
  });
  if (!record) {
    throw new MenuImportError('The menu import does not exist.', 'NOT_FOUND');
  }

  return {
    ...record,
    pages: record.pages.map((page) => ({
      ...page,
      lines: page.lines.map((line) => ({
        ...line,
        extractedPriceAmount: decimalString(line.extractedPriceAmount),
        reviewedPriceAmount: decimalString(line.reviewedPriceAmount),
      })),
    })),
  };
}

/** The review-progress summary the console needs to enable or block "Import". */
export async function summarizeMenuImport(db: ScopedDb, importId: string) {
  const grouped = await db.restaurantMenuImportLine.groupBy({
    by: ['reviewStatus'],
    where: { importId },
    _count: { _all: true },
  });
  const counts = { PENDING: 0, ACCEPTED: 0, REJECTED: 0, MERGED: 0 };
  for (const row of grouped) counts[row.reviewStatus] += row._count._all;

  const flagged = await db.restaurantMenuImportLine.count({
    where: { importId, flags: { hasSome: ['SUSPECTED_INJECTION', 'LOW_CONFIDENCE'] } },
  });

  return {
    ...counts,
    total: counts.PENDING + counts.ACCEPTED + counts.REJECTED + counts.MERGED,
    flagged,
    readyToCommit: counts.PENDING === 0 && counts.ACCEPTED + counts.MERGED > 0,
    lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
  };
}

// ── Commit ────────────────────────────────────────────────────────────────────

/** What a reviewed line resolves to once the human's edits win over the OCR. */
type ResolvedLine = {
  id: string;
  decision: 'ACCEPTED' | 'MERGED';
  categoryName: string | null;
  productName: string;
  description: string | null;
  price: Prisma.Decimal;
  mergeProductId: string | null;
  mergeVariantId: string | null;
  variants: Array<{ name: string; amount: string | null; currency: string | null }>;
  sortOrder: number;
};

const VARIANT_SHAPE = z.array(
  z.object({
    name: z.string(),
    price: z
      .object({ amount: z.string().nullable(), currency: z.string().nullable() })
      .partial()
      .passthrough(),
  })
);

function resolveVariants(
  raw: Prisma.JsonValue
): Array<{ name: string; amount: string | null; currency: string | null }> {
  const parsed = VARIANT_SHAPE.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.map((variant) => ({
    name: variant.name,
    amount: variant.price?.amount ?? null,
    currency: variant.price?.currency ?? null,
  }));
}

export type CommitMenuImportInput = {
  importId: string;
  committedById: string;
  /** Name for the DRAFT menu the import creates. */
  menuName?: string;
  /** When the draft price-list version becomes effective if someone activates it. */
  effectiveFrom?: Date;
};

export type CommitMenuImportResult = {
  importId: string;
  /** True when the import had already been committed and nothing was re-created. */
  alreadyCommitted: boolean;
  menuId: string;
  priceListVersionId: string;
  createdProductIds: string[];
  createdCategoryIds: string[];
  mergedProductIds: string[];
  priceEntryIds: string[];
};

/**
 * Turn the confirmed rows into catalog records, in ONE transaction.
 *
 * Everything created here is inert: products and categories are canonical rows,
 * the menu has no branch publication, and the price-list version stays DRAFT. A
 * restaurant reviews the result and publishes it through the existing M3
 * surfaces — this function never puts a price in front of a customer.
 */
export async function commitMenuImport(
  db: ScopedDb,
  input: CommitMenuImportInput,
  options: { runtime?: MenuImportRuntime; now?: Date } = {}
): Promise<CommitMenuImportResult> {
  const runtime = options.runtime ?? defaultMenuImportRuntime;
  const now = options.now ?? new Date();

  if (!input.committedById?.trim()) {
    throw new MenuImportError('Committing an import needs an approving user.', 'INVALID');
  }

  const result = await runImportTransaction(db, async (tx) => {
    // Lock the import row for the duration: two reviewers pressing Import at the
    // same moment must not each build a menu.
    await tx.$queryRaw`SELECT "id" FROM "restaurant_menu_imports" WHERE "id" = ${input.importId} FOR UPDATE`;

    const record = await tx.restaurantMenuImport.findUnique({
      where: { id: input.importId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        fileName: true,
        storageObjectName: true,
        committedMenuId: true,
        committedPriceListVersionId: true,
      },
    });
    if (!record) {
      throw new MenuImportError('The menu import does not exist.', 'NOT_FOUND');
    }

    // Idempotent replay: report the recorded evidence, create nothing.
    if (record.status === 'COMMITTED') {
      const committed = await tx.restaurantMenuImportLine.findMany({
        where: { importId: record.id },
        select: {
          reviewStatus: true,
          committedProductId: true,
          committedCategoryId: true,
          committedPriceEntryId: true,
          mergeProductId: true,
        },
      });
      return {
        importId: record.id,
        alreadyCommitted: true,
        menuId: record.committedMenuId ?? '',
        priceListVersionId: record.committedPriceListVersionId ?? '',
        createdProductIds: committed
          .filter((line) => line.reviewStatus === 'ACCEPTED')
          .map((line) => line.committedProductId)
          .filter(Boolean) as string[],
        createdCategoryIds: [
          ...new Set(committed.map((line) => line.committedCategoryId).filter(Boolean)),
        ] as string[],
        mergedProductIds: committed
          .filter((line) => line.reviewStatus === 'MERGED')
          .map((line) => line.mergeProductId)
          .filter(Boolean) as string[],
        priceEntryIds: committed
          .map((line) => line.committedPriceEntryId)
          .filter(Boolean) as string[],
        storageObjectName: record.storageObjectName,
        organizationId: record.organizationId,
      };
    }

    if (record.status !== 'AWAITING_REVIEW') {
      throw new MenuImportError(
        `An import in ${record.status} cannot be imported.`,
        'INVALID_STATE'
      );
    }

    // Share-lock the organization row before reading its currency. A platform
    // currency UPDATE conflicts with FOR SHARE, so it either completes before
    // this read or waits until all imported prices commit. FOR SHARE (unlike
    // FOR UPDATE) does not conflict with the FOR KEY SHARE locks taken by
    // foreign-key inserts, so the tenant's other writes (orders, payments) are
    // not blocked for the length of a large commit. The upload-time default
    // remains extraction context only.
    const [organization] = await tx.$queryRaw<Array<{ currency: string | null }>>`
      SELECT "currency"
      FROM "organizations"
      WHERE "id" = ${record.organizationId}
      FOR SHARE
    `;
    const tenantCurrency = organization?.currency?.toUpperCase() ?? null;

    const lines = await tx.restaurantMenuImportLine.findMany({
      where: { importId: record.id },
      orderBy: [{ pageId: 'asc' }, { sortOrder: 'asc' }],
      select: {
        id: true,
        reviewStatus: true,
        sortOrder: true,
        extractedCategoryName: true,
        extractedProductName: true,
        extractedDescription: true,
        extractedPriceAmount: true,
        extractedCurrency: true,
        extractedVariants: true,
        reviewedVariants: true,
        reviewedCategoryName: true,
        reviewedProductName: true,
        reviewedDescription: true,
        reviewedPriceAmount: true,
        reviewedCurrency: true,
        mergeProductId: true,
        mergeVariantId: true,
      },
    });

    // HUMAN REVIEW MANDATORY — the gate the whole feature rests on.
    const pending = lines.filter((line) => line.reviewStatus === 'PENDING');
    if (pending.length > 0) {
      throw new MenuImportError(
        `${pending.length} line(s) still need a review decision.`,
        'REVIEW_INCOMPLETE'
      );
    }

    const resolved: ResolvedLine[] = [];
    for (const line of lines) {
      if (line.reviewStatus === 'REJECTED') continue;
      const productName = line.reviewedProductName ?? line.extractedProductName;
      const price = line.reviewedPriceAmount ?? line.extractedPriceAmount;
      if (!productName || price === null) {
        // `reviewMenuImportLine` refuses to accept such a line, so reaching here
        // means the row was written around the domain. Fail the whole commit.
        throw new MenuImportError(
          'A confirmed line is missing a product name or price.',
          'REVIEW_INCOMPLETE'
        );
      }
      const extractedCurrency = line.extractedCurrency?.toUpperCase() ?? null;
      const reviewedCurrency = line.reviewedCurrency?.toUpperCase() ?? null;
      const priceCurrency = reviewedCurrency ?? extractedCurrency;
      const extractedIsForeign = extractedCurrency !== null && extractedCurrency !== tenantCurrency;
      // A foreign extracted price is acceptable only when the reviewer typed an
      // amount in the organization currency; relabelling alone is not a conversion.
      const hasReviewedConversion =
        reviewedCurrency === tenantCurrency && line.reviewedPriceAmount !== null;
      if (
        !tenantCurrency ||
        priceCurrency !== tenantCurrency ||
        (extractedIsForeign && !hasReviewedConversion)
      ) {
        throw new MenuImportError(
          'Every confirmed price must agree with the organization currency, or include an explicitly reviewed conversion.',
          'CURRENCY_MISMATCH'
        );
      }
      // Merges write only the reviewed base price to the chosen catalog target;
      // sizes are imported only when creating a new product, and only as the
      // reviewer confirmed them — never straight from the OCR extraction.
      if (
        line.reviewStatus === 'ACCEPTED' &&
        line.reviewedVariants === null &&
        resolveVariants(line.extractedVariants).length > 0
      ) {
        throw new MenuImportError(
          'An accepted line has extracted sizes nobody confirmed; review its sizes again.',
          'REVIEW_INCOMPLETE'
        );
      }
      const variants =
        line.reviewStatus === 'MERGED' ? [] : resolveVariants(line.reviewedVariants ?? []);
      // Menus often print one currency for a whole line ("Small 500 / Large 800"),
      // so a size price with no currency of its own inherits the line's confirmed
      // currency (already verified equal to the organization's above). This never
      // applies when the extracted base price was foreign: those sizes are most
      // likely in the same foreign currency and the reviewer converted only the base.
      const inheritedVariantCurrency = extractedIsForeign ? null : priceCurrency;
      if (
        variants.some(
          (variant) =>
            variant.amount !== null &&
            (variant.currency?.toUpperCase() ?? inheritedVariantCurrency) !== tenantCurrency
        )
      ) {
        throw new MenuImportError(
          'Every priced variant must agree with the organization currency.',
          'CURRENCY_MISMATCH'
        );
      }
      resolved.push({
        id: line.id,
        decision: line.reviewStatus === 'MERGED' ? 'MERGED' : 'ACCEPTED',
        categoryName: line.reviewedCategoryName ?? line.extractedCategoryName,
        productName,
        description: line.reviewedDescription ?? line.extractedDescription,
        price,
        mergeProductId: line.mergeProductId,
        mergeVariantId: line.mergeVariantId,
        variants,
        sortOrder: line.sortOrder,
      });
    }

    if (resolved.length === 0) {
      throw new MenuImportError(
        'Every line was rejected, so there is nothing to import.',
        'NOTHING_TO_IMPORT'
      );
    }

    // ── Catalog scaffolding ──────────────────────────────────────────────────
    const brand = await ensureDefaultBrand(tx);

    const categoryByKey = new Map<string, string>();
    for (const category of await tx.restaurantCategory.findMany({
      select: { id: true, name: true },
    })) {
      const key = normalizeProductKey(category.name);
      if (key && !categoryByKey.has(key)) categoryByKey.set(key, category.id);
    }
    const createdCategoryIds: string[] = [];
    async function resolveCategory(name: string | null): Promise<string | null> {
      const key = normalizeProductKey(name);
      if (!name || !key) return null;
      const existing = categoryByKey.get(key);
      if (existing) return existing;
      const created = await createCategory(tx, { name });
      categoryByKey.set(key, created.id);
      createdCategoryIds.push(created.id);
      return created.id;
    }

    const menu = await createMenu(tx, {
      brandId: brand.id,
      name: (input.menuName?.trim() || `Imported menu — ${record.fileName}`).slice(0, 200),
      description: `Created by menu import ${record.id}.`,
    });

    // The base price list, reused when one exists. Created directly rather than
    // via `createPriceList` because that helper opens its own transaction.
    let priceList = await tx.restaurantPriceList.findFirst({ where: { isDefault: true } });
    priceList ??= await tx.restaurantPriceList.create({
      data: { name: 'Base Price List', isDefault: true },
    });
    const version = await createPriceListVersion(tx, {
      priceListId: priceList.id,
      effectiveFrom: input.effectiveFrom ?? now,
    });

    const sectionByCategory = new Map<string, string>();
    async function resolveSection(categoryId: string | null, label: string): Promise<string> {
      const key = categoryId ?? '__uncategorized__';
      const existing = sectionByCategory.get(key);
      if (existing) return existing;
      const section = await createMenuSection(tx, {
        menuId: menu.id,
        name: label,
        sortOrder: sectionByCategory.size,
      });
      sectionByCategory.set(key, section.id);
      return section.id;
    }

    const createdProductIds: string[] = [];
    const mergedProductIds: string[] = [];
    const priceEntryIds: string[] = [];

    for (const line of resolved) {
      const categoryId = await resolveCategory(line.categoryName);
      const sectionId = await resolveSection(categoryId, line.categoryName ?? 'Uncategorized');

      let productId: string;
      let variantId: string | null = null;
      let createdVariantId: string | null = null;

      if (line.decision === 'MERGED') {
        // Merge reuses the existing product untouched: an import must not
        // silently rewrite a dish a restaurant has already curated. It
        // contributes a menu placement and a draft price, nothing else.
        productId = line.mergeProductId!;
        variantId = line.mergeVariantId;
        mergedProductIds.push(productId);
      } else {
        const product = await createProduct(tx, {
          name: line.productName,
          description: line.description,
          categoryId,
          sortOrder: line.sortOrder,
        });
        productId = product.id;
        createdProductIds.push(product.id);

        // Sizes become real variants, each with its own draft price, so
        // "Small / Medium / Large" does not collapse into one price.
        let variantIndex = 0;
        for (const variant of line.variants) {
          const created = await createVariant(tx, {
            productId,
            name: variant.name,
            sortOrder: variantIndex,
          });
          createdVariantId ??= created.id;
          if (variant.amount !== null) {
            const entry = await addPriceListEntry(tx, {
              priceListVersionId: version.id,
              productId,
              variantId: created.id,
              price: variant.amount,
            });
            priceEntryIds.push(entry.id);
          }
          await createMenuItem(tx, {
            sectionId,
            productId,
            variantId: created.id,
            sortOrder: variantIndex,
          });
          variantIndex += 1;
        }
      }

      // The base (no-variant) price and menu placement. A merged line places the
      // existing product; an accepted line places the new one alongside any
      // variant rows created above.
      const entry = await addPriceListEntry(tx, {
        priceListVersionId: version.id,
        productId,
        variantId,
        price: line.price,
      });
      priceEntryIds.push(entry.id);

      const item = await createMenuItem(tx, {
        sectionId,
        productId,
        variantId,
        sortOrder: line.sortOrder,
      });

      await tx.restaurantMenuImportLine.update({
        where: { id: line.id },
        data: {
          committedCategoryId: categoryId,
          committedProductId: line.decision === 'ACCEPTED' ? productId : null,
          committedVariantId: variantId ?? createdVariantId,
          committedMenuItemId: item.id,
          committedPriceEntryId: entry.id,
        },
      });
    }

    await tx.restaurantMenuImport.update({
      where: { id: record.id },
      data: {
        status: 'COMMITTED',
        committedAt: now,
        committedById: input.committedById,
        committedMenuId: menu.id,
        committedPriceListVersionId: version.id,
      },
    });

    return {
      importId: record.id,
      alreadyCommitted: false,
      menuId: menu.id,
      priceListVersionId: version.id,
      createdProductIds,
      createdCategoryIds,
      mergedProductIds,
      priceEntryIds,
      storageObjectName: record.storageObjectName,
      organizationId: record.organizationId,
    };
  });

  // Retention: the source file exists so a reviewer can compare against it. Once
  // the import is decided, that need is gone. Deleted AFTER the transaction
  // commits — an object store is not transactional, and losing the file while
  // the database rolls back would strand a review with nothing to look at.
  const { storageObjectName, organizationId, ...payload } = result;
  if (storageObjectName) {
    await runtime.afterBoundary?.('committed-before-delete', input.importId);
    await forgetSource(db, organizationId, input.importId, storageObjectName, runtime, now);
  }

  return payload;
}

/** Delete a stored source and record that the retention obligation is discharged. */
async function forgetSource(
  db: ScopedDb,
  organizationId: string,
  importId: string,
  objectName: string,
  runtime: MenuImportRuntime,
  now: Date
): Promise<void> {
  await runtime.deleteSource(organizationId, objectName);
  await runtime.afterBoundary?.('source-deleted', importId);
  await db.restaurantMenuImport.update({
    where: { id: importId },
    data: { storageObjectName: null, sourceDeletedAt: now },
  });
}

// ── Discard and retention ─────────────────────────────────────────────────────

/**
 * Abandon an import. The review rows are kept as the record of what was seen and
 * declined; only the uploaded file goes, because retaining a customer's menu
 * image past the decision serves nobody.
 */
export async function discardMenuImport(
  db: ScopedDb,
  importId: string,
  discardedById: string,
  options: { runtime?: MenuImportRuntime; now?: Date } = {}
) {
  const runtime = options.runtime ?? defaultMenuImportRuntime;
  const now = options.now ?? new Date();

  const record = await db.restaurantMenuImport.findUnique({
    where: { id: importId },
    select: { id: true, organizationId: true, status: true, storageObjectName: true },
  });
  if (!record) {
    throw new MenuImportError('The menu import does not exist.', 'NOT_FOUND');
  }
  if (record.status === 'COMMITTED') {
    throw new MenuImportError('A committed import cannot be discarded.', 'INVALID_STATE');
  }
  if (record.status === 'DISCARDED') {
    if (record.storageObjectName) {
      await forgetSource(
        db,
        record.organizationId,
        importId,
        record.storageObjectName,
        runtime,
        now
      );
    }
    return { importId, alreadyDiscarded: true };
  }

  await db.restaurantMenuImport.update({
    where: { id: importId },
    data: { status: 'DISCARDED', discardedAt: now, discardedById },
  });
  if (record.storageObjectName) {
    await forgetSource(db, record.organizationId, importId, record.storageObjectName, runtime, now);
  }
  return { importId, alreadyDiscarded: false };
}

export type PurgeResult = { purgedDrafts: number; deletedSources: number };

/**
 * Retention sweep. Drafts abandoned mid-review are deleted outright after
 * {@link MENU_IMPORT_DRAFT_TTL_DAYS}; decided imports keep their ids-only
 * evidence rows but lose any source file still on disk.
 *
 * Idempotent, so it is safe to run on a schedule and safe to run twice.
 */
export async function purgeStaleMenuImports(
  db: ScopedDb,
  options: { runtime?: MenuImportRuntime; now?: Date } = {}
): Promise<PurgeResult> {
  const runtime = options.runtime ?? defaultMenuImportRuntime;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - MENU_IMPORT_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1_000);

  const stale = await db.restaurantMenuImport.findMany({
    where: { createdAt: { lt: cutoff }, status: { in: [...OPEN_STATUSES, 'EXTRACTION_FAILED'] } },
    select: { id: true, organizationId: true, storageObjectName: true },
  });

  let deletedSources = 0;
  let purgedDrafts = 0;
  for (const record of stale) {
    const deletedSource = await runImportTransaction(db, async (tx) => {
      // Serialize with commit, then recheck the lifecycle state after taking the
      // lock: the initial retention query may have raced with a reviewer.
      await tx.$queryRaw`SELECT "id" FROM "restaurant_menu_imports" WHERE "id" = ${record.id} AND "organizationId" = ${record.organizationId} FOR UPDATE`;
      const current = await tx.restaurantMenuImport.findUnique({
        where: { id: record.id, organizationId: record.organizationId },
        select: {
          organizationId: true,
          status: true,
          storageObjectName: true,
          createdAt: true,
        },
      });
      if (
        !current ||
        current.createdAt >= cutoff ||
        !([...OPEN_STATUSES, 'EXTRACTION_FAILED'] as string[]).includes(current.status)
      ) {
        return false;
      }

      if (current.storageObjectName) {
        await runtime.deleteSource(current.organizationId, current.storageObjectName);
      }
      // An abandoned draft has no evidentiary value — it records only that
      // somebody uploaded a file and never came back. Pages and lines cascade.
      await tx.restaurantMenuImport.delete({
        where: { id: record.id, organizationId: record.organizationId },
      });
      purgedDrafts += 1;
      return Boolean(current.storageObjectName);
    });
    if (deletedSource) deletedSources += 1;
  }

  // Decided imports keep their rows but must not keep the customer's file.
  const orphanedSources = await db.restaurantMenuImport.findMany({
    where: {
      storageObjectName: { not: null },
      status: { in: ['COMMITTED', 'DISCARDED'] },
    },
    select: { id: true, organizationId: true, storageObjectName: true },
  });
  for (const record of orphanedSources) {
    await forgetSource(
      db,
      record.organizationId,
      record.id,
      record.storageObjectName!,
      runtime,
      now
    );
    deletedSources += 1;
  }

  return { purgedDrafts, deletedSources };
}
