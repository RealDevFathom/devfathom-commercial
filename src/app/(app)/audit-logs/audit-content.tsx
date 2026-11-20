'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useDeferredValue, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Clock,
  Filter,
  Loader2,
  RotateCw,
  Download,
  ScrollText,
  Search,
  ShieldAlert,
  Sparkles,
  User as UserIcon,
  X,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { inferRouterOutputs } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  auditActionLabel,
  auditCategoryLabel,
  auditOperationLabel,
  auditRoleLabel,
} from '@/lib/audit-labels';
import { formatWorkspaceDateTime } from '@/lib/timezone';
import type { AppRouter } from '@/server/routers/_app';

type AuditEntry = inferRouterOutputs<AppRouter>['audit']['list']['items'][number];

const operationStyles: Record<string, string> = {
  CREATE: 'bg-emerald-500/10 text-emerald-500',
  UPDATE: 'bg-blue-500/10 text-blue-500',
  DELETE: 'bg-red-500/10 text-red-500',
  READ: 'bg-zinc-500/10 text-zinc-400',
  LOGIN: 'bg-violet-500/10 text-violet-500',
  LOGOUT: 'bg-zinc-500/10 text-zinc-400',
  LOGIN_FAILED: 'bg-red-500/10 text-red-500',
  EXECUTE: 'bg-amber-500/10 text-amber-500',
  OTHER: 'bg-zinc-500/10 text-zinc-400',
};

const sourceStyles: Record<string, string> = {
  TRPC: 'bg-blue-500/10 text-blue-500',
  REST_API: 'bg-violet-500/10 text-violet-500',
  AUTH: 'bg-amber-500/10 text-amber-500',
  SYSTEM: 'bg-zinc-500/10 text-zinc-400',
};

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        className
      )}
    >
      {children}
    </span>
  );
}

function selectClass() {
  return 'rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none';
}

/**
 * IMP-AI-02: an AI-assistant-originated write is recorded with an `assistant.`
 * action prefix and `metadata.via === 'assistant'`. Either marker flags the row
 * so AI-driven actions are visually distinct in the list and detail sheet.
 */
function isAssistantRow(row: AuditEntry): boolean {
  if (typeof row.action === 'string' && row.action.startsWith('assistant.')) return true;
  const meta = row.metadata;
  return (
    !!meta &&
    typeof meta === 'object' &&
    !Array.isArray(meta) &&
    (meta as Record<string, unknown>).via === 'assistant'
  );
}

function AssistantBadge() {
  return (
    <Pill className="bg-violet-500/10 text-violet-500">
      <Sparkles className="mr-1 h-2.5 w-2.5" />
      Assistant
    </Pill>
  );
}

const EMPTY_FILTERS = {
  search: '',
  category: '',
  source: '',
  operation: '',
  outcome: '',
  actorId: '',
  branchId: '',
  startDate: '',
  endDate: '',
  assistantOnly: '',
};

