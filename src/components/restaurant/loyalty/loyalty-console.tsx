'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { browserUuid } from '@/lib/browser-uuid';

import type { inferRouterOutputs } from '@trpc/server';
import { Download, Search, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { trpc } from '@/lib/trpc';
import { RestaurantBranchSelect } from '../restaurant-branch-select';
import { OperatorSafeSelector } from '../operator-safe-selector';
import type { AppRouter } from '@/server/routers/_app';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type Customer = RouterOutputs['restaurantCustomers']['detail'];
type Program = RouterOutputs['restaurantLoyalty']['listPrograms'][number];
type LedgerEntry = RouterOutputs['restaurantLoyalty']['listLedger'][number];

const CONSENT_CHANNELS = ['EMAIL', 'SMS', 'PHONE', 'WHATSAPP', 'PUSH'] as const;
const selectClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

function formatDate(value: Date | string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}

function customerName(customer: {
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
}) {
  return (
    customer.displayName ||
    [customer.givenName, customer.familyName].filter(Boolean).join(' ') ||
    'Unnamed customer'
  );
}

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('data' in error)) return undefined;
  return (error as { data?: { code?: string } }).data?.code;
}

function denied(error: unknown) {
  return ['FORBIDDEN', 'UNAUTHORIZED'].includes(errorCode(error) ?? '');
}

function message(error: unknown) {
  return denied(error)
    ? 'Action denied by server. Your current capability set does not permit this operation.'
    : 'Command failed. No data was changed. Try again.';
}

function Field({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm font-medium text-text-body">
      {label}
      {children}
      {detail ? (
        <span className="mt-1 block text-xs font-normal text-text-muted">{detail}</span>
      ) : null}
    </label>
  );
}

function TableRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="overflow-x-auto rounded-[var(--radius-sm)] border border-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_[data-slot=table-container]]:overflow-visible"
    >
      {children}
    </div>
  );
}

function StateCard({
  title,
  detail,
  tone = 'neutral',
  action,
  status = 'Unavailable',
}: {
  title: string;
  detail: string;
  tone?: 'neutral' | 'warning' | 'danger';
  action?: ReactNode;
  status?: string;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border-subtle bg-card p-5">
      <p className="text-lg font-semibold text-text-strong">{title}</p>
      <div className="space-y-3">
        <StatusPill className="mt-3" status={status} tone={tone} />
        <p className="max-w-2xl text-sm leading-relaxed text-text-muted">{detail}</p>
        {action}
      </div>
    </div>
  );
}

function ConsoleSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading customer records">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <SectionCard key={index}>
            <Skeleton className="h-20 w-full" />
          </SectionCard>
        ))}
      </div>
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.25fr)]">
        <SectionCard title="Loading customers…">
          <Skeleton className="h-72 w-full" />
        </SectionCard>
        <SectionCard title="Loading customer detail…">
          <Skeleton className="h-72 w-full" />
        </SectionCard>
      </div>
    </div>
  );
}

function currentProgram(programs: Program[]) {
  const now = Date.now();
  return programs.find((program) => new Date(program.effectiveFrom).getTime() <= now) ?? null;
}

function programStatus(program: Program, current: Program | null) {
  if (program.id === current?.id) return { status: 'Effective', tone: 'success' as const };
  if (new Date(program.effectiveFrom).getTime() > Date.now())
    return { status: 'Scheduled', tone: 'info' as const };
  return { status: 'Historical', tone: 'neutral' as const };
}

