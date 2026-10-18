import { DEMO_SALES_SCRIPT, DEMO_WORKFLOW_BRIEFS, type DemoSalesScriptStep } from './sales-script';
import type { DemoPersona } from './personas';

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

function roleJourney(
  persona: DemoPersona,
  ids: readonly DemoSalesScriptStep['id'][]
): readonly DemoTourStep[] {
  const brief = DEMO_WORKFLOW_BRIEFS[persona];
  return ids.map((id) => {
    const step = TOUR_STEPS.find((candidate) => candidate.id === id)!;
    return {
      ...step,
      title: persona === 'cashier' ? 'Bills and settlement' : step.title,
      // Only open the cashier's payment dialog or finance's read tab. Never prepare editors.
      preparation: persona === 'cashier' || persona === 'finance' ? step.preparation : undefined,
      talkingPoints: ids.length === 1 ? brief.actions : step.talkingPoints,
      likelyQuestion: 'What happens next in this perspective?',
      answer: brief.handoff,
    };
  });
}

const PERSONA_TOURS: Record<DemoPersona, readonly DemoTourStep[]> = {
  owner: roleJourney('owner', ['dashboard', 'reports-overview']),
  manager: TOUR_STEPS,
  cashier: roleJourney('cashier', ['bill-settlement']),
  waiter: roleJourney('waiter', ['pos-modifiers']),
  kitchen: roleJourney('kitchen', ['kds-ticket']),
  inventory: roleJourney('inventory', ['inventory-low-stock', 'purchase-receipt']),
  finance: roleJourney('finance', ['daily-close', 'reports-overview']),
};

export function tourStepsForPersona(persona: DemoPersona): readonly DemoTourStep[] {
  return PERSONA_TOURS[persona];
}

function progressKey(scope: string) {
  return scope ? `${DEMO_TOUR_STORAGE_KEY}:${scope}` : DEMO_TOUR_STORAGE_KEY;
}

export type DemoTourProgress = { index: number };

export function parseTourProgress(
  raw: string | null,
  stepCount = TOUR_STEPS.length
): DemoTourProgress | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { version?: unknown; active?: unknown; index?: unknown };
    if (
      value.version !== 1 ||
      value.active !== true ||
      !Number.isInteger(value.index) ||
      Number(value.index) < 0 ||
      Number(value.index) >= stepCount
    ) {
      return null;
    }
    return { index: Number(value.index) };
  } catch {
    return null;
  }
}

export function readTourProgress(
  storage: Pick<Storage, 'getItem'> | null | undefined,
  scope = '',
  stepCount = TOUR_STEPS.length
): DemoTourProgress | null {
  try {
    return storage ? parseTourProgress(storage.getItem(progressKey(scope)), stepCount) : null;
  } catch {
    return null;
  }
}

export function saveTourProgress(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  index: number,
  scope = '',
  stepCount = TOUR_STEPS.length
) {
  if (!Number.isInteger(index) || index < 0 || index >= stepCount) return;
  try {
    storage?.setItem(progressKey(scope), JSON.stringify({ version: 1, active: true, index }));
  } catch {
    // Private browsing and embedded hosts may deny storage. Tour still works on this route.
  }
}

export function clearTourProgress(
  storage: Pick<Storage, 'removeItem'> | null | undefined,
  scope = ''
) {
  try {
    storage?.removeItem(progressKey(scope));
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
