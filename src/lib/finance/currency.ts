/**
 * Per-currency money helpers (FIN-02).
 *
 * Money lives in two currencies in this app — USD and PKR — and they must NEVER
 * be `_sum`med into one scalar (that renders e.g. Rs 280,000 + $5,000 as
 * "$285,000", overstating ~47×). Every monetary aggregate groups BY currency and
 * flows through these helpers so the UI shows each currency on its own.
 */

export type CurrencyAmount = { currency: string; amount: number };

// USD first, then PKR, then anything else alphabetically — a stable display order.
const CURRENCY_ORDER = ['USD', 'PKR'];

const round2 = (n: number) => Math.round(n * 100) / 100;

export function sortCurrencies(rows: CurrencyAmount[]): CurrencyAmount[] {
  return [...rows].sort((a, b) => {
    const ia = CURRENCY_ORDER.indexOf(a.currency);
    const ib = CURRENCY_ORDER.indexOf(b.currency);
    const ra = ia === -1 ? CURRENCY_ORDER.length : ia;
    const rb = ib === -1 ? CURRENCY_ORDER.length : ib;
    return ra !== rb ? ra - rb : a.currency.localeCompare(b.currency);
  });
}

/** "$1,200" / "Rs 50,000" / "-$300" — symbol by currency, sign kept readable. */
export function moneyLabel(amount: number, currency: string): string {
  const sym = currency === 'PKR' ? 'Rs ' : '$';
  const abs = Math.abs(amount).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return amount < 0 ? `-${sym}${abs}` : `${sym}${abs}`;
}

/**
 * Render a list of per-currency amounts on one line, e.g. "$5,000 · Rs 280,000".
 * Zero-amount currencies are dropped; an all-empty list shows "$0" so a KPI is
 * never blank.
 */
export function moneyListLabel(rows: CurrencyAmount[]): string {
  const nonZero = rows.filter((r) => r.amount !== 0);
  const list = nonZero.length ? sortCurrencies(nonZero) : [{ currency: 'USD', amount: 0 }];
  return list.map((r) => moneyLabel(r.amount, r.currency)).join(' · ');
}

/**
 * Turn a Prisma `groupBy(['currency'], { _sum: { <field> } })` result into a
 * sorted CurrencyAmount[]. `field` is the summed column ("amount" or "total").
 */
export function fromCurrencyGroups(
  rows: Array<{ currency: string; _sum: Record<string, unknown> }>,
  field: string
): CurrencyAmount[] {
  return sortCurrencies(
    rows.map((r) => ({ currency: r.currency, amount: Number(r._sum?.[field] ?? 0) }))
  );
}

/** Sum any number of per-currency breakdowns into one (currencies merged). */
export function sumByCurrency(...lists: CurrencyAmount[][]): CurrencyAmount[] {
  const map = new Map<string, number>();
  for (const list of lists)
    for (const r of list) map.set(r.currency, (map.get(r.currency) ?? 0) + r.amount);
  return sortCurrencies(
    Array.from(map, ([currency, amount]) => ({ currency, amount: round2(amount) }))
  );
}

/** income − expense, per currency (currencies present in either side). */
export function diffByCurrency(
  income: CurrencyAmount[],
  expense: CurrencyAmount[]
): CurrencyAmount[] {
  const map = new Map<string, number>();
  for (const r of income) map.set(r.currency, (map.get(r.currency) ?? 0) + r.amount);
  for (const r of expense) map.set(r.currency, (map.get(r.currency) ?? 0) - r.amount);
  return sortCurrencies(
    Array.from(map, ([currency, amount]) => ({ currency, amount: round2(amount) }))
  );
}

// IMP-FIN-02 (FX): static approximate FX rates to USD. This is the convert-to-base
// half of multi-currency reporting; swap for a live FX feed in production. Per-
// currency figures remain authoritative — this only powers an "≈ $X" convenience.
const FX_TO_USD: Record<string, number> = { USD: 1, PKR: 1 / 280 };

/** Sum a per-currency breakdown into a single base-currency (default USD) total. */
export function convertToBase(rows: CurrencyAmount[], base = 'USD'): number {
  const baseRate = FX_TO_USD[base] ?? 1;
  return (
    Math.round(
      (rows.reduce((s, r) => s + r.amount * (FX_TO_USD[r.currency] ?? 0), 0) / baseRate) * 100
    ) / 100
  );
}

/** "≈ $12,300" base-currency equivalent — only meaningful across >1 currency. */
export function baseEquivalentLabel(rows: CurrencyAmount[], base = 'USD'): string | null {
  const present = new Set(rows.filter((r) => r.amount !== 0).map((r) => r.currency));
  if (present.size < 2) return null; // single currency → the per-currency label already says it
  return `≈ ${moneyLabel(convertToBase(rows, base), base)}`;
}

/** The currencies present in any of the given breakdowns, USD-first. */
export function currenciesPresent(...lists: CurrencyAmount[][]): string[] {
  const set = new Set<string>();
  for (const list of lists) for (const r of list) if (r.amount !== 0) set.add(r.currency);
  const ordered = sortCurrencies(Array.from(set, (currency) => ({ currency, amount: 1 })));
  return ordered.length ? ordered.map((r) => r.currency) : ['USD'];
}
