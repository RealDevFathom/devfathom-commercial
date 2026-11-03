import type { Metadata } from 'next';
import Link from 'next/link';
import { TRPCError } from '@trpc/server';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { hasModule } from '@/lib/entitlements';
import { actorCanProcure } from '@/lib/pharmacy/procurement-access';
import { resolveBranch } from './_components/branch-scope';
import {
  AccessState,
  EmptyState,
  NoticeBanner,
  PurchasingHeader,
  PurchasingTabs,
} from './_components/console-chrome';
import {
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

type ReadState =
  { kind: 'known'; value: number } | { kind: 'unavailable' | 'denied' | 'unselected' };

function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof TRPCError && (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
  );
}

async function readTotal(read: () => Promise<number>): Promise<ReadState> {
  try {
    return { kind: 'known', value: await read() };
  } catch (error) {
    return { kind: isAccessDenied(error) ? 'denied' : 'unavailable' };
  }
}

function readLabel(state: ReadState) {
  switch (state.kind) {
    case 'known':
      return state.value;
    case 'unavailable':
      return 'Unavailable';
    case 'denied':
      return 'Access denied';
    case 'unselected':
      return 'Unselected';
  }
}

function ReadRetry({ branchId }: { branchId?: string }) {
  // A native GET requests fresh server reads even when the URL is unchanged.
  return (
    <form
      action={PURCHASING_ROUTE}
      method="get"
      className="mt-4"
      aria-label="Retry purchasing reads"
    >
      {branchId ? <input type="hidden" name="branch" value={branchId} /> : null}
      <Button type="submit" variant="outline" className="min-h-11">
        Retry reads
      </Button>
    </form>
  );
}

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
  const requestedBranch = param(query, 'branch');
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
  // Suppliers, requisitions, orders and returns, with their actions ('Add a
  // supplier', 'Draft a requisition'), are shown only to members holding the
  // procurement capability, the same rule as the goods-in bench. A cashier or a
  // pharmacist gets the closed state instead of the screens.
  if (!(await actorCanProcure(ctx.db, ctx.session.user.id))) {
    return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled />;
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
  } catch (error) {
    if (isAccessDenied(error)) {
      return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled />;
    }
    return (
      <main className="min-w-0 space-y-6">
        <PurchasingHeader heading={HEADING} description={DESCRIPTION} />
        <PurchasingTabs active={PURCHASING_ROUTE} />
        <SectionCard title="This surface could not load" titleLevel={2}>
          <p className="text-sm text-text-muted" role="status">
            Purchasing could not read this workspace. Retry only reloads purchasing records.
          </p>
          <ReadRetry branchId={requestedBranch} />
        </SectionCard>
      </main>
    );
  }

  const scope = resolveBranch(workspace.branches, requestedBranch);
  // Never fall back to a different single branch when an explicit selection is unavailable.
  const invalidBranch = Boolean(
    requestedBranch && !workspace.branches.some((branch) => branch.id === requestedBranch)
  );
  const branchId = !invalidBranch && scope.kind === 'resolved' ? scope.branch.id : null;
  const scopeLabel =
    branchId && scope.kind === 'resolved'
      ? scope.branch.name
      : invalidBranch
        ? 'The requested branch is not available in this workspace.'
        : 'Choose a branch on the goods-in bench';

  let openExceptions: ReadState = { kind: invalidBranch ? 'denied' : 'unselected' };
  let creditOutstanding: ReadState = { kind: invalidBranch ? 'denied' : 'unselected' };
  if (branchId) {
    // Each read settles independently, retaining the successful sibling's value.
    [openExceptions, creditOutstanding] = await Promise.all([
      readTotal(async () => {
        const exceptions = await caller.receivingExceptionQueue({ branchId, status: 'OPEN' });
        return exceptions.length;
      }),
      readTotal(async () => {
        const returns = await caller.purchaseReturns({ branchId });
        return returns
          .flatMap((row) => row.debitNotes)
          .reduce((total, note) => total + note.position.outstandingMinor, 0);
      }),
    ]);
  }

  const hasUnavailable =
    openExceptions.kind === 'unavailable' || creditOutstanding.kind === 'unavailable';
  const currency = ctx.organization?.currency?.trim();
  const knownCurrency = currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
  // The shared purchasing money helper fixes PKR; use the resolved tenant currency here.
  const creditValue =
    creditOutstanding.kind === 'known'
      ? knownCurrency
        ? `${knownCurrency} ${(creditOutstanding.value / 100).toLocaleString('en-PK', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`
        : 'Currency unavailable'
      : readLabel(creditOutstanding);

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
          value={readLabel(openExceptions)}
          valueClassName="break-words"
          sub={
            <>
              {scopeLabel}
              {openExceptions.kind === 'denied'
                ? ' Ask a workspace administrator to check your branch access and session.'
                : openExceptions.kind === 'known'
                  ? ' · Current open receiving exceptions, read on this page load.'
                  : openExceptions.kind === 'unavailable'
                    ? ' · Exception count could not be read.'
                    : ''}
            </>
          }
        />
        <Stat
          label="Credit outstanding"
          value={creditValue}
          valueClassName="break-words"
          sub={
            <>
              {scopeLabel} · Expected, not yet received.
              {creditOutstanding.kind === 'denied'
                ? ' Ask a workspace administrator to check your branch access and session.'
                : creditOutstanding.kind === 'known'
                  ? ` Current debit-note outstanding positions across all returns for this branch; read on this page load.${knownCurrency ? '' : ' Credit read succeeded; workspace currency is unavailable.'}`
                  : creditOutstanding.kind === 'unavailable'
                    ? ' Credit balance could not be read; this is not a confirmed zero.'
                    : ''}
            </>
          }
        />
      </div>

      {hasUnavailable && branchId ? (
        <SectionCard title="Some branch totals could not load" titleLevel={2}>
          <p className="text-sm text-text-muted" role="status">
            Available totals remain visible for {scopeLabel}. Retry keeps this branch selected and
            reloads purchasing records; it does not submit orders, returns or credits.
          </p>
          <ReadRetry branchId={branchId} />
        </SectionCard>
      ) : null}

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
