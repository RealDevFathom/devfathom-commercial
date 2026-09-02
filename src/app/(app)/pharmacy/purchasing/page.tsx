import type { Metadata } from 'next';
import Link from 'next/link';

import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { hasModule } from '@/lib/entitlements';
import { resolveBranch } from './_components/branch-scope';
import {
  AccessState,
  EmptyState,
  LoadFailure,
  NoticeBanner,
  PurchasingHeader,
  PurchasingTabs,
} from './_components/console-chrome';
import {
  money,
  noticeFrom,
  param,
  purchasingCaller,
  PURCHASING_ROUTE,
  tenantContext,
  type SearchQuery,
} from './_lib/console';

export const metadata: Metadata = { title: 'Purchasing · Pharmacy' };

const HEADING = 'Purchasing & receiving';
const DESCRIPTION =
  'Suppliers, requisitions, orders, the goods-in bench and supplier returns. Everything a pharmacy buys passes through here on its way to being saleable stock.';

/**
 * The PH-PUR entry point (PRD §6.3).
 *
 * Its job is to say what is blocked and where to go, in that order. UX rule 13:
 * a precondition is a checklist with a link to the page that clears it — so a
 * fresh organization that cannot yet receive anything is told exactly which
 * three things are missing, rather than being dropped onto a bench that refuses
 * every submission for a reason it never states.
 */
