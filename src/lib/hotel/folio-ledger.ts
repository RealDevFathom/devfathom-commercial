import { z } from 'zod';

/** Money is deliberately absent: the server prices every posting. */
export const folioPostingInput = z
  .object({
    folioId: z.string().min(1),
    catalogItemId: z.string().min(1),
    quantity: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type FolioScope = Readonly<{ organizationId: string; propertyId: string }>;
export type CatalogPrice = Readonly<{ unitMinor: number; taxBasisPoints: number }>;

export function derivePostingMoney(price: CatalogPrice, quantity: number) {
  if (!Number.isSafeInteger(price.unitMinor) || price.unitMinor < 0)
    throw new Error('Invalid catalog price.');
  if (!Number.isInteger(price.taxBasisPoints) || price.taxBasisPoints < 0 || price.taxBasisPoints > 10_000)
    throw new Error('Invalid tax rate.');
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Invalid quantity.');
  const netMinor = price.unitMinor * quantity;
  if (!Number.isSafeInteger(netMinor)) throw new Error('Posting total is too large.');
  const taxMinor = Math.round((netMinor * price.taxBasisPoints) / 10_000);
  const grossMinor = netMinor + taxMinor;
  if (!Number.isSafeInteger(grossMinor)) throw new Error('Posting total is too large.');
  return { unitMinor: price.unitMinor, netMinor, taxMinor, grossMinor } as const;
}

/**
 * Narrow persistence port: every operation carries both tenant keys. This keeps
 * the service safe even when it is used with an elevated/background DB handle.
 */
export interface FolioLedgerStore<Row> {
  read(scope: FolioScope, folioId: string): Promise<Row | null>;
  readEntries(scope: FolioScope, folioId: string): Promise<readonly Row[]>;
  catalogPrice(scope: FolioScope, catalogItemId: string): Promise<CatalogPrice | null>;
  insert(
    scope: FolioScope,
    posting: { folioId: string; catalogItemId: string; quantity: number } & ReturnType<typeof derivePostingMoney>
  ): Promise<Row>;
  reverse(scope: FolioScope, entryId: string, reason: string): Promise<Row>;
}

type RequireFolio = (scope: FolioScope) => Promise<void>;

export function createFolioLedgerService<Row>(store: FolioLedgerStore<Row>, requireFolio: RequireFolio) {
  const authorize = async (scope: FolioScope) => {
    if (!scope.organizationId || !scope.propertyId) throw new Error('Property scope is required.');
    await requireFolio(scope);
  };
  return {
    async get(scope: FolioScope, folioId: string) {
      await authorize(scope);
      return store.read(scope, folioId);
    },
    async entries(scope: FolioScope, folioId: string) {
      await authorize(scope);
      return store.readEntries(scope, folioId);
    },
    async post(scope: FolioScope, unknownInput: unknown) {
      await authorize(scope);
      const input = folioPostingInput.parse(unknownInput);
      const price = await store.catalogPrice(scope, input.catalogItemId);
      if (!price) throw new Error('Catalog item is unavailable for this property.');
      return store.insert(scope, { ...input, ...derivePostingMoney(price, input.quantity) });
    },
    async reverse(scope: FolioScope, entryId: string, reason: string) {
      await authorize(scope);
      const cleanReason = z.string().trim().min(1).max(500).parse(reason);
      return store.reverse(scope, entryId, cleanReason);
    },
  };
}
