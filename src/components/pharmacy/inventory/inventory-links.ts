const INVENTORY_ROUTE = '/pharmacy/inventory';

/** The Physical count section of the inventory page, on the given working branch. */
export function inventoryCountsHref(branch?: string | string[] | null): string {
  const id = typeof branch === 'string' ? branch.trim() : '';
  return id
    ? `${INVENTORY_ROUTE}?${new URLSearchParams({ branch: id })}#counts`
    : `${INVENTORY_ROUTE}#counts`;
}
