import { z } from '@/lib/zod-csp';

/**
 * DEV-623: the bill open on this counter device, so a page reload, a closed tab
 * or a crash does not strand it (its lines keep stock allocated). Only the sale
 * id is kept; the server decides on load whether that bill is still OPEN.
 *
 * Scoped to the signed-in account and branch, in this browser's localStorage,
 * like the in-flight payment record. Storage that is blocked or unreadable only
 * loses the convenience: the bill stays listed under Open bills.
 */
export type ActiveBillScope = { organizationId: string; accountId: string; branchId: string };

const id = z.string().trim().min(1).max(128);
const scopeSchema = z.object({ organizationId: id, accountId: id, branchId: id }).strict();
const storedSchema = z.object({ version: z.literal(1), saleId: id }).strict();

export function activeBillStorageKey(scope: ActiveBillScope): string {
  const parsed = scopeSchema.parse(scope);
  return `devfathom.pharmacy.counter.activeBill:${JSON.stringify([
    parsed.organizationId,
    parsed.accountId,
    parsed.branchId,
  ])}`;
}

export function readActiveBill(scope: ActiveBillScope): string | null {
  try {
    const raw = window.localStorage.getItem(activeBillStorageKey(scope));
    if (raw === null || raw.length > 512) return null;
    return storedSchema.parse(JSON.parse(raw)).saleId;
  } catch {
    return null;
  }
}

/** Remembers `saleId` as this device's open bill, or forgets it when null. */
export function rememberActiveBill(scope: ActiveBillScope, saleId: string | null): void {
  try {
    const key = activeBillStorageKey(scope);
    if (saleId === null) window.localStorage.removeItem(key);
    else
      window.localStorage.setItem(key, JSON.stringify(storedSchema.parse({ version: 1, saleId })));
  } catch {
    // Blocked storage: the bill is still reachable from Open bills.
  }
}