export default async function PharmacyPurchasingPage({
  searchParams,
}: {
  searchParams: Promise<SearchQuery>;
}) {
  const query = await searchParams;
  const notice = noticeFrom(query);
  const ctx = await tenantContext();
  if (!ctx)
    return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={false} />;
  const moduleEnabled = hasModule(ctx.entitlements, 'pharmacy-procurement');
  if (!moduleEnabled || !ctx.session?.user) {
    return (
      <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={moduleEnabled} />
    );
  }
  const caller = await purchasingCaller();
  if (!caller) {
    return (
      <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={moduleEnabled} />
    );
  }

  let workspace: Awaited<ReturnType<typeof caller.workspace>>;
  let orders: Awaited<ReturnType<typeof caller.purchaseOrders>>;
  try {
    [workspace, orders] = await Promise.all([caller.workspace(), caller.purchaseOrders()]);
  } catch {
    return (
      <main className="min-w-0 space-y-6">
        <PurchasingHeader heading={HEADING} description={DESCRIPTION} />
        <PurchasingTabs active={PURCHASING_ROUTE} />
        <LoadFailure
          detail="Purchasing could not read this workspace."
          retryHref={PURCHASING_ROUTE}
        />
      </main>
    );
  }

  const scope = resolveBranch(workspace.branches, param(query, 'branch'));
  const branchId = scope.kind === 'resolved' ? scope.branch.id : null;

  let openExceptions = 0;
  let creditOutstandingMinor = 0;
  if (branchId) {
    try {
      const [exceptions, returns] = await Promise.all([
        caller.receivingExceptionQueue({ branchId, status: 'OPEN' }),
        caller.purchaseReturns({ branchId }),
      ]);
      openExceptions = exceptions.length;
      creditOutstandingMinor = returns
        .flatMap((row) => row.debitNotes)
        .reduce((total, note) => total + note.position.outstandingMinor, 0);
    } catch {
      // A branch-scoped read that fails does not take the whole overview with
      // it; the counters that could not be read simply say so below.
      openExceptions = -1;
    }
  }

  const orderable = workspace.suppliers.filter((supplier) => supplier.eligibility.orderable);
  const medicinesWithPacks = workspace.medicines.filter((medicine) => medicine.packs.length > 0);

  /** UX rule 13 — every unmet gate, each linked to the page that clears it. */
  const gates = [
    {
      met: workspace.branches.length > 0,
      label: 'An active pharmacy branch',
      why: 'Stock is held by a branch, and a goods receipt posts into one branch’s ledger.',
      href: '/pharmacy',
      action: 'Open pharmacy onboarding',
    },
    {
      met: workspace.stockLocations.length > 0,
      label: 'At least one stock location',
      why: 'Accepted units are received into a named location, and rejected units into a quarantine one.',
      href: '/pharmacy',
      action: 'Add a stock location',
    },
    {
      met: medicinesWithPacks.length > 0,
      label: 'A medicine with an effective pack level',
      why: 'Orders and receipts are stated in packs, so the pack → unit conversion has to exist before either can be entered.',
      href: '/pharmacy',
      action: 'Open the medicine register',
    },
    {
      met: orderable.length > 0,
      label: 'A supplier that can be ordered from',
      why: 'PUR-01 refuses an order or a receipt unless the supplier is authorized and holds an unexpired verified licence.',
      href: `${PURCHASING_ROUTE}/suppliers`,
      action: 'Open the supplier register',
    },
  ];
  const unmet = gates.filter((gate) => !gate.met);

  return (
    <main className="min-w-0 space-y-6">
      <PurchasingHeader heading={HEADING} description={DESCRIPTION} />
      <PurchasingTabs active={PURCHASING_ROUTE} />
      <NoticeBanner notice={notice} />

      {unmet.length > 0 ? (
        <SectionCard
          eyebrow="Before you can receive"
          title={`${unmet.length} thing${unmet.length === 1 ? '' : 's'} still to set up`}
          titleLevel={2}
        >
          <p className="text-sm text-text-muted">
            Each one is a gate the domain enforces, not a suggestion. Everything already in place is
            listed below it, so you can see how far along this workspace is.
          </p>
          <ul className="mt-4 space-y-3">
            {gates.map((gate) => (
              <li
                className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-sm)] border border-border-subtle p-3"
                key={gate.label}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <StatusPill
                      status={gate.met ? 'Ready' : 'Missing'}
                      tone={gate.met ? 'success' : 'warning'}
                    />
                    <span className="font-medium text-text-strong">{gate.label}</span>
                  </span>
                  <span className="mt-1 block text-sm text-text-muted">{gate.why}</span>
                </span>
                {gate.met ? null : (
                  <Link
                    className="inline-flex min-h-11 shrink-0 items-center rounded-[var(--radius-sm)] border border-border-default px-4 text-sm font-medium text-text-strong hover:bg-muted focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
                    href={gate.href}
                  >
                    {gate.action}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Orderable suppliers"
          value={`${orderable.length} of ${workspace.suppliers.length}`}
          sub="Authorized and licensed"
        />
        <Stat
          label="Awaiting approval"
          value={orders.filter((order) => order.status === 'SUBMITTED').length}
          sub="Needs a second person"
        />
        <Stat
          label="Open match exceptions"
          value={branchId === null ? '—' : openExceptions === -1 ? 'unavailable' : openExceptions}
          sub={
            branchId === null
              ? 'Choose a branch on the goods-in bench'
              : scope.kind === 'resolved'
                ? scope.branch.name
                : ''
          }
        />
        <Stat
          label="Credit outstanding"
          value={branchId === null ? '—' : money(creditOutstandingMinor)}
          sub="Expected, not yet received"
        />
      </div>

      <SectionCard title="Where to go" titleLevel={2}>
        <div className="grid gap-3 md:grid-cols-2">
          {[
            {
              href: `${PURCHASING_ROUTE}/suppliers`,
              title: 'Suppliers (PUR-01)',
              detail:
                'Licence evidence, terms, credit and the standing decision to trade. A supplier is orderable only while both the authorization and an unexpired verified licence hold.',
            },
            {
              href: `${PURCHASING_ROUTE}/orders`,
              title: 'Requisitions & orders (PUR-02/03)',
              detail:
                'State the demand, record what each distributor quoted, read the ranked and explained comparison, then approve and send the order. Approval is refused to whoever raised it.',
            },
            {
              href: `${PURCHASING_ROUTE}/receiving`,
              title: 'Goods in (PUR-02/04/05)',
              detail:
                'Capture batch, expiry, printed MRP, pack level, quantity, bonus and cost; post into the batch ledger; work the match-exception queue; or take a direct purchase with a recorded bypass.',
            },
            {
              href: `${PURCHASING_ROUTE}/returns`,
              title: 'Returns & claims (PUR-06)',
              detail:
                'Purchase returns and expiry claims with the supplier window each is racing, the debit notes they raise, and expected against received credit side by side.',
            },
          ].map((card) => (
            <Link
              className="block rounded-[var(--radius-sm)] border border-border-subtle p-4 transition-colors hover:bg-muted focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
              href={card.href}
              key={card.href}
            >
              <h3 className="font-medium text-text-strong">{card.title}</h3>
              <p className="mt-2 text-sm text-text-muted">{card.detail}</p>
            </Link>
          ))}
        </div>
      </SectionCard>

      {orders.length === 0 ? (
        <SectionCard title="Nothing has been ordered yet" titleLevel={2}>
          <EmptyState
            title="No purchase orders"
            detail="Once the gates above are met, draft a requisition, compare the quotes you were given, and raise the order from the one you award."
            steps={[
              { label: 'Draft a requisition', href: `${PURCHASING_ROUTE}/orders` },
              { label: 'Add a supplier', href: `${PURCHASING_ROUTE}/suppliers` },
            ]}
          />
        </SectionCard>
      ) : null}
    </main>
  );
}
