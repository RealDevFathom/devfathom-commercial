'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';
import { pharmacyBusinessDay, sharedPharmacyDayEnd } from '@/lib/pharmacy/business-day';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  Eye,
  EyeOff,
  Megaphone,
  Pencil,
  RotateCcw,
  Save,
  ShoppingCart,
} from 'lucide-react';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button, buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { isModuleGranted } from '@/lib/module-catalog';
import {
  PHARMACY_WIDGET_REGISTRY,
  pharmacyDashboardDefault,
  type PharmacyDashboardPreference,
} from '@/lib/pharmacy/dashboard';
import { plainReportPermission, plainReportSource } from '@/lib/pharmacy/report-labels';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import { TradingOverview } from './trading-overview';
import { reportMoney } from '@/components/dashboard/business-chart';

const definition = new Map(PHARMACY_WIDGET_REGISTRY.map((item) => [item.key, item]));
type CommandQuery = {
  data?: {
    freshness: { asOf: string; source: string };
    permissions: { operational: boolean; financial: boolean };
    metrics: Record<string, number | null>;
  };
  error: { data?: { code?: string | null } | null } | null;
  isLoading: boolean;
  refetch: () => unknown;
};
const formatMetric = (key: string, value: number | null, currency?: string | null) =>
  value == null
    ? '—'
    : key.toLowerCase().includes('minor')
      ? reportMoney(value, currency)
      : value.toLocaleString();

/**
 * DEV-729: stock signals and recommended orders come back null until the evaluator has
 * run for every branch in scope. Say that plainly instead of a dash or a zero, which an
 * owner reads as "nothing to reorder".
 */
const UNCALCULATED_METRICS = new Set(['openStockSignals', 'recommendedOrders']);
const metricValue = (key: string, value: number | null, currency?: string | null) =>
  value == null && UNCALCULATED_METRICS.has(key)
    ? 'Not calculated yet'
    : formatMetric(key, value, currency);
const metricSub = (key: string, value: number | null, source: string | null | undefined) =>
  value != null
    ? sourceLine(source)
    : UNCALCULATED_METRICS.has(key)
      ? 'Stock signals have not been worked out for this scope. Refresh them in Inventory.'
      : 'No data recorded yet';

// Only reached when the metric catalog has not delivered a label for a key.
// Reads the camelCase metric key as words rather than the raw, unspaced key the
// `.eyebrow` style would otherwise shout back (e.g. OPENSTOCKSIGNALS).
const humanizeMetricKey = (key: string) =>
  key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());

