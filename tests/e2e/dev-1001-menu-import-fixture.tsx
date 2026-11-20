import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { RestaurantMenuImportConsole, type MenuImportSnapshot } from '@/components/restaurant/menu-import/menu-import-console';
type RouterOutputs=inferRouterOutputs<AppRouter>;type ImportDetail=RouterOutputs['restaurantMenuImport']['get'];type ImportSummary=RouterOutputs['restaurantMenuImport']['summary'];type ImportLine=ImportDetail['pages'][number]['lines'][number];
const INJECTION_TEXT='Example seasonal soup';
const now = new Date('2026-08-27T09:00:00.000Z');
function line(overrides: Partial<ImportLine> = {}): ImportLine {
  return {
    id: 'line_1',
    organizationId: 'org_1',
    importId: 'import_1',
    pageId: 'page_1',
    sortOrder: 0,
    extractedCategoryName: 'Mains',
    extractedProductName: 'Grilled Chicken',
    extractedDescription: 'Half chicken, charcoal grilled',
    extractedIngredients: [],
    extractedPriceAmount: '1250.00',
    extractedCurrency: 'PKR',
    extractedPriceRaw: 'Rs. 1250',
    extractedVariants: [],
    extractedModifiers: [],
    confidence: { productName: 0.94 },
    flags: [],
    matchKey: 'grilled chicken',
    reviewStatus: 'PENDING',
    reviewedCategoryName: null,
    reviewedProductName: null,
    reviewedDescription: null,
    reviewedPriceAmount: null,
    reviewedCurrency: null,
    reviewedVariants: null,
    reviewNote: null,
    mergeProductId: null,
    mergeVariantId: null,
    reviewedById: null,
    reviewedAt: null,
    committedCategoryId: null,
    committedProductId: null,
    committedVariantId: null,
    committedMenuItemId: null,
    committedPriceEntryId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
function detail(overrides: Partial<ImportDetail> = {}): ImportDetail {
  const base = {
    id: 'import_1',
    organizationId: 'org_1',
    status: 'AWAITING_REVIEW',
    adapter: 'FIXTURE',
    adapterVersion: '1',
    fileName: 'summer-menu.pdf',
    mimeType: 'application/pdf',
    byteSize: 2048,
    pageCount: 1,
    checksum: 'abc',
    storageObjectName: 'menu-imports/abc.pdf',
    sourceDeletedAt: null,
    defaultCurrency: 'PKR',
    idempotencyKey: 'key_1',
    extractionJobId: null,
    extractionStartedAt: now,
    extractionCompletedAt: now,
    failureReason: null,
    createdById: 'user_1',
    committedAt: null,
    committedById: null,
    committedMenuId: null,
    committedPriceListVersionId: null,
    discardedAt: null,
    discardedById: null,
    createdAt: now,
    updatedAt: now,
    pages: [
      {
        id: 'page_1',
        organizationId: 'org_1',
        importId: 'import_1',
        pageNumber: 1,
        warnings: [],
        createdAt: now,
        lines: [
          line(),
          line({
            id: 'line_2',
            sortOrder: 1,
            extractedProductName: INJECTION_TEXT,
            extractedPriceAmount: null,
            extractedCurrency: null,
            extractedPriceRaw: null,
            flags: ['SUSPECTED_INJECTION', 'MISSING_PRICE'],
          }),
          line({
            id: 'line_3',
            sortOrder: 2,
            extractedProductName: 'Mutton Karahi',
            reviewStatus: 'ACCEPTED',
            reviewedProductName: 'Mutton Karahi (1kg)',
            reviewedPriceAmount: '3200.00',
            reviewedCurrency: 'PKR',
            reviewNote: 'Price corrected from the printed insert',
            flags: ['LOW_CONFIDENCE'],
          }),
        ],
      },
    ],
  } as unknown as ImportDetail;
  return { ...base, ...overrides };
}
function summary(overrides: Partial<ImportSummary> = {}): ImportSummary {
  return {
    PENDING: 2,
    ACCEPTED: 1,
    REJECTED: 0,
    MERGED: 0,
    total: 3,
    flagged: 2,
    sizesUnconfirmed: 0,
    readyToCommit: false,
    lowConfidenceThreshold: 0.6,
    ...overrides,
  };
}
const snapshot: MenuImportSnapshot = {
  imports: [
    {
      id: 'import_1',
      status: 'AWAITING_REVIEW',
      adapter: 'FIXTURE',
      adapterVersion: '1',
      fileName: 'summer-menu.pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
      pageCount: 1,
      failureReason: null,
      sourceDeletedAt: null,
      createdById: 'user_1',
      createdAt: now.toISOString(),
      committedAt: null,
      committedMenuId: null,
      committedPriceListVersionId: null,
      lineCount: 3,
    },
  ],
  mergeCandidates: [
    {
      id: 'product_1',
      name: 'Chicken Karahi',
      variants: [{ id: 'variant_1', name: 'Full' }],
    },
  ],
};
export const menuImportScreen=<RestaurantMenuImportConsole snapshot={snapshot} canImport/>;
export const menuImportQueryData: Record<string,unknown>={'restaurantMenuImport.get':detail(),'restaurantMenuImport.summary':summary(),'restaurantMenuImport.uploadLimits':{available:true,explanation:null,maxBytes:10485760,allowedMimeTypes:['application/pdf','image/png']}};
