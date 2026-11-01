/**
 * The one way a pharmacy branch is named on screen: its name and city, e.g.
 * "SehatCart Test Branch · Lahore". Counter, Inventory, Day close and the
 * cashier home all read it here so the same branch never shows two names.
 */
export function pharmacyBranchLabel(branch: { name: string; city?: string | null }): string {
  const city = branch.city?.trim();
  return city ? `${branch.name} · ${city}` : branch.name;
}