export function AuditContent({
  initialFilters = {},
  timeZone = null,
  pharmacy = false,
}: {
  initialFilters?: Partial<Pick<typeof EMPTY_FILTERS, 'actorId' | 'search' | 'branchId'>>;
  /** The workspace's time zone: every time on the page is read on its clock. */
  timeZone?: string | null;
  /** DEV-913: a pharmacy workspace names the page by what it answers. */
  pharmacy?: boolean;
}) {
  const utils = trpc.useUtils();
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS, ...initialFilters });
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const deferredSearch = useDeferredValue(filters.search);

  const queryInput = useMemo(
    () => ({
      search: deferredSearch.trim() || undefined,
      category: filters.category || undefined,
      source: (filters.source || undefined) as never,
      operation: (filters.operation || undefined) as never,
      outcome: (filters.outcome || undefined) as never,
      actorId: filters.actorId || undefined,
      branchId: filters.branchId || undefined,
      startDate: filters.startDate ? new Date(filters.startDate) : undefined,
      endDate: filters.endDate ? new Date(`${filters.endDate}T23:59:59`) : undefined,
      assistantOnly: filters.assistantOnly ? true : undefined,
      limit: 50,
    }),
    [
      deferredSearch,
      filters.category,
      filters.source,
      filters.operation,
      filters.outcome,
      filters.actorId,
      filters.branchId,
      filters.startDate,
      filters.endDate,
      filters.assistantOnly,
    ]
  );

  const { data: stats } = trpc.audit.stats.useQuery();
  const { data: filterOpts } = trpc.audit.filters.useQuery();

  const {
    data,
    error,
    isLoading,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = trpc.audit.list.useInfiniteQuery(queryInput, {
    getNextPageParam: (last) => last.nextCursor,
  });

  const rows = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  const hasActiveFilters = useMemo(
    () => Object.entries(filters).some(([, v]) => v !== ''),
    [filters]
  );

  const set = (key: keyof typeof filters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={pharmacy ? 'PHARMACY' : 'SYSTEM'}
        heading={pharmacy ? 'Audit log: who did what' : 'Audit Log'}
        description={
          pharmacy
            ? 'Every action in your pharmacy: who did it, at which branch, when, what changed and who approved it.'
            : 'Every action across the workspace — who did what, when, and from where.'
        }
        actions={
          <>
            {/* IMP-PLAT-04: export the loaded (filtered) audit rows to CSV. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
                const header = [
                  'Time',
                  'Workspace time',
                  'Actor',
                  'Email',
                  'Role',
                  'Branch',
                  'Action',
                  'Operation',
                  'Category',
                  'Target',
                  'Approved by',
                  'Outcome',
                ];
                const csv = [
                  header,
                  ...rows.map((r) => [
                    new Date(r.createdAt).toISOString(),
                    formatWorkspaceDateTime(r.createdAt, timeZone),
                    r.actorName ?? '',
                    r.actorEmail ?? '',
                    auditRoleLabel(r.actorRole) ?? '',
                    r.branchName ?? r.branchId ?? '',
                    auditActionLabel(r.action),
                    r.operation,
                    auditCategoryLabel(r.category),
                    r.targetLabel ?? '',
                    approverNames(r).join('; '),
                    r.outcome,
                  ]),
                ]
                  .map((row) => row.map(esc).join(','))
                  .join('\r\n');
                const url = URL.createObjectURL(
                  new Blob([csv], { type: 'text/csv;charset=utf-8;' })
                );
                const a = document.createElement('a');
                a.href = url;
                a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              disabled={rows.length === 0}
              title="Export the loaded audit rows to CSV"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                utils.audit.stats.invalidate();
                utils.audit.filters.invalidate();
                refetch();
              }}
            >
              <RotateCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
              Refresh
            </Button>
          </>
        }
      />

      {/* Stat strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile icon={Activity} label="Total events" value={stats?.total} tone="blue" />
        <StatTile icon={Clock} label="Last 24h" value={stats?.last24h} tone="violet" />
        <StatTile
          icon={AlertTriangle}
          label="Failures · 24h"
          value={stats?.failures24h}
          tone={stats && stats.failures24h > 0 ? 'amber' : 'emerald'}
        />
        <StatTile
          icon={ShieldAlert}
          label="Failures · all time"
          value={stats?.failures}
          tone={stats && stats.failures > 0 ? 'red' : 'emerald'}
        />
      </div>

      {/* Filters */}
      <Card className="border-border/60">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={filters.search}
                onChange={(e) => set('search', e.target.value)}
                placeholder="Search actor, action, target, IP, error…"
                className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </div>
            {hasActiveFilters && (
              <button
                onClick={() => setFilters({ ...EMPTY_FILTERS })}
                className="flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />

            <StudioSelect
              value={filters.category}
              onChange={(e) => set('category', e.target.value)}
              className={selectClass()}
            >
              <option value="">All categories</option>
              {filterOpts?.categories.map((c) => (
                <option key={c} value={c}>
                  {auditCategoryLabel(c)}
                </option>
              ))}
            </StudioSelect>

            <StudioSelect
              value={filters.operation}
              onChange={(e) => set('operation', e.target.value)}
              className={selectClass()}
            >
              <option value="">All operations</option>
              {filterOpts?.operations.map((o) => (
                <option key={o} value={o}>
                  {auditOperationLabel(o)}
                </option>
              ))}
            </StudioSelect>

            <StudioSelect
              value={filters.source}
              onChange={(e) => set('source', e.target.value)}
              className={selectClass()}
            >
              <option value="">All sources</option>
              {filterOpts?.sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </StudioSelect>

            <StudioSelect
              value={filters.outcome}
              onChange={(e) => set('outcome', e.target.value)}
              className={selectClass()}
            >
              <option value="">Any outcome</option>
              {filterOpts?.outcomes.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </StudioSelect>

            <StudioSelect
              value={filters.actorId}
              aria-label={pharmacy ? 'Person' : 'Actor'}
              onChange={(e) => set('actorId', e.target.value)}
              className={selectClass()}
            >
              <option value="">{pharmacy ? 'Everyone' : 'All actors'}</option>
              {filters.actorId && !filterOpts?.actors.some((a) => a.id === filters.actorId) ? (
                <option value={filters.actorId}>{filters.actorId}</option>
              ) : null}
              {filterOpts?.actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? a.id} ({a.count})
                </option>
              ))}
            </StudioSelect>

            {pharmacy || filters.branchId || (filterOpts?.branches.length ?? 0) > 0 ? (
              <StudioSelect
                value={filters.branchId}
                aria-label="Branch"
                onChange={(e) => set('branchId', e.target.value)}
                className={selectClass()}
              >
                <option value="">All branches</option>
                {filters.branchId &&
                !filterOpts?.branches.some((b) => b.id === filters.branchId) ? (
                  <option value={filters.branchId}>{filters.branchId}</option>
                ) : null}
                {filterOpts?.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.code})
                  </option>
                ))}
              </StudioSelect>
            ) : null}

            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={filters.startDate}
                onChange={(e) => set('startDate', e.target.value)}
                className={selectClass()}
                aria-label="From date"
              />
              <span className="text-xs text-muted-foreground">→</span>
              <input
                type="date"
                value={filters.endDate}
                onChange={(e) => set('endDate', e.target.value)}
                className={selectClass()}
                aria-label="To date"
              />
            </div>

            {/* IMP-AI-02: quick-filter to AI-assistant-originated writes only. */}
            <button
              type="button"
              onClick={() => set('assistantOnly', filters.assistantOnly ? '' : '1')}
              aria-pressed={!!filters.assistantOnly}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                filters.assistantOnly
                  ? 'border-violet-500/40 bg-violet-500/10 text-violet-500'
                  : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground'
              )}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Assistant actions
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Log table */}
      <Card className="border-border/60">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : error && rows.length === 0 ? (
            <div className="py-20 text-center" role="alert">
              <ShieldAlert className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-3 text-sm text-foreground">These entries could not be shown.</p>
              <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="py-20 text-center">
              <ScrollText className="mx-auto h-10 w-10 text-muted-foreground/20" />
              <p className="mt-3 text-sm text-muted-foreground">
                {hasActiveFilters ? 'No events match these filters.' : 'No audit events yet.'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {rows.map((row) => (
                <AuditRow
                  key={row.id}
                  row={row}
                  timeZone={timeZone}
                  onClick={() => setSelected(row)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {hasNextPage && (
        <div className="flex justify-center">
          <button
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            {isFetchingNextPage ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
              </>
            ) : (
              'Load more'
            )}
          </button>
        </div>
      )}

      <AuditDetailSheet entry={selected} timeZone={timeZone} onClose={() => setSelected(null)} />
    </div>
  );
}

/* ============================================================
   One log row
   ============================================================ */
function approverNames(row: AuditEntry): string[] {
  return row.approvers.map((approver) => approver.name ?? approver.id);
}

function AuditRow({
  row,
  timeZone,
  onClick,
}: {
  row: AuditEntry;
  timeZone: string | null;
  onClick: () => void;
}) {
  const created = new Date(row.createdAt);
  const role = auditRoleLabel(row.actorRole);
  const approvers = approverNames(row);
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-secondary/40"
    >
      {/* Actor */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <ActorIcon actorType={row.actorType} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {row.actorName ?? row.actorEmail ?? 'Anonymous'}
            {role && (
              <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                {role}
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            <span>{auditActionLabel(row.action)}</span>
            {row.targetLabel ? <span> · {row.targetLabel}</span> : null}
            {row.branchName ? <span> · {row.branchName}</span> : null}
            {approvers.length ? <span> · Approved by {approvers.join(', ')}</span> : null}
          </p>
        </div>
      </div>

      {/* Badges */}
      <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
        {isAssistantRow(row) && <AssistantBadge />}
        <Pill className={operationStyles[row.operation] ?? operationStyles.OTHER}>
          {auditOperationLabel(row.operation)}
        </Pill>
        <Pill className="bg-secondary text-muted-foreground">
          {auditCategoryLabel(row.category)}
        </Pill>
        <Pill className={sourceStyles[row.source] ?? sourceStyles.SYSTEM}>{row.source}</Pill>
      </div>

      {/* Outcome */}
      <div className="shrink-0">
        {row.outcome === 'SUCCESS' ? (
          <Pill className="bg-emerald-500/10 text-emerald-500">OK</Pill>
        ) : (
          <Pill className="bg-red-500/10 text-red-500">FAIL</Pill>
        )}
      </div>

      {/* Time */}
      <div
        className="hidden w-36 shrink-0 text-right md:block"
        title={formatWorkspaceDateTime(created, timeZone)}
      >
        <p className="text-xs text-foreground">
          {formatDistanceToNow(created, { addSuffix: true })}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {formatWorkspaceDateTime(created, timeZone)}
        </p>
      </div>
    </button>
  );
}

function ActorIcon({ actorType }: { actorType: AuditEntry['actorType'] }) {
  const Icon = actorType === 'API_TOKEN' ? Bot : actorType === 'ANONYMOUS' ? ShieldAlert : UserIcon;
  const tone =
    actorType === 'API_TOKEN'
      ? 'bg-violet-500/10 text-violet-500'
      : actorType === 'ANONYMOUS'
        ? 'bg-amber-500/10 text-amber-500'
        : 'bg-blue-500/10 text-blue-500';
  return (
    <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', tone)}>
      <Icon className="h-4 w-4" />
    </div>
  );
}

/* ============================================================
   Detail sheet — the full granular record
   ============================================================ */
function AuditDetailSheet({
  entry,
  timeZone,
  onClose,
}: {
  entry: AuditEntry | null;
  timeZone: string | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!entry} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        {entry && (
          <>
            <SheetHeader className="border-b border-border/60">
              <SheetTitle className="flex flex-wrap items-center gap-2 text-sm">
                {auditActionLabel(entry.action)}
                {isAssistantRow(entry) && <AssistantBadge />}
                <Pill className={operationStyles[entry.operation] ?? operationStyles.OTHER}>
                  {auditOperationLabel(entry.operation)}
                </Pill>
              </SheetTitle>
              <SheetDescription>
                {formatWorkspaceDateTime(entry.createdAt, timeZone)} ·{' '}
                {entry.outcome === 'SUCCESS' ? 'Succeeded' : 'Failed'}
                {typeof entry.durationMs === 'number' ? ` · ${entry.durationMs}ms` : ''}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-8">
              {entry.outcome === 'FAILURE' && entry.errorMessage && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                  <p className="text-xs font-medium text-red-500">
                    {entry.errorCode ? `${entry.errorCode}: ` : ''}
                    {entry.errorMessage}
                  </p>
                </div>
              )}

              <Section title="Who">
                <Field label="Actor" value={entry.actorName ?? '—'} />
                <Field label="Email" value={entry.actorEmail ?? '—'} mono />
                <Field label="Role" value={auditRoleLabel(entry.actorRole) ?? '—'} />
                <Field label="Branch" value={entry.branchName ?? entry.branchId ?? '—'} />
                <Field label="Approved by" value={approverNames(entry).join(', ') || '—'} />
                <Field label="Actor type" value={entry.actorType} />
                <Field label="Actor ID" value={entry.actorId ?? '—'} mono />
                {entry.tokenName && <Field label="API token" value={entry.tokenName} />}
                {entry.tokenId && <Field label="Token ID" value={entry.tokenId} mono />}
              </Section>

              <Section title="What">
                <Field label="Action" value={auditActionLabel(entry.action)} />
                <Field label="Category" value={auditCategoryLabel(entry.category)} />
                <Field label="Operation" value={auditOperationLabel(entry.operation)} />
                <Field label="Time" value={formatWorkspaceDateTime(entry.createdAt, timeZone)} />
                <Field label="Technical name" value={entry.action} mono />
                <Field label="Source" value={entry.source} />
                {entry.description && <Field label="Description" value={entry.description} />}
              </Section>

              {(entry.targetType || entry.targetId || entry.targetLabel) && (
                <Section title="Target">
                  {entry.targetLabel && <Field label="Label" value={entry.targetLabel} />}
                  {entry.targetType && <Field label="Type" value={entry.targetType} />}
                  {entry.targetId && <Field label="ID" value={entry.targetId} mono />}
                </Section>
              )}

              {entry.changes && Object.keys(entry.changes as object).length > 0 && (
                <Section title="Changes">
                  <ChangeDiff changes={entry.changes as Record<string, ChangeEntry>} />
                </Section>
              )}

              <Section title="Context">
                <Field label="IP address" value={entry.ip ?? '—'} mono />
                <Field label="User agent" value={entry.userAgent ?? '—'} />
                {entry.httpMethod && <Field label="HTTP method" value={entry.httpMethod} />}
                {entry.path && <Field label="Path" value={entry.path} mono />}
                {typeof entry.statusCode === 'number' && (
                  <Field label="Status code" value={String(entry.statusCode)} />
                )}
                {typeof entry.durationMs === 'number' && (
                  <Field label="Duration" value={`${entry.durationMs}ms`} />
                )}
              </Section>

              {entry.input != null && <JsonSection title="Input" value={entry.input} />}
              {entry.result != null && <JsonSection title="Result" value={entry.result} />}
              {entry.metadata != null && <JsonSection title="Metadata" value={entry.metadata} />}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

type ChangeEntry = { before: unknown; after: unknown };

function ChangeDiff({ changes }: { changes: Record<string, ChangeEntry> }) {
  return (
    <div className="space-y-2">
      {Object.entries(changes).map(([field, { before, after }]) => (
        <div key={field} className="rounded-lg border border-border/60 bg-secondary/30 p-2.5">
          <p className="mb-1 font-mono text-[11px] font-medium text-foreground">{field}</p>
          <div className="flex items-center gap-2 text-xs">
            <code className="rounded bg-red-500/10 px-1.5 py-0.5 text-red-500 line-through break-all">
              {fmtVal(before)}
            </code>
            <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            <code className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-500 break-all">
              {fmtVal(after)}
            </code>
          </div>
        </div>
      ))}
    </div>
  );
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn('min-w-0 break-all text-right text-foreground', mono && 'font-mono text-xs')}
      >
        {value}
      </span>
    </div>
  );
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  return (
    <Section title={title}>
      <pre className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-secondary/30 p-3 text-[11px] leading-relaxed text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </Section>
  );
}

/* ============================================================
   Stat tile
   ============================================================ */
function StatTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | undefined;
  tone: 'blue' | 'violet' | 'amber' | 'emerald' | 'red';
}) {
  const tones: Record<string, { bg: string; text: string }> = {
    blue: { bg: 'bg-blue-500/10', text: 'text-blue-500' },
    violet: { bg: 'bg-violet-500/10', text: 'text-violet-500' },
    amber: { bg: 'bg-amber-500/10', text: 'text-amber-500' },
    emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-500' },
    red: { bg: 'bg-red-500/10', text: 'text-red-500' },
  };
  const t = tones[tone];
  return (
    <Card className="border-border/60">
      <CardContent className="p-5">
        <div className="flex items-center gap-2">
          <div className={cn('flex h-7 w-7 items-center justify-center rounded-md', t.bg)}>
            <Icon className={cn('h-3.5 w-3.5', t.text)} />
          </div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
        </div>
        <p className={cn('mt-2 font-display text-3xl font-bold tabular-nums', t.text)}>
          {value ?? '—'}
        </p>
      </CardContent>
    </Card>
  );
}
