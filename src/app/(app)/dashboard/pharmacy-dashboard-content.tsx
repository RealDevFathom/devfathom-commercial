'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, RotateCcw, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import {
  PHARMACY_WIDGET_REGISTRY,
  pharmacyDashboardDefault,
  type PharmacyDashboardPreference,
} from '@/lib/pharmacy/dashboard';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

const today = () => new Date().toISOString().slice(0, 10);
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
const formatMetric = (key: string, value: number | null) =>
  value == null
    ? '—'
    : key.toLowerCase().includes('minor')
      ? `PKR ${(value / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : value.toLocaleString();

function WidgetState({
  item,
  query,
  contracts,
  branchCount,
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
}) {
  if (query.isLoading)
    return (
      <div aria-label={`Loading ${item.label}`} role="status" className="space-y-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  if (query.error) {
    const denied = ['FORBIDDEN', 'UNAUTHORIZED'].includes(query.error.data?.code ?? '');
    return (
      <div role={denied ? 'status' : 'alert'} className="space-y-3">
        <StatusPill status={denied ? 'Restricted' : 'Unavailable'} tone="warning" />
        <p className="text-sm text-text-body">
          {denied
            ? `${item.permission} is required. No protected values are shown.`
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
          reports:financial is required. No protected values are shown.
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
          label={contract?.label ?? item.metrics[index]}
          value={formatMetric(item.metrics[index]!, value)}
          sub={
            value == null
              ? 'Not available in this release'
              : `Source: ${contract?.source ?? 'Not asserted'}`
          }
        />
      ))}
    </div>
  );
}

export function PharmacyDashboardContent({ role }: { role: string | null | undefined }) {
  const utils = trpc.useUtils();
  const branches = trpc.pharmacyReports.branches.useQuery(undefined, { retry: false });
  const catalog = trpc.pharmacyReports.catalog.useQuery(undefined, { retry: false });
  const preferences = trpc.pharmacyReports.getPreferences.useQuery(undefined, { retry: false });
  const update = trpc.pharmacyReports.updatePreferences.useMutation();
  const [branchId, setBranchId] = useState('');
  const [editing, setEditing] = useState(false);
  const fallback = useMemo(() => pharmacyDashboardDefault(role), [role]);
  const [draft, setDraft] = useState<PharmacyDashboardPreference>(fallback);
  const draftRef = useRef(draft);
  const input = { ...(branchId ? { branchId } : {}), from: today(), to: today() };
  const command = trpc.pharmacyReports.commandCentre.useQuery(input, {
    enabled: Boolean(branches.data?.branches.length),
    retry: false,
  }) as unknown as CommandQuery;
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
    const saved = await update.mutateAsync(draftRef.current);
    utils.pharmacyReports.getPreferences.setData(undefined, saved);
    setEditing(false);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Pharmacy workspace"
        heading="Owner command centre"
        description="Live operational signals with visible source, freshness and permission boundaries."
        actions={
          <Button variant="outline" onClick={begin}>
            <Pencil aria-hidden />
            Edit dashboard
          </Button>
        }
      />
      <SectionCard
        eyebrow="Scope"
        title="Today at a glance"
        titleLevel={2}
        actions={command.data ? <StatusPill status="Current" tone="success" /> : null}
      >
        <label className="block max-w-sm space-y-1.5">
          <span className="eyebrow">Branch</span>
          <select
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
          </select>
        </label>
        <p className="mt-3 font-mono text-xs text-text-muted">
          {command.data
            ? `As of ${new Date(command.data.freshness.asOf).toLocaleString()} · ${command.data.freshness.source}`
            : 'Waiting for a reportable branch.'}
        </p>
      </SectionCard>
      {editing ? (
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
      {branches.error ? (
        <SectionCard title="Command centre unavailable">
          <WidgetState
            item={PHARMACY_WIDGET_REGISTRY[0]}
            query={command}
            contracts={[]}
            branchCount={0}
          />
        </SectionCard>
      ) : branches.data?.branches.length === 0 ? (
        <SectionCard title="No reportable branches">
          <p className="text-sm text-text-body">
            Activate a pharmacy branch before using the command centre.
          </p>
        </SectionCard>
      ) : (
        <div data-testid="pharmacy-dashboard-grid" className="grid min-w-0 gap-5 lg:grid-cols-2">
          {layout.widgets
            .filter((item) => item.visible)
            .map((preference) => {
              const item = definition.get(preference.key)!;
              return (
                <section
                  data-widget={item.key}
                  key={item.key}
                  className={cn('min-w-0', preference.span === 'wide' && 'lg:col-span-2')}
                >
                  <SectionCard
                    eyebrow={item.permission}
                    title={item.label}
                    titleLevel={2}
                    actions={
                      item.metrics[0] &&
                      catalog.data?.metrics.find((metric) => metric.key === item.metrics[0])
                        ?.drillThrough ? (
                        <Link
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
                    />
                  </SectionCard>
                </section>
              );
            })}
        </div>
      )}
    </div>
  );
}