function WidgetState({
  item,
  query,
  contracts,
  branchCount,
  metricsReady,
  currency,
}: {
  item: (typeof PHARMACY_WIDGET_REGISTRY)[number];
  query: CommandQuery;
  contracts: ReadonlyArray<{
    key: string;
    label: string;
    source: string | null;
    permission: string;
    drillThrough: string | null;
  }>;
  branchCount: number;
  metricsReady: boolean;
  currency?: string | null;
}) {
  // A command query that is still fetching — or disabled while its branches
  // load — has no data and no error yet. That is a loading state, not a
  // permission denial, so the skeleton must win over the RESTRICTED fallbacks
  // below. A metric widget also waits for the catalog so it never prints raw
  // keys before the labels arrive.
  const pending = query.isLoading || (!query.data && !query.error);
  if (pending || (item.key !== 'branches' && !metricsReady))
    return (
      <div aria-label={`Loading ${item.label}`} role="status" className="grid gap-5 sm:grid-cols-2">
        {(item.metrics.length ? item.metrics : [item.key]).map((key) => (
          <div key={key} className="min-h-20 space-y-3">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    );
  if (query.error) {
    const denied = ['FORBIDDEN', 'UNAUTHORIZED'].includes(query.error.data?.code ?? '');
    return (
      <div role={denied ? 'status' : 'alert'} className="space-y-3">
        <StatusPill status={denied ? 'Restricted' : 'Unavailable'} tone="warning" />
        <p className="text-sm text-text-body">
          {denied
            ? `${plainReportPermission(item.permission)} access is required. No protected values are shown.`
            : 'This widget could not load. Other dashboard tools remain available.'}
        </p>
        {!denied ? (
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  }
  if (item.permission === 'reports:financial' && !query.data?.permissions.financial) {
    return (
      <div role="status" className="space-y-3">
        <StatusPill status="Restricted" tone="warning" />
        <p className="text-sm text-text-body">
          Financial reports access is required. No protected values are shown.
        </p>
      </div>
    );
  }
  if (item.key === 'branches')
    return (
      <Stat
        label="Branches in scope"
        value={branchCount}
        sub="Choose a branch above to compare one location with the all-branch view."
      />
    );
  const rows = item.metrics.map((key) => ({
    contract: contracts.find((metric) => metric.key === key),
    value: query.data?.metrics[key] ?? null,
  }));
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {rows.map(({ contract, value }, index) => (
        <Stat
          key={item.metrics[index]}
          label={contract?.label ?? humanizeMetricKey(item.metrics[index]!)}
          value={metricValue(item.metrics[index]!, value, currency)}
          sub={metricSub(item.metrics[index]!, value, contract?.source)}
        />
      ))}
    </div>
  );
}

// DEV-594: say where a figure comes from in the owner's words, never as the
// internal table names the metric contract keeps for audit.
const sourceLine = (source: string | null | undefined) => {
  const plain = plainReportSource(source);
  return plain ? `Based on ${plain}` : 'Source not recorded';
};

/**
 * DEV-594: one discoverable entry point to the advisory tools that otherwise sit
 * deep in Reports and Marketing. Each link is offered only to someone the target
 * page admits; the pages themselves still enforce access on the server.
 */
function AiAdviceCard({
  owner,
  financial,
  growth,
}: {
  owner: boolean;
  financial: boolean;
  growth: boolean;
}) {
  const entries = [
    {
      href: '/pharmacy/reports/replenishment',
      label: 'Reorder advice',
      detail: 'Compare recorded use with stock on hand before you raise a purchase order.',
      icon: ShoppingCart,
      shown: true,
    },
    {
      href: '/pharmacy/reports#expiry-advisor',
      label: 'Expiry advice',
      detail: 'Stock likely to expire before it sells, ranked by value at risk.',
      icon: CalendarClock,
      shown: owner && financial,
    },
    {
      href: '/pharmacy/marketing',
      label: 'Growth',
      detail: 'Customer campaigns and win-back drafts for you to review.',
      icon: Megaphone,
      shown: growth,
    },
  ].filter((entry) => entry.shown);
  return (
    <SectionCard eyebrow="Advisory only" title="AI advice" titleLevel={2}>
      <p className="mb-4 max-w-2xl text-sm text-text-muted">
        Suggestions built from your own pharmacy records. Nothing is ordered, moved or sent until a
        person reviews it.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map(({ href, label, detail, icon: Icon }) => (
          <li key={href} className="min-w-0">
            <Link
              href={href}
              className="flex h-full min-h-11 gap-3 rounded-md border border-border-subtle p-4 transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-text-muted" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text-strong">{label}</span>
                <span className="mt-1 block text-sm text-text-muted">{detail}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

export function PharmacyDashboardContent({
  role,
  reportAccess,
}: {
  role: string | null | undefined;
  /**
   * Whether the member holds `reports:operational`, read server-side by the page. `false` (a
   * cashier) renders a pharmacy home with no owner title, no layout editor and no report reads;
   * `undefined` (access unknown) keeps the command centre, whose reads stay server-gated.
   */
  reportAccess?: boolean;
}) {
  // Every command-centre read is a Pharmacy Reports procedure, and each one refuses a workspace
  // without that module (FORBIDDEN). Ask them nothing there, as the counter does for its module.
  const { enabledModules } = useEntitlements();
  if (reportAccess === false) return <PharmacyMemberHome />;
  return isModuleGranted('pharmacy-reports', enabledModules) ? (
    <OwnerCommandCentre role={role} />
  ) : (
    <ReportsNotInPackage role={role} />
  );
}

/**
 * DEV-602: the pharmacy home for a member without report access (the cashier template). It names
 * no owner surface, offers no layout editor and asks Pharmacy Reports nothing, so no read is
 * refused with a 403 and no save can fail silently.
 */
function PharmacyMemberHome() {
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Pharmacy workspace"
        heading="Pharmacy home"
        description="Your pharmacy tools are in the menu. Owner reports stay with members who hold report access."
      />
      <SectionCard
        eyebrow="Pharmacy Reports"
        title="Owner reports are outside your access"
        titleLevel={2}
        actions={<StatusPill status="Restricted" tone="neutral" />}
      >
        <p role="status" className="max-w-2xl text-sm leading-6 text-text-body">
          Operational reports access is required for the command centre. No report figures are
          requested or shown, and every pharmacy tool in your menu works as usual.
        </p>
      </SectionCard>
    </div>
  );
}

/** The same page frame, saying plainly why it holds no signals and what is still available. */
function ReportsNotInPackage({ role }: { role: string | null | undefined }) {
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Pharmacy workspace"
        heading="Owner command centre"
        description="Today’s trading, stock and outstanding work across your pharmacy."
      />
      <SectionCard
        eyebrow="Pharmacy Reports"
        title="Reports are not part of your package"
        titleLevel={2}
        actions={<StatusPill status="Not in package" tone="neutral" />}
      >
        <p role="status" className="max-w-2xl text-sm leading-6 text-text-body">
          The command centre is built from Pharmacy Reports, which your organization’s package does
          not include. No report data is requested or shown, and every other tool in your package
          works as usual.
        </p>
        {role === 'ADMIN' ? (
          <Link
            href="/organization"
            className={buttonVariants({ variant: 'outline', className: 'mt-4' })}
          >
            Review license and modules
          </Link>
        ) : (
          <p className="mt-4 text-sm text-text-muted">
            An organization administrator can add Pharmacy Reports to the package.
          </p>
        )}
      </SectionCard>
    </div>
  );
}

function OwnerCommandCentre({ role }: { role: string | null | undefined }) {
  const { enabledModules, timeZone } = useEntitlements();
  const utils = trpc.useUtils();
  const independent = { retry: false, trpc: { context: { independentSection: true } } };
  const branches = trpc.pharmacyReports.branches.useQuery({ dashboard: true }, independent);
  const catalog = trpc.pharmacyReports.catalog.useQuery(undefined, independent);
  const preferences = trpc.pharmacyReports.getPreferences.useQuery(undefined, { retry: false });
  const update = trpc.pharmacyReports.updatePreferences.useMutation();
  const [branchId, setBranchId] = useState('');
  const [editing, setEditing] = useState(false);
  const fallback = useMemo(() => pharmacyDashboardDefault(role), [role]);
  const [draft, setDraft] = useState<PharmacyDashboardPreference>(fallback);
  const draftRef = useRef(draft);
  const selected = (branches.data?.branches ?? []).filter(
    (branch) => !branchId || branch.id === branchId
  );
  const { dayEnd } = sharedPharmacyDayEnd(
    selected.map((branch) => branch.businessDayEndsAtHistory)
  );
  const today = pharmacyBusinessDay({ timeZone, dayEnd });
  const input = {
    dashboard: true as const,
    ...(branchId ? { branchId } : {}),
    from: today,
    to: today,
  };
  const command = trpc.pharmacyReports.commandCentre.useQuery(input, {
    trpc: { context: { independentSection: true } },
    enabled: Boolean(branches.data?.branches.length),
    retry: false,
  }) as unknown as CommandQuery;
  // DEV-95: a refused branch read is an access boundary, not an outage. Say so
  // plainly and offer no Retry that can only be refused again.
  const branchesDenied = ['FORBIDDEN', 'UNAUTHORIZED'].includes(branches.error?.data?.code ?? '');
  // DEV-602: a member whose report reads are refused cannot save a layout either, so offer no
  // editor that can only end in a refused save.
  const preferencesDenied = ['FORBIDDEN', 'UNAUTHORIZED'].includes(
    preferences.error?.data?.code ?? ''
  );
  const canEdit = !branchesDenied && !preferencesDenied;
  const procurement = isModuleGranted('pharmacy-procurement', enabledModules);
  const layout = editing ? draft : (preferences.data ?? fallback);
  const begin = () => {
    const next = structuredClone(preferences.data ?? fallback);
    draftRef.current = next;
    setDraft(next);
    setEditing(true);
  };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.widgets.length) return;
    const next = structuredClone(draftRef.current);
    [next.widgets[index], next.widgets[target]] = [next.widgets[target]!, next.widgets[index]!];
    draftRef.current = next;
    setDraft(next);
  };
  const patchWidget = (
    index: number,
    patch: Partial<PharmacyDashboardPreference['widgets'][number]>
  ) => {
    const next = structuredClone(draftRef.current);
    next.widgets[index] = { ...next.widgets[index]!, ...patch };
    draftRef.current = next;
    setDraft(next);
  };
  const save = async () => {
    // A refused or failed save stays in edit mode; `update.error` renders the alert below.
    const saved = await update.mutateAsync(draftRef.current).catch(() => null);
    if (!saved) return;
    utils.pharmacyReports.getPreferences.setData(undefined, saved);
    setEditing(false);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Pharmacy workspace"
        heading="Owner command centre"
        description="Today’s trading, stock and outstanding work across your pharmacy."
        className="mb-0 gap-3 pb-4"
        actions={
          <>
            <label className="flex min-w-0 items-center gap-2">
              <span className="eyebrow">Branch</span>
              <StudioSelect
                aria-label="Dashboard branch"
                value={branchId}
                onChange={(event) => setBranchId(event.target.value)}
                disabled={branches.isLoading || Boolean(branches.error)}
                className="h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">All available</option>
                {branches.data?.branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </StudioSelect>
            </label>
            {canEdit && (
              <Button variant="outline" onClick={begin}>
                <Pencil aria-hidden />
                Edit dashboard
              </Button>
            )}
          </>
        }
      />
      <p className="font-mono text-xs text-text-muted">
        {command.data
          ? `As of ${new Date(command.data.freshness.asOf).toLocaleString()} · ${command.data.freshness.source}`
          : branchesDenied
            ? 'Branch reports are outside your access.'
            : branches.error
              ? 'Branches could not be loaded.'
              : branches.data?.branches.length === 0
                ? 'Waiting for a reportable branch.'
                : 'Loading today’s figures…'}
      </p>

      {branches.data?.branches.length && catalog.data && !branches.error ? (
        <TradingOverview
          branchId={branchId || undefined}
          branches={selected.length}
          financial={catalog.data.permissions.financial}
          currency={catalog.data.currency}
        />
      ) : null}
      {catalog.data && !branchesDenied ? (
        <AiAdviceCard
          owner={catalog.data.permissions.owner}
          financial={catalog.data.permissions.financial}
          growth={role === 'ADMIN' && isModuleGranted('pharmacy-crm', enabledModules)}
        />
      ) : null}
      {editing && canEdit ? (
        <SectionCard
          eyebrow="Edit mode"
          title="Widget layout"
          titleLevel={2}
          actions={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  const next = pharmacyDashboardDefault(role);
                  draftRef.current = next;
                  setDraft(next);
                }}
              >
                <RotateCcw aria-hidden />
                Restore role default
              </Button>
              <Button disabled={update.isPending} onClick={() => void save()}>
                <Save aria-hidden />
                {update.isPending ? 'Saving…' : 'Save dashboard'}
              </Button>
            </>
          }
        >
          <ul className="divide-y divide-border-subtle">
            {draft.widgets.map((widget, index) => (
              <li key={widget.key} className="flex flex-wrap items-center gap-2 py-3">
                <span className="mr-auto text-sm font-medium">
                  {definition.get(widget.key)?.label}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => patchWidget(index, { visible: !widget.visible })}
                >
                  {widget.visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  {widget.visible ? 'Hide' : 'Show'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    patchWidget(index, { span: widget.span === 'wide' ? 'compact' : 'wide' })
                  }
                >
                  {widget.span === 'wide' ? 'Wide' : 'Compact'}
                </Button>
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={`Move ${definition.get(widget.key)?.label} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp aria-hidden />
                </Button>
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={`Move ${definition.get(widget.key)?.label} down`}
                  disabled={index === draft.widgets.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          {update.error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              Dashboard settings were not saved.
            </p>
          ) : null}
        </SectionCard>
      ) : null}
      {branchesDenied ? (
        <SectionCard title="Command centre restricted">
          <div role="status" className="space-y-3">
            <StatusPill status="Restricted" tone="warning" />
            <p className="text-sm text-text-body">
              Operational reports access is required. No protected values are shown, and the
              pharmacy tools in your menu remain available.
            </p>
          </div>
        </SectionCard>
      ) : branches.error ? (
        <SectionCard title="Command centre unavailable">
          <div role="alert" className="space-y-3">
            <StatusPill status="Unavailable" tone="warning" />
            <p className="text-sm text-text-body">
              The command centre could not load its branches. Other dashboard tools remain
              available.
            </p>
            <Button variant="outline" onClick={() => void branches.refetch()}>
              Retry
            </Button>
          </div>
        </SectionCard>
      ) : !branches.data ? (
        <SectionCard title="Loading command centre">
          <div role="status" aria-label="Loading command centre" className="min-h-56 space-y-3">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-full" />
          </div>
        </SectionCard>
      ) : branches.data.branches.length === 0 ? (
        <SectionCard title="No reportable branches">
          <p className="text-sm text-text-body">
            {'unassigned' in branches.data && branches.data.unassigned
              ? 'You are not assigned to a branch yet. Ask the owner to add you.'
              : 'Activate a pharmacy branch before using the command centre.'}
          </p>
        </SectionCard>
      ) : (
        <div data-testid="pharmacy-dashboard-grid" className="grid min-w-0 gap-5 lg:grid-cols-2">
          {command.data?.permissions.financial === false && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 text-sm text-text-muted lg:col-span-2"
            >
              <StatusPill status="Restricted" tone="neutral" />
              <span>Financial reports</span>
              <span>Financial reports access is required to see monetary figures.</span>
            </div>
          )}
          {layout.widgets
            .filter(
              (item) =>
                item.visible &&
                !(
                  definition.get(item.key)?.permission === 'reports:financial' &&
                  command.data?.permissions.financial === false
                )
            )
            .map((preference) => {
              const item = definition.get(preference.key)!;
              return (
                <section
                  data-widget={item.key}
                  key={item.key}
                  className={cn('min-w-0', preference.span === 'wide' && 'lg:col-span-2')}
                >
                  <SectionCard
                    eyebrow={plainReportPermission(item.permission)}
                    title={item.label}
                    titleLevel={2}
                    actions={
                      item.metrics[0] &&
                      catalog.data?.metrics.find((metric) => metric.key === item.metrics[0])
                        ?.drillThrough ? (
                        <Link
                          aria-label={`Open report: ${item.label}`}
                          className="text-sm font-medium text-text-strong underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          href={
                            catalog.data.metrics.find((metric) => metric.key === item.metrics[0])!
                              .drillThrough!
                          }
                        >
                          Open report
                        </Link>
                      ) : null
                    }
                  >
                    <p className="mb-4 text-sm text-text-muted">{item.description}</p>
                    <WidgetState
                      item={item}
                      query={command}
                      contracts={catalog.data?.metrics ?? []}
                      branchCount={branches.data?.branches.length ?? 0}
                      currency={catalog.data?.currency}
                      metricsReady={Boolean(catalog.data) || Boolean(catalog.error)}
                    />
                    {item.key === 'stock' && procurement ? (
                      // DEV-729: one entry to the per-distributor reorder board (DEV-678),
                      // which still checks procurement access on the server.
                      <Link
                        href={`/pharmacy/purchasing/reorder${branchId ? `?${new URLSearchParams({ branch: branchId })}` : ''}`}
                        className={buttonVariants({ variant: 'outline', className: 'mt-5' })}
                      >
                        <ShoppingCart aria-hidden />
                        Draft POs per distributor
                      </Link>
                    ) : null}
                  </SectionCard>
                </section>
              );
            })}
        </div>
      )}
    </div>
  );
}