export function LoyaltyConsole() {
  const entitlements = useEntitlements();
  const moduleView = entitlements.modules.find((module) => module.key === 'restaurant-loyalty');
  const moduleEnabled =
    moduleView?.enabled ?? entitlements.enabledModules.includes('restaurant-loyalty');
  const utils = trpc.useUtils();
  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: moduleEnabled,
  });

  const [search, setSearch] = useState('');
  const [tagId, setTagId] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  const customersQuery = trpc.restaurantCustomers.list.useQuery(
    {
      ...(search.trim() ? { query: search.trim() } : {}),
      ...(tagId ? { tagId } : {}),
      limit: 50,
    },
    { enabled: moduleEnabled }
  );
  const tagsQuery = trpc.restaurantCustomers.listTags.useQuery({}, { enabled: moduleEnabled });
  const programsQuery = trpc.restaurantLoyalty.listPrograms.useQuery(
    { limit: 100 },
    { enabled: moduleEnabled }
  );
  const accountsQuery = trpc.restaurantLoyalty.listAccounts.useQuery(
    { limit: 100 },
    { enabled: moduleEnabled }
  );

  const customers = customersQuery.data?.customers ?? [];
  const activeCustomerId =
    (selectedCustomerId && customers.some((customer) => customer.id === selectedCustomerId)
      ? selectedCustomerId
      : customers[0]?.id) ?? null;
  const detailQuery = trpc.restaurantCustomers.detail.useQuery(
    { customerId: activeCustomerId ?? '' },
    { enabled: moduleEnabled && Boolean(activeCustomerId) }
  );
  const accountId = detailQuery.data?.loyaltySummary?.id ?? null;
  const accountQuery = trpc.restaurantLoyalty.getAccount.useQuery(
    { id: accountId ?? '' },
    { enabled: moduleEnabled && Boolean(accountId) }
  );
  const ledgerQuery = trpc.restaurantLoyalty.listLedger.useQuery(
    { accountId: accountId ?? undefined, limit: 200 },
    { enabled: moduleEnabled && Boolean(accountId) }
  );

  const refreshCustomer = () => {
    void utils.restaurantCustomers.list.invalidate();
    if (activeCustomerId) {
      void utils.restaurantCustomers.detail.invalidate({ customerId: activeCustomerId });
    }
  };
  const refreshLoyalty = () => {
    void utils.restaurantLoyalty.listAccounts.invalidate();
    void utils.restaurantLoyalty.listPrograms.invalidate();
    if (accountId) {
      void utils.restaurantLoyalty.getAccount.invalidate({ id: accountId });
      void utils.restaurantLoyalty.listLedger.invalidate({ accountId, limit: 200 });
    }
    refreshCustomer();
  };
  const success = (text: string, refresh: () => void = refreshCustomer) => {
    setActionError('');
    setNotice(text);
    refresh();
  };
  const fail = (error: unknown) => {
    setNotice('');
    setActionError(message(error));
  };

  const assignTag = trpc.restaurantCustomers.assignTag.useMutation({
    onSuccess: () => success('Tag assigned.'),
    onError: fail,
  });
  const unassignTag = trpc.restaurantCustomers.unassignTag.useMutation({
    onSuccess: () => success('Tag removed.'),
    onError: fail,
  });
  const appendConsent = trpc.restaurantCustomers.appendConsent.useMutation({
    onSuccess: () => success('Consent event appended.'),
    onError: fail,
  });
  const appendInteraction = trpc.restaurantCustomers.appendInteraction.useMutation({
    onSuccess: () => success('Interaction appended.'),
    onError: fail,
  });
  const exportCustomer = trpc.restaurantCustomers.export.useMutation({
    onSuccess: (data) => {
      const href = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      );
      const link = document.createElement('a');
      link.href = href;
      link.download = 'customer-export.json';
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      success('Customer export downloaded.', () => undefined);
    },
    onError: fail,
  });
  const anonymizeCustomer = trpc.restaurantCustomers.anonymize.useMutation({
    onSuccess: () => {
      setConfirmOpen(false);
      setConfirmation('');
      setSelectedCustomerId(null);
      success('Customer anonymized.', refreshLoyalty);
    },
    onError: fail,
  });
  const enrollAccount = trpc.restaurantLoyalty.enrollAccount.useMutation({
    onSuccess: () => success('Loyalty account enrolled.', refreshLoyalty),
    onError: fail,
  });
  const configureProgram = trpc.restaurantLoyalty.configure.useMutation({
    onSuccess: () => success('Program version created.', refreshLoyalty),
    onError: fail,
  });
  const adjustPoints = trpc.restaurantLoyalty.adjust.useMutation({
    onSuccess: () => success('Points adjustment appended.', refreshLoyalty),
    onError: fail,
  });

  const busy =
    assignTag.isPending ||
    unassignTag.isPending ||
    appendConsent.isPending ||
    appendInteraction.isPending ||
    exportCustomer.isPending ||
    anonymizeCustomer.isPending ||
    enrollAccount.isPending ||
    configureProgram.isPending ||
    adjustPoints.isPending;

  const baseErrors = [
    customersQuery.error,
    tagsQuery.error,
    programsQuery.error,
    accountsQuery.error,
  ].filter(Boolean);
  const readDenied = baseErrors.some(denied);
  const loading = [customersQuery, tagsQuery, programsQuery, accountsQuery].some(
    (query) => query.isLoading
  );
  const programs = programsQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];
  const effectiveProgram = currentProgram(programs);
  const ledger = ledgerQuery.data ?? [];
  const redemptions = ledger.filter((entry) => entry.kind === 'REDEEM');
  const selectedAccount = accountQuery.data ?? accounts.find((account) => account.id === accountId);
  const availableTags =
    tagsQuery.data?.filter(
      (tag) => !detailQuery.data?.tags.some((assignment) => assignment.id === tag.id)
    ) ?? [];

  const submitTag = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeCustomerId || busy) return;
    const data = new FormData(event.currentTarget);
    const nextTagId = String(data.get('tagId') ?? '');
    if (nextTagId) assignTag.mutate({ customerId: activeCustomerId, tagId: nextTagId });
  };
  const submitConsent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeCustomerId || busy) return;
    const data = new FormData(event.currentTarget);
    appendConsent.mutate({
      customerId: activeCustomerId,
      channel: String(data.get('channel')) as (typeof CONSENT_CHANNELS)[number],
      granted: data.get('granted') === 'true',
      source: String(data.get('source') ?? '').trim(),
      policyVersion: String(data.get('policyVersion') ?? '').trim(),
      idempotencyKey: browserUuid(),
    });
  };
  const submitInteraction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeCustomerId || busy) return;
    const data = new FormData(event.currentTarget);
    const orderId = String(data.get('orderId') ?? '').trim();
    appendInteraction.mutate({
      customerId: activeCustomerId,
      branchId: String(data.get('branchId') ?? '').trim(),
      type: String(data.get('type') ?? '').trim(),
      ...(orderId ? { orderId } : {}),
      idempotencyKey: browserUuid(),
    });
  };
  const submitProgram = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const expiryDays = String(data.get('expiryDays') ?? '').trim();
    configureProgram.mutate({
      effectiveFrom: new Date(String(data.get('effectiveFrom'))).toISOString(),
      earnRate: String(data.get('earnRate') ?? ''),
      redemptionValue: String(data.get('redemptionValue') ?? ''),
      expiryDays: expiryDays ? Number(expiryDays) : null,
    });
  };
  const submitAdjustment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accountId || busy) return;
    const data = new FormData(event.currentTarget);
    adjustPoints.mutate({
      accountId,
      points: Number(data.get('points')),
      reason: String(data.get('reason') ?? '').trim(),
      idempotencyKey: browserUuid(),
    });
  };

  const header = (
    <PageHeader
      eyebrow="Restaurant operations"
      heading="Customers & Loyalty"
      description="Search customer history, record consent and interactions, and operate append-only loyalty ledgers."
    />
  );

  if (!moduleEnabled) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <StateCard
          title="Customers & Loyalty module disabled"
          detail="Enable the Customers and Loyalty module to access customer records and loyalty operations."
          status="Disabled"
          tone="warning"
        />
      </div>
    );
  }

  if (readDenied) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <StateCard
          title="Customers & Loyalty access denied"
          detail="The server denied customer-read access. Cached customer and loyalty data is not shown."
          status="Permission denied"
          tone="danger"
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <ConsoleSkeleton />
      </div>
    );
  }

  if (baseErrors.length) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <StateCard
          title="Customers & Loyalty could not load"
          detail="No data was changed. Retry the customer, tag, account, and program reads."
          status="Error"
          tone="danger"
          action={
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              onClick={() => {
                void customersQuery.refetch();
                void tagsQuery.refetch();
                void programsQuery.refetch();
                void accountsQuery.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      {header}

      <p className="sr-only">
        Controls reflect module state only. Server authorization and tenant scope are rechecked for
        every read and command.
      </p>

      {notice ? (
        <div
          role="status"
          className="rounded-[var(--radius-sm)] border border-success/30 bg-success/10 p-3 text-sm text-success"
        >
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {actionError}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SectionCard>
          <Stat label="Customers shown" value={customers.length} sub="Current search page" />
        </SectionCard>
        <SectionCard>
          <Stat
            label="Active loyalty"
            value={accounts.filter((account) => account.active).length}
            sub="Across loaded accounts"
          />
        </SectionCard>
        <SectionCard>
          <Stat
            label="Selected balance"
            value={selectedAccount?.balance ?? '—'}
            sub="Derived from append-only entries"
          />
        </SectionCard>
        <SectionCard>
          <Stat
            label="Effective program"
            value={effectiveProgram ? `v${effectiveProgram.versionNumber}` : '—'}
            sub={effectiveProgram ? formatDate(effectiveProgram.effectiveFrom) : 'Not configured'}
          />
        </SectionCard>
      </div>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.25fr)]">
        <SectionCard eyebrow="Customer registry" title="Search and select" titleLevel={2}>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem] xl:grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_12rem]">
            <Field label="Search customers">
              <span className="relative mt-1 block">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-faint"
                />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Name, email, or phone"
                  className="min-h-11 pl-9"
                />
              </span>
            </Field>
            <Field label="Filter by tag">
              <StudioSelect
                value={tagId}
                onChange={(event) => setTagId(event.target.value)}
                className={selectClass}
              >
                <option value="">All tags</option>
                {tagsQuery.data?.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </StudioSelect>
            </Field>
          </div>

          <div className="mt-4">
            {customers.length ? (
              <TableRegion label="Customer search results">
                <Table className="min-w-[34rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Customer</TableHead>
                      <TableHead>Identifiers</TableHead>
                      <TableHead>Tags</TableHead>
                      <TableHead className="text-right">Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customers.map((customer) => (
                      <TableRow
                        key={customer.id}
                        data-state={customer.id === activeCustomerId ? 'selected' : undefined}
                        tabIndex={0}
                        className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => setSelectedCustomerId(customer.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedCustomerId(customer.id);
                          }
                        }}
                      >
                        <TableCell className="font-medium text-text-strong">
                          {customerName(customer)}
                        </TableCell>
                        <TableCell>{customer.identifiers.length}</TableCell>
                        <TableCell>
                          {customer.tags.map((tag) => tag.name).join(', ') || '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="min-h-11"
                            aria-pressed={customer.id === activeCustomerId}
                            onClick={() => setSelectedCustomerId(customer.id)}
                          >
                            {customer.id === activeCustomerId ? 'Selected' : 'View'}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableRegion>
            ) : (
              <div className="py-10 text-center">
                <h2 className="text-lg font-semibold text-text-strong">No customers found</h2>
                <p className="mt-2 text-sm text-text-muted">
                  Adjust the search or tag filter. No customer data was changed.
                </p>
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard eyebrow="Selected record" title="Customer detail">
          {!activeCustomerId ? (
            <div className="py-10 text-center">
              <h2 className="text-lg font-semibold text-text-strong">No customer selected</h2>
              <p className="mt-2 text-sm text-text-muted">
                Choose a customer to load identity, consent, activity, and loyalty data.
              </p>
            </div>
          ) : detailQuery.isLoading ? (
            <div className="space-y-3" role="status" aria-label="Loading customer detail">
              <Skeleton className="h-8 w-52" />
              <Skeleton className="h-56 w-full" />
            </div>
          ) : denied(detailQuery.error) ? (
            <StateCard
              title="Customer detail access denied"
              detail="The server denied this customer-scoped read. Cached profile data is not shown."
              status="Permission denied"
              tone="danger"
            />
          ) : detailQuery.error || !detailQuery.data ? (
            <StateCard
              title="Customer detail could not load"
              detail="No data was changed. Retry this customer-scoped read."
              status="Error"
              tone="danger"
              action={
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11"
                  onClick={() => void detailQuery.refetch()}
                >
                  Retry detail
                </Button>
              }
            />
          ) : (
            <CustomerDetail
              customer={detailQuery.data}
              availableTags={availableTags}
              busy={busy}
              onAssignTag={submitTag}
              onRemoveTag={(nextTagId) =>
                unassignTag.mutate({ customerId: detailQuery.data.id, tagId: nextTagId })
              }
              onAppendConsent={submitConsent}
              onAppendInteraction={submitInteraction}
              branches={branchesQuery.data ?? []}
              branchesLoading={branchesQuery.isLoading}
              branchesError={Boolean(branchesQuery.error)}
            />
          )}
        </SectionCard>
      </div>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <SectionCard eyebrow="Account" title="Loyalty balance and controls">
          {!detailQuery.data ? (
            <p className="text-sm text-text-muted">Select a customer before operating loyalty.</p>
          ) : !accountId ? (
            <div className="space-y-4">
              <StateCard
                title="No loyalty account"
                detail="Enroll this customer to create an active account under the current program."
                status="Not enrolled"
              />
              <Button
                type="button"
                className="min-h-11"
                disabled={busy || !effectiveProgram}
                onClick={() => enrollAccount.mutate({ customerId: detailQuery.data.id })}
              >
                {enrollAccount.isPending ? 'Enrolling…' : 'Enroll loyalty account'}
              </Button>
              {!effectiveProgram ? (
                <p className="text-xs text-text-muted">Configure an effective program first.</p>
              ) : null}
            </div>
          ) : accountQuery.isLoading ? (
            <div role="status" aria-label="Loading loyalty account">
              <Skeleton className="h-44 w-full" />
            </div>
          ) : denied(accountQuery.error) ? (
            <StateCard
              title="Loyalty account access denied"
              detail="The server denied this account-scoped read. Cached balances are not shown."
              status="Permission denied"
              tone="danger"
            />
          ) : accountQuery.error ? (
            <StateCard
              title="Loyalty account could not load"
              detail="No points were changed. Retry the account read."
              status="Error"
              tone="danger"
              action={
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11"
                  onClick={() => void accountQuery.refetch()}
                >
                  Retry account
                </Button>
              }
            />
          ) : selectedAccount ? (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Stat label="Points balance" value={selectedAccount.balance} />
                <div className="space-y-2">
                  <p className="font-mono text-xs uppercase tracking-wider text-text-muted">
                    State
                  </p>
                  <StatusPill
                    status={selectedAccount.active ? 'Active' : 'Inactive'}
                    tone={selectedAccount.active ? 'success' : 'warning'}
                  />
                  <p className="text-xs text-text-muted">
                    Enrolled {formatDate(selectedAccount.enrolledAt)}
                  </p>
                </div>
              </div>
              <form onSubmit={submitAdjustment} className="space-y-3">
                <h3 className="font-semibold text-text-strong">Manual adjustment</h3>
                <p className="text-sm text-text-muted">
                  Creates a new ledger entry. Existing points entries never change.
                </p>
                <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                  <Field label="Points">
                    <Input
                      name="points"
                      type="number"
                      step={1}
                      required
                      className="mt-1 min-h-11"
                      disabled={busy || !selectedAccount.active}
                    />
                  </Field>
                  <Field label="Reason">
                    <Input
                      name="reason"
                      required
                      maxLength={2000}
                      className="mt-1 min-h-11"
                      disabled={busy || !selectedAccount.active}
                    />
                  </Field>
                </div>
                <Button
                  type="submit"
                  className="min-h-11"
                  disabled={busy || !selectedAccount.active}
                >
                  {adjustPoints.isPending ? 'Appending…' : 'Append adjustment'}
                </Button>
              </form>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard eyebrow="Append-only history" title="Points ledger">
          {!accountId ? (
            <p className="text-sm text-text-muted">No loyalty ledger for this customer.</p>
          ) : ledgerQuery.isLoading ? (
            <div role="status" aria-label="Loading points ledger">
              <Skeleton className="h-56 w-full" />
            </div>
          ) : denied(ledgerQuery.error) ? (
            <StateCard
              title="Loyalty ledger access denied"
              detail="The server denied this account-scoped read. Cached entries are not shown."
              status="Permission denied"
              tone="danger"
            />
          ) : ledgerQuery.error ? (
            <StateCard
              title="Points ledger could not load"
              detail="No points were changed. Retry the append-only ledger read."
              status="Error"
              tone="danger"
              action={
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11"
                  onClick={() => void ledgerQuery.refetch()}
                >
                  Retry ledger
                </Button>
              }
            />
          ) : ledger.length ? (
            <TableRegion label="Loyalty points ledger">
              <Table className="min-w-[48rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Occurred</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Program</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead numeric>Points</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ledger.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>{formatDate(entry.occurredAt)}</TableCell>
                      <TableCell>
                        <StatusPill
                          status={entry.kind}
                          tone={entry.points < 0 ? 'warning' : 'success'}
                        />
                      </TableCell>
                      <TableCell>v{entry.programVersion.versionNumber}</TableCell>
                      <TableCell className="max-w-64 truncate">{entry.reason || '—'}</TableCell>
                      <TableCell numeric className={entry.points < 0 ? 'text-destructive' : ''}>
                        {entry.points > 0 ? '+' : ''}
                        {entry.points}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableRegion>
          ) : (
            <p className="py-8 text-center text-sm text-text-muted">
              No points entries yet. Enroll or append an adjustment to begin the ledger.
            </p>
          )}
        </SectionCard>
      </div>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
        <SectionCard eyebrow="Effective dating" title="Immutable program versions">
          {programs.length ? (
            <TableRegion label="Loyalty program versions">
              <Table className="min-w-[44rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Effective from</TableHead>
                    <TableHead numeric>Earn rate</TableHead>
                    <TableHead numeric>Redemption value</TableHead>
                    <TableHead numeric>Expiry days</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {programs.map((program) => {
                    const state = programStatus(program, effectiveProgram);
                    return (
                      <TableRow key={program.id}>
                        <TableCell className="font-mono">v{program.versionNumber}</TableCell>
                        <TableCell>
                          <StatusPill status={state.status} tone={state.tone} />
                        </TableCell>
                        <TableCell>{formatDate(program.effectiveFrom)}</TableCell>
                        <TableCell numeric>{program.earnRate}</TableCell>
                        <TableCell numeric>{program.redemptionValue}</TableCell>
                        <TableCell numeric>{program.expiryDays ?? 'Never'}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableRegion>
          ) : (
            <p className="py-8 text-center text-sm text-text-muted">
              No program versions yet. Create the first effective configuration.
            </p>
          )}
        </SectionCard>

        <SectionCard eyebrow="New version" title="Configure program">
          <form onSubmit={submitProgram} className="space-y-3">
            <p className="text-sm text-text-muted">
              Creates a new version. Effective and historical versions remain immutable.
            </p>
            <Field label="Effective from">
              <Input
                name="effectiveFrom"
                type="datetime-local"
                required
                className="mt-1 min-h-11"
                disabled={busy}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Earn rate">
                <Input
                  name="earnRate"
                  type="number"
                  min={0}
                  step="0.000001"
                  required
                  className="mt-1 min-h-11"
                  disabled={busy}
                />
              </Field>
              <Field label="Redemption value">
                <Input
                  name="redemptionValue"
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  required
                  className="mt-1 min-h-11"
                  disabled={busy}
                />
              </Field>
            </div>
            <Field label="Expiry days" detail="Leave blank for no automatic expiry.">
              <Input
                name="expiryDays"
                type="number"
                min={1}
                max={36500}
                step={1}
                className="mt-1 min-h-11"
                disabled={busy}
              />
            </Field>
            <Button type="submit" className="min-h-11" disabled={busy}>
              {configureProgram.isPending ? 'Creating…' : 'Create program version'}
            </Button>
            <p className="text-xs text-text-muted">
              Server authorization and organization scope are checked on submission.
            </p>
          </form>
        </SectionCard>
      </div>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.65fr)]">
        <SectionCard eyebrow="Redemptions" title="Redemption history">
          {redemptions.length ? (
            <TableRegion label="Loyalty redemption history">
              <Table className="min-w-[36rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Occurred</TableHead>
                    <TableHead>Bill</TableHead>
                    <TableHead>Program</TableHead>
                    <TableHead numeric>Points</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {redemptions.map((entry: LedgerEntry) => (
                    <TableRow key={entry.id}>
                      <TableCell>{formatDate(entry.occurredAt)}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.billId || '—'}</TableCell>
                      <TableCell>v{entry.programVersion.versionNumber}</TableCell>
                      <TableCell numeric className="text-destructive">
                        {entry.points}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableRegion>
          ) : (
            <p className="py-8 text-center text-sm text-text-muted">
              No redemption entries for the selected account.
            </p>
          )}
        </SectionCard>

        <SectionCard eyebrow="Privacy operations" title="Customer-scoped controls">
          {detailQuery.data ? (
            <div className="space-y-5">
              <div>
                <h3 className="font-semibold text-text-strong">Export customer data</h3>
                <p className="mt-1 text-sm leading-relaxed text-text-muted">
                  Downloads the server-produced customer-scoped JSON. Audit text records the
                  operation without copying profile or contact fields.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  className="mt-3 min-h-11"
                  disabled={busy}
                  onClick={() => exportCustomer.mutate({ customerId: detailQuery.data.id })}
                >
                  <Download aria-hidden />
                  {exportCustomer.isPending ? 'Preparing…' : 'Export customer JSON'}
                </Button>
              </div>
              <div className="border-t border-border-subtle pt-5">
                <h3 className="font-semibold text-destructive">Anonymize customer</h3>
                <p className="mt-1 text-sm leading-relaxed text-text-muted">
                  Permanently removes identifiers and profile fields, detaches tags, and deactivates
                  loyalty. Orders and financial records remain.
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  className="mt-3 min-h-11"
                  disabled={busy}
                  onClick={() => setConfirmOpen(true)}
                >
                  Anonymize customer…
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-text-muted">Select a customer to use privacy controls.</p>
          )}
        </SectionCard>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!busy) {
            setConfirmOpen(open);
            if (!open) setConfirmation('');
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Confirm permanent anonymization</DialogTitle>
            <DialogDescription>
              This cannot be undone. Identifiers and profile fields will be removed and the loyalty
              account deactivated. Type ANONYMIZE to continue.
            </DialogDescription>
          </DialogHeader>
          <Field label="Confirmation">
            <Input
              autoFocus
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="mt-1 min-h-11"
              aria-describedby="anonymize-confirmation-help"
            />
          </Field>
          <p id="anonymize-confirmation-help" className="text-xs text-text-muted">
            Server authorization and organization scope are rechecked before deletion.
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={busy || confirmation !== 'ANONYMIZE' || !detailQuery.data}
              onClick={() => {
                if (detailQuery.data) {
                  anonymizeCustomer.mutate({ customerId: detailQuery.data.id });
                }
              }}
            >
              {anonymizeCustomer.isPending ? 'Anonymizing…' : 'Permanently anonymize'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CustomerDetail({
  customer,
  availableTags,
  busy,
  onAssignTag,
  onRemoveTag,
  onAppendConsent,
  onAppendInteraction,
  branches,
  branchesLoading,
  branchesError,
}: {
  customer: Customer;
  availableTags: RouterOutputs['restaurantCustomers']['listTags'];
  busy: boolean;
  onAssignTag: (event: FormEvent<HTMLFormElement>) => void;
  onRemoveTag: (tagId: string) => void;
  onAppendConsent: (event: FormEvent<HTMLFormElement>) => void;
  onAppendInteraction: (event: FormEvent<HTMLFormElement>) => void;
  branches: Array<{ id: string; name: string; active: boolean; isDefault: boolean }>;
  branchesLoading: boolean;
  branchesError: boolean;
}) {
  const [interactionBranchId, setInteractionBranchId] = useState('');
  const [interactionOrderId, setInteractionOrderId] = useState('');
  const ordersQuery = trpc.restaurantOrders.listOrders.useQuery(
    { branchId: interactionBranchId, limit: 100 },
    { enabled: Boolean(interactionBranchId) }
  );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-text-strong">{customerName(customer)}</h2>
          <p className="mt-1 font-mono text-xs text-text-muted">
            Created {formatDate(customer.createdAt)}
          </p>
        </div>
        <StatusPill
          status={customer.loyaltySummary?.active ? 'Loyalty active' : 'No active loyalty'}
          tone={customer.loyaltySummary?.active ? 'success' : 'neutral'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="font-semibold text-text-strong">Identifiers</h3>
          {customer.identifiers.length ? (
            <ul className="mt-3 space-y-2">
              {customer.identifiers.map((identifier) => (
                <li
                  key={identifier.id}
                  className="rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs uppercase text-text-muted">
                      {identifier.kind}
                    </span>
                    <StatusPill
                      status={identifier.verifiedAt ? 'Verified' : 'Unverified'}
                      tone={identifier.verifiedAt ? 'success' : 'warning'}
                    />
                  </div>
                  <p className="mt-2 break-all text-sm text-text-strong">
                    {identifier.normalizedValue}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-text-muted">No customer identifiers recorded.</p>
          )}
        </div>

        <div>
          <h3 className="font-semibold text-text-strong">Tags</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {customer.tags.length ? (
              customer.tags.map((tag) => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface-sunken px-3 py-1 text-sm text-text-body"
                >
                  {tag.name}
                  <button
                    type="button"
                    className="rounded-full text-text-muted outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    aria-label={`Remove ${tag.name} tag`}
                    disabled={busy}
                    onClick={() => onRemoveTag(tag.id)}
                  >
                    ×
                  </button>
                </span>
              ))
            ) : (
              <p className="text-sm text-text-muted">No tags assigned.</p>
            )}
          </div>
          <form onSubmit={onAssignTag} className="mt-3 flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="loyalty-tag-select">
              Assign tag
            </label>
            <StudioSelect
              id="loyalty-tag-select"
              name="tagId"
              required
              className={selectClass}
              disabled={busy || !availableTags.length}
            >
              <option value="">Select tag</option>
              {availableTags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </StudioSelect>
            <Button
              type="submit"
              variant="secondary"
              className="min-h-11"
              disabled={busy || !availableTags.length}
            >
              Assign
            </Button>
          </form>
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-text-strong">Current consent</h3>
        <p className="mt-1 text-sm text-text-muted">Missing consent is treated as denied.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {CONSENT_CHANNELS.map((channel) => {
            const event = customer.currentConsent[channel];
            const granted = event?.granted === true;
            return (
              <div
                key={channel}
                className="rounded-[var(--radius-sm)] border border-border-subtle p-3"
              >
                <p className="font-mono text-xs text-text-muted">{channel}</p>
                <StatusPill
                  className="mt-2"
                  status={granted ? 'Granted' : 'Denied'}
                  label={granted ? 'Granted' : event ? 'Denied' : 'Denied — no event'}
                  tone={granted ? 'success' : 'danger'}
                />
              </div>
            );
          })}
        </div>
      </div>

      <form onSubmit={onAppendConsent} className="rounded-[var(--radius-sm)] bg-surface-sunken p-4">
        <h3 className="font-semibold text-text-strong">Append consent event</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Channel">
            <StudioSelect name="channel" className={selectClass} disabled={busy}>
              {CONSENT_CHANNELS.map((channel) => (
                <option key={channel}>{channel}</option>
              ))}
            </StudioSelect>
          </Field>
          <Field label="State">
            <StudioSelect name="granted" className={selectClass} disabled={busy}>
              <option value="true">Granted</option>
              <option value="false">Denied</option>
            </StudioSelect>
          </Field>
          <Field label="Source">
            <Input
              name="source"
              required
              maxLength={100}
              className="mt-1 min-h-11"
              disabled={busy}
            />
          </Field>
          <Field label="Policy version">
            <Input
              name="policyVersion"
              required
              maxLength={100}
              className="mt-1 min-h-11"
              disabled={busy}
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" className="mt-3 min-h-11" disabled={busy}>
          Append consent event
        </Button>
      </form>

      <div>
        <h3 className="font-semibold text-text-strong">Consent timeline</h3>
        {customer.consentEvents.length ? (
          <ol className="mt-3 space-y-2">
            {customer.consentEvents.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle py-2 last:border-0"
              >
                <div>
                  <p className="text-sm font-medium text-text-strong">
                    {event.channel} · {event.source}
                  </p>
                  <p className="font-mono text-xs text-text-muted">
                    {event.policyVersion} · {formatDate(event.occurredAt)}
                  </p>
                </div>
                <StatusPill
                  status={event.granted ? 'Granted' : 'Denied'}
                  tone={event.granted ? 'success' : 'danger'}
                />
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-text-muted">
            No consent events. Every channel is denied.
          </p>
        )}
      </div>

      <div>
        <h3 className="font-semibold text-text-strong">Branch interactions</h3>
        {customer.interactions.length ? (
          <TableRegion label="Customer branch interactions">
            <Table className="min-w-[42rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Occurred</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Order</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customer.interactions.map((interaction) => (
                  <TableRow key={interaction.id}>
                    <TableCell>{formatDate(interaction.occurredAt)}</TableCell>
                    <TableCell>{interaction.branch.name}</TableCell>
                    <TableCell>{interaction.type}</TableCell>
                    <TableCell>{interaction.order?.orderNumber || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableRegion>
        ) : (
          <p className="mt-2 text-sm text-text-muted">No branch interactions recorded.</p>
        )}
      </div>

      <form
        onSubmit={onAppendInteraction}
        className="rounded-[var(--radius-sm)] bg-surface-sunken p-4"
      >
        <h3 className="font-semibold text-text-strong">Append branch interaction</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Branch">
            <RestaurantBranchSelect
              name="branchId"
              required
              branches={branches}
              loading={branchesLoading}
              error={branchesError}
              disabled={busy}
              value={interactionBranchId}
              onChange={(value) => {
                setInteractionBranchId(value);
                setInteractionOrderId('');
              }}
            />
          </Field>
          <Field label="Type">
            <Input name="type" required maxLength={100} className="mt-1 min-h-11" disabled={busy} />
          </Field>
          <div className="block text-sm font-medium text-text-body">
            <span>Order</span>
            <OperatorSafeSelector
              label="Order"
              name="orderId"
              value={interactionOrderId}
              onChange={setInteractionOrderId}
              loading={ordersQuery.isLoading}
              error={ordersQuery.isError}
              forbidden={denied(ordersQuery.error)}
              disabled={!interactionBranchId || busy}
              emptyLabel="No orders available for this branch"
              placeholder="No linked order"
              options={(ordersQuery.data?.orders ?? []).map((order) => ({
                value: order.id,
                label: `Order ${order.orderNumber}`,
                code: `${String(order.businessDate)} · ${order.status.replaceAll('_', ' ').toLocaleLowerCase()}`,
              }))}
            />
            <span className="mt-1 block text-xs font-normal text-text-muted">
              Optional; limited to the selected branch
            </span>
          </div>
        </div>
        <Button type="submit" variant="secondary" className="mt-3 min-h-11" disabled={busy}>
          Append interaction
        </Button>
      </form>
    </div>
  );
}
