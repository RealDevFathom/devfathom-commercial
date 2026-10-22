import { z } from '@/lib/zod-csp';

export type ActiveSaleScope = { organizationId: string; accountId: string };
export type ActiveSalePointer = ActiveSaleScope & { branchId: string; saleId: string };

const id = z.string().trim().min(1).max(128);
const pointerSchema = z
  .object({
    version: z.literal(1),
    organizationId: id,
    accountId: id,
    branchId: id,
    saleId: id,
  })
  .strict();

export function activeSaleStorageKey(scope: ActiveSaleScope): string {
  const parsed = z.object({ organizationId: id, accountId: id }).strict().parse(scope);
  return `devfathom.pharmacy.counter.active:${JSON.stringify([
    parsed.organizationId,
    parsed.accountId,
  ])}`;
}

/** Read only the authenticated operator's pointer; sale access is still verified by the API. */
export function readActiveSale(scope: ActiveSaleScope): ActiveSalePointer | null {
  try {
    const raw = window.localStorage.getItem(activeSaleStorageKey(scope));
    if (raw === null || raw.length > 1024) return null;
    const parsed = pointerSchema.parse(JSON.parse(raw));
    if (
      parsed.organizationId !== scope.organizationId ||
      parsed.accountId !== scope.accountId
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function persistActiveSale(pointer: ActiveSalePointer): void {
  const parsed = pointerSchema.parse({ version: 1, ...pointer });
  window.localStorage.setItem(activeSaleStorageKey(pointer), JSON.stringify(parsed));
}

export function clearActiveSale(scope: ActiveSaleScope): void {
  window.localStorage.removeItem(activeSaleStorageKey(scope));
}
