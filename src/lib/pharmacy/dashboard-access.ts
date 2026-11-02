import 'server-only';

import { can, subjectFromSession, type Action } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';
import { hasModule } from '@/lib/entitlements';
import type { EntitlementView } from '@/lib/module-catalog';
import type { PharmacyDashboardAccess, PharmacyDashboardLink } from './dashboard';

type Viewer = Parameters<typeof subjectFromSession>[0];
type Gate = { module: string; owner: boolean; actions: readonly Action[] };

export type PharmacyAdviceKey = 'reorder' | 'expiry' | 'growth';

/**
 * DEV-594 — the advice pages that already exist, named the way an owner asks for
 * them. Each gate repeats the checks its page's own reads make, so a link is
 * never offered to someone the page would refuse.
 */
const ADVICE: Record<PharmacyAdviceKey, PharmacyDashboardLink & { gate: Gate }> = {
  reorder: {
    key: 'reorder',
    href: '/pharmacy/reports/replenishment',
    label: 'Reorder advice',
    detail: 'How much of each medicine to reorder, from what sold and what is on the shelf.',
    // `pharmacyReports.branches` + `catalog`: Pharmacy Reports and reports:operational.
    gate: { module: 'pharmacy-reports', owner: false, actions: ['reports:operational'] },
  },
  expiry: {
    key: 'expiry',
    href: '/pharmacy/reports',
    label: 'Expiry advice',
    detail:
      'Stock likely to expire before it sells, ranked by value, with supplier returns to try.',
    // `pharmacyReports.expiryAdvice` is an owner report (`ownerFilters`).
    gate: {
      module: 'pharmacy-reports',
      owner: true,
      actions: ['reports:operational', 'reports:financial'],
    },
  },
  growth: {
    key: 'growth',
    href: '/pharmacy/marketing',
    label: 'Growth insights',
    detail: 'Suggestions for growing sales, which you review before anything reaches a customer.',
    // `pharmacyMarketing.growthHistory`: owner, Pharmacy CRM and both report grants.
    gate: {
      module: 'pharmacy-crm',
      owner: true,
      actions: ['reports:operational', 'reports:financial'],
    },
  },
};

/** The working pages a viewer without reports starts from, each on its page's own grant. */
const ROLE_TOOLS: ReadonlyArray<PharmacyDashboardLink & { gate: Gate }> = [
  {
    key: 'counter',
    href: '/pharmacy/counter',
    label: 'Counter',
    detail: 'Serve customers, take payment and print receipts.',
    gate: { module: 'pharmacy-counter', owner: false, actions: ['pharmacy:counter'] },
  },
  {
    key: 'orders',
    href: '/pharmacy/orders',
    label: 'Customer orders',
    detail: 'Accept and prepare orders customers placed ahead.',
    gate: { module: 'pharmacy-counter', owner: false, actions: ['pharmacy:orders'] },
  },
  {
    key: 'close',
    href: '/pharmacy/counter/close',
    label: 'Day close',
    detail: 'Count the drawer and close the business day.',
    gate: { module: 'pharmacy-counter', owner: false, actions: ['pharmacy:close'] },
  },
  {
    key: 'pharmacist-queue',
    href: '/pharmacy/pharmacist-queue',
    label: 'Pharmacist queue',
    detail: 'Prescriptions waiting for a pharmacist to review and sign.',
    gate: { module: 'pharmacy-dispensing', owner: false, actions: ['pharmacy:dispense'] },
  },
  {
    key: 'inventory',
    href: '/pharmacy/inventory',
    label: 'Inventory',
    detail: 'Stock on hand, counts, transfers and expiring batches.',
    gate: { module: 'pharmacy-inventory', owner: false, actions: ['pharmacy:inventory'] },
  },
  {
    key: 'purchasing',
    href: '/pharmacy/purchasing',
    label: 'Purchasing',
    detail: 'Suppliers, orders, goods in and supplier returns.',
    gate: { module: 'pharmacy-procurement', owner: false, actions: ['pharmacy:procurement'] },
  },
];

/** One `can()` per action per request, however many links name it. */
function grants(db: AuthzDb, viewer: Viewer) {
  const subject = subjectFromSession(viewer);
  const decisions = new Map<Action, Promise<boolean>>();
  return (action: Action) => {
    let decision = decisions.get(action);
    if (!decision) {
      decision = can(subject, action, undefined, { db });
      decisions.set(action, decision);
    }
    return decision;
  };
}

async function opens(
  gate: Gate,
  viewer: Viewer,
  entitlements: EntitlementView,
  holds: (action: Action) => Promise<boolean>
) {
  // Cheapest first: an unlicensed module or a non-owner never reaches the database.
  if (!hasModule(entitlements, gate.module)) return false;
  if (gate.owner && viewer.role !== 'ADMIN') return false;
  for (const action of gate.actions) if (!(await holds(action))) return false;
  return true;
}

async function permitted(
  links: ReadonlyArray<PharmacyDashboardLink & { gate: Gate }>,
  viewer: Viewer,
  entitlements: EntitlementView,
  holds: (action: Action) => Promise<boolean>
): Promise<PharmacyDashboardLink[]> {
  const open: PharmacyDashboardLink[] = [];
  for (const { gate, ...link } of links)
    if (await opens(gate, viewer, entitlements, holds)) open.push(link);
  return open;
}

/** The advice links among `keys` that this viewer can open, in the order asked. */
export function resolvePharmacyAdvice(
  db: AuthzDb,
  viewer: Viewer,
  entitlements: EntitlementView,
  keys: readonly PharmacyAdviceKey[]
): Promise<PharmacyDashboardLink[]> {
  return permitted(
    keys.map((key) => ADVICE[key]),
    viewer,
    entitlements,
    grants(db, viewer)
  );
}

/**
 * DEV-602 — the dashboard follows the viewer's grants, not the workspace's owner.
 * A viewer without `reports:operational` (a cashier, a pharmacist) is refused by
 * every command-centre read and by the layout save, so the dashboard shows their
 * own tools instead and never offers to edit an owner layout.
 */
export async function resolvePharmacyDashboardAccess(
  db: AuthzDb,
  viewer: Viewer,
  entitlements: EntitlementView
): Promise<PharmacyDashboardAccess> {
  const holds = grants(db, viewer);
  const reports = await holds('reports:operational');
  if (!reports)
    return { reports, tools: await permitted(ROLE_TOOLS, viewer, entitlements, holds), advice: [] };
  return {
    reports,
    tools: [],
    advice: await permitted(
      (['reorder', 'expiry', 'growth'] as const).map((key) => ADVICE[key]),
      viewer,
      entitlements,
      holds
    ),
  };
}
