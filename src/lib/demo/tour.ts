import { DEMO_SALES_SCRIPT, type DemoSalesScriptStep } from './sales-script';

export const DEMO_TOUR_STORAGE_KEY = 'devfathom:restaurant-demo-tour:v1';

export type DemoTourPreparation =
  'pos-modifiers' | 'floor-table' | 'bill-settlement' | 'daily-close' | 'recipe-lines';

export type DemoTourStep = DemoSalesScriptStep & {
  href: string;
  target: string;
  preparation?: DemoTourPreparation;
};

const ROUTES: Record<
  DemoSalesScriptStep['id'],
  Pick<DemoTourStep, 'href' | 'target' | 'preparation'>
> = {
  dashboard: { href: '/dashboard', target: 'dashboard-overview' },
  'pos-modifiers': { href: '/pos', target: 'pos-order', preparation: 'pos-modifiers' },
  'kds-ticket': { href: '/kds', target: 'kds-ticket' },
  'floor-table': {
    href: '/restaurant/floor',
    target: 'floor-table',
    preparation: 'floor-table',
  },
  'bill-settlement': {
    href: '/pos',
    target: 'bill-settlement',
    preparation: 'bill-settlement',
  },
  'daily-close': {
    href: '/restaurant/money',
    target: 'daily-close',
    preparation: 'daily-close',
  },
  'inventory-low-stock': {
    href: '/restaurant/inventory',
    target: 'inventory-low-stock',
  },
  'recipe-lines': {
    href: '/restaurant/catalog',
    target: 'recipe-lines',
    preparation: 'recipe-lines',
  },
  'purchase-receipt': { href: '/restaurant/purchasing', target: 'purchase-receipt' },
  'reports-overview': { href: '/restaurant/reports', target: 'reports-overview' },
};

export const TOUR_STEPS: readonly DemoTourStep[] = DEMO_SALES_SCRIPT.map((step) => ({
  ...step,
  ...ROUTES[step.id],
}));

export type DemoTourProgress = { index: number };

export function parseTourProgress(raw: string | null): DemoTourProgress | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { version?: unknown; active?: unknown; index?: unknown };
    if (
      value.version !== 1 ||
      value.active !== true ||
      !Number.isInteger(value.index) ||
      Number(value.index) < 0 ||
      Number(value.index) >= TOUR_STEPS.length
    ) {
      return null;
    }
    return { index: Number(value.index) };
  } catch {
    return null;
  }
}

export function readTourProgress(
  storage: Pick<Storage, 'getItem'> | null | undefined
): DemoTourProgress | null {
  try {
    return storage ? parseTourProgress(storage.getItem(DEMO_TOUR_STORAGE_KEY)) : null;
  } catch {
    return null;
  }
}

export function saveTourProgress(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  index: number
) {
  if (!Number.isInteger(index) || index < 0 || index >= TOUR_STEPS.length) return;
  try {
    storage?.setItem(DEMO_TOUR_STORAGE_KEY, JSON.stringify({ version: 1, active: true, index }));
  } catch {
    // Private browsing and embedded hosts may deny storage. Tour still works on this route.
  }
}

export function clearTourProgress(storage: Pick<Storage, 'removeItem'> | null | undefined) {
  try {
    storage?.removeItem(DEMO_TOUR_STORAGE_KEY);
  } catch {
    // Nothing else to clear when storage is unavailable.
  }
}

function normalizePath(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function isTourStepPath(step: DemoTourStep, pathname: string) {
  return normalizePath(pathname) === normalizePath(step.href);
}

export function tourTargetSelector(step: DemoTourStep) {
  return `[data-tour="${step.target}"]`;
}

export function hasGramToKilogramConversion(text: string) {
  const value = text.toLowerCase().replace(/\s+/g, ' ');
  const grams = /\b(?:g|gm|gram|grams)\b/.test(value);
  const kilograms = /\b(?:kg|kilogram|kilograms)\b/.test(value);
  return grams && kilograms && /\b0\.001(?:0+)?\b/.test(value);
}

export function hasGramMillilitrePieceLines(text: string) {
  const value = text
    .toLowerCase()
    .replace(/([a-z])(?=\d)|(?<=\d)(?=[a-z])/g, '$1 ')
    .replace(/\s+/g, ' ');
  return (
    /\b(?:g|gm|gram|grams)\b/.test(value) &&
    /\b(?:ml|millilitre|millilitres|milliliter|milliliters)\b/.test(value) &&
    /\b(?:pc|pcs|piece|pieces)\b/.test(value)
  );
}
