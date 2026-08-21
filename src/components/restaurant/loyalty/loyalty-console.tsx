'use client';

import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { inferRouterOutputs } from '@trpc/server';

import { useEntitlements } from '@/components/entitlements-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type CustomerDetail = RouterOutputs['restaurantCustomers']['detail'];

const CONSENT_CHANNELS = ['EMAIL', 'SMS', 'PHONE', 'WHATSAPP', 'PUSH'] as const;
type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

const LEDGER_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  EARN: 'success',
  REDEEM: 'info',
  REVERSAL: 'warning',
  EXPIRY: 'neutral',
  ADJUSTMENT: 'info',
};

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';

function isDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false;
  const data = error.data;
  if (typeof data !== 'object' || data === null || !('code' in data)) return false;
  return data.code === 'FORBIDDEN' || data.code === 'UNAUTHORIZED';
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return typeof error.message === 'string' && error.message ? error.message : fallback;
  }
  return fallback;
}

/** Deterministic UTC formatting keeps DOM tests stable across environments. */
function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
}

function fmtDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function customerName(row: {
  displayName: string | null;
  givenName?: string | null;
  familyName?: string | null;
}): string {
  if (row.displayName) return row.displayName;
  const composed = [row.givenName, row.familyName].filter(Boolean).join(' ').trim();
  return composed || 'Unnamed customer';
}

function downloadJson(filename: string, data: unknown): void {
  if (typeof window === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function Field({
  label,
  children,
  description,
}: {
  label: string;
  children: ReactNode;
  description?: string;
}) {
  return (
    <label className="space-y-1.5">
      <span className={labelClass}>{label}</span>
      {children}
      {description ? <span className="block text-xs text-text-muted">{description}</span> : null}
    </label>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
      <p className="font-medium text-text-strong">{title}</p>
      <p className="mt-1 text-sm text-text-muted">{detail}</p>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function ErrorState({
  error,
  retry,
  subject,
}: {
  error: unknown;
  retry?: () => void;
  subject: string;
}) {
  const denied = isDenied(error);
  return (
    <div className="space-y-3 rounded-md border border-border-default p-5" role="alert">
      <StatusPill status={denied ? 'Permission denied' : 'Read failed'} tone="danger" />
      <div>
        <p className="font-medium text-text-strong">
          {denied ? 'Access denied' : 'Could not load ' + subject}
        </p>
        <p className="mt-1 text-sm text-text-muted">
          {denied
            ? 'Your role does not grant the capability required for this data. Nothing was changed.'
            : errorMessage(error, 'The read failed without changing any customer or loyalty data.')}
        </p>
      </div>
      {!denied && retry ? (
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function TableFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&_[data-slot=table-container]]:overflow-visible"
    >
      {children}
    </div>
  );
}

function ModuleDisabled({ name, detail }: { name: string; detail: string }) {
  return (
    <SectionCard title={name + ' module disabled'}>
      <div className="space-y-3" role="status">
        <StatusPill status="Disabled" tone="warning" />
        <p className="max-w-2xl text-sm text-text-muted">{detail}</p>
      </div>
    </SectionCard>
  );
}

export function LoyaltyConsole() {
  const entitlements = useEntitlements();
  const customersEnabled = entitlements.enabledModules.includes('restaurant-customers');
  const loyaltyEnabled = entitlements.enabledModules.includes('restaurant-loyalty');
  const [tab, setTab] = useState<'customers' | 'loyalty'>('customers');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Customers & Loyalty"
        description="Search canonical customers, manage consent and privacy, and read the append-only loyalty ledger and program versions."
      />

      <Tabs value={tab} onValueChange={(value) => setTab(value as 'customers' | 'loyalty')}>
        <TabsList aria-label="Customers and loyalty">
          <TabsTrigger value="customers">Customers</TabsTrigger>
          <TabsTrigger value="loyalty">Loyalty</TabsTrigger>
        </TabsList>

        <TabsContent value="customers">
          {customersEnabled ? (
            <CustomersPanel />
          ) : (
            <ModuleDisabled
              name="Customers"
              detail="The canonical customer register requires the Restaurant Customers entitlement. Search, detail, consent, and privacy actions stay disabled until it is granted."
            />
          )}
        </TabsContent>

        <TabsContent value="loyalty">
          {loyaltyEnabled ? (
            <LoyaltyPanel />
          ) : (
            <ModuleDisabled
              name="Loyalty"
              detail="Loyalty accounts, ledger, and program configuration require the Restaurant Loyalty entitlement. Reads and configuration stay disabled until it is granted."
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CustomersPanel() {
  const [search, setSearch] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');

  const trimmed = search.trim();
  const listInput = { ...(trimmed ? { query: trimmed } : {}), limit: 50 };
  const listQuery = trpc.restaurantCustomers.list.useQuery(listInput, {
    enabled: true,
  });
  const detailQuery = trpc.restaurantCustomers.detail.useQuery(
    { customerId: selectedCustomerId },
    { enabled: selectedCustomerId.length > 0 }
  );

  const denied = isDenied(listQuery.error);
  const rows = denied || listQuery.error ? [] : (listQuery.data?.customers ?? []);

  return (
    <div className="space-y-5">
      <SectionCard eyebrow="Canonical register" title="Customer search">
        <div className="mb-4 max-w-md">
          <Field
            label="Search"
            description="Match by name or normalized identifier. Anonymized customers are excluded."
          >
            <Input
              aria-label="Search customers"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, email, or phone…"
              className="h-11"
            />
          </Field>
        </div>

        {listQuery.isLoading ? (
          <LoadingState label="Loading customers" />
        ) : listQuery.error ? (
          <ErrorState
            error={listQuery.error}
            retry={() => void listQuery.refetch()}
            subject="customers"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No customers found"
            detail={
              trimmed
                ? 'No canonical customer matches this search.'
                : 'No canonical customer exists for this organization yet.'
            }
          />
        ) : (
          <TableFrame label="Customers table">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Identifiers</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={selectedCustomerId === row.id ? 'selected' : undefined}
                  >
                    <TableCell>
                      <span className="block font-medium text-text-strong">
                        {customerName(row)}
                      </span>
                      <span className="block font-mono text-[0.625rem] text-text-faint">
                        {row.id}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.identifiers.length ? (
                        <ul className="space-y-0.5">
                          {row.identifiers.map((identifier) => (
                            <li key={identifier.id} className="font-mono text-xs text-text-muted">
                              {identifier.kind}: {identifier.normalizedValue}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.tags.length ? (
                        <div className="flex flex-wrap gap-1">
                          {row.tags.map((tag) => (
                            <Badge key={tag.id} variant="secondary">
                              {tag.name}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-text-muted">
                      {fmtDate(row.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant={selectedCustomerId === row.id ? 'secondary' : 'outline'}
                        aria-pressed={selectedCustomerId === row.id}
                        onClick={() => setSelectedCustomerId(row.id)}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        )}
      </SectionCard>

      {selectedCustomerId ? (
        <SectionCard eyebrow="Selected customer" title="Customer detail">
          {detailQuery.isLoading ? (
            <LoadingState label="Loading customer detail" />
          ) : detailQuery.error ? (
            <ErrorState
              error={detailQuery.error}
              retry={() => void detailQuery.refetch()}
              subject="customer detail"
            />
          ) : detailQuery.data ? (
            <CustomerDetailView
              detail={detailQuery.data}
              onChanged={() => void detailQuery.refetch()}
            />
          ) : (
            <EmptyState
              title="Customer not found"
              detail="No canonical customer exists for the selected id."
            />
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}

function CustomerDetailView({
  detail,
  onChanged,
}: {
  detail: NonNullable<CustomerDetail>;
  onChanged: () => void;
}) {
  const anonymized = Boolean(detail.anonymizedAt);
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-text-strong">{customerName(detail)}</h3>
          <p className="font-mono text-xs text-text-faint">{detail.id}</p>
        </div>
        <StatusPill
          status={anonymized ? 'Anonymized' : 'Active'}
          tone={anonymized ? 'neutral' : 'success'}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Given name" value={detail.givenName ?? '—'} />
        <Stat label="Family name" value={detail.familyName ?? '—'} />
        <Stat label="Birth date" value={fmtDate(detail.birthDate)} />
        <Stat label="Created" value={fmtDate(detail.createdAt)} />
      </div>

      {detail.notes ? (
        <section aria-labelledby="customer-notes-heading">
          <h4 id="customer-notes-heading" className={labelClass + ' mb-1.5'}>
            Notes
          </h4>
          <p className="max-w-2xl whitespace-pre-line text-sm text-text-muted">{detail.notes}</p>
        </section>
      ) : null}

      <IdentifiersSection identifiers={detail.identifiers} />
      <TagsSection tags={detail.tags} />
      <InteractionsSection interactions={detail.interactions} />
      <ConsentSection detail={detail} />
      <LoyaltySummarySection summary={detail.loyaltySummary} />

      <PrivacySection detail={detail} anonymized={anonymized} onChanged={onChanged} />
    </div>
  );
}

function IdentifiersSection({
  identifiers,
}: {
  identifiers: NonNullable<CustomerDetail>['identifiers'];
}) {
  return (
    <section aria-labelledby="customer-identifiers-heading">
      <h4 id="customer-identifiers-heading" className="mb-3 font-semibold text-text-strong">
        Identifiers
      </h4>
      {identifiers.length ? (
        <TableFrame label="Identifiers table">
          <Table className="min-w-[520px]">
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Verified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {identifiers.map((identifier) => (
                <TableRow key={identifier.id}>
                  <TableCell>{identifier.kind}</TableCell>
                  <TableCell className="font-mono text-xs">{identifier.normalizedValue}</TableCell>
                  <TableCell className="font-mono text-xs text-text-muted">
                    {fmtDate(identifier.verifiedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      ) : (
        <EmptyState title="No identifiers" detail="This customer has no email or phone on file." />
      )}
    </section>
  );
}

function TagsSection({ tags }: { tags: NonNullable<CustomerDetail>['tags'] }) {
  return (
    <section aria-labelledby="customer-tags-heading">
      <h4 id="customer-tags-heading" className="mb-3 font-semibold text-text-strong">
        Tags
      </h4>
      {tags.length ? (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <Badge key={tag.id} variant="secondary">
              {tag.name}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-muted">No segment tags assigned.</p>
      )}
    </section>
  );
}

function InteractionsSection({
  interactions,
}: {
  interactions: NonNullable<CustomerDetail>['interactions'];
}) {
  return (
    <section aria-labelledby="customer-interactions-heading">
      <h4 id="customer-interactions-heading" className="mb-3 font-semibold text-text-strong">
        Branch interactions
      </h4>
      {interactions.length ? (
        <TableFrame label="Interactions table">
          <Table className="min-w-[620px]">
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Occurred</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {interactions.map((interaction) => (
                <TableRow key={interaction.id}>
                  <TableCell className="font-medium text-text-strong">{interaction.type}</TableCell>
                  <TableCell>{interaction.branch?.name ?? interaction.branchId}</TableCell>
                  <TableCell className="font-mono text-xs text-text-muted">
                    {interaction.orderId ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-text-muted">
                    {fmtDateTime(interaction.occurredAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      ) : (
        <EmptyState
          title="No interactions"
          detail="No branch interaction has been recorded for this customer."
        />
      )}
    </section>
  );
}

function ConsentSection({ detail }: { detail: NonNullable<CustomerDetail> }) {
  const current = detail.currentConsent as Partial<
    Record<ConsentChannel, NonNullable<CustomerDetail>['consentEvents'][number]>
  >;
  return (
    <section aria-labelledby="customer-consent-heading">
      <h4 id="customer-consent-heading" className="mb-3 font-semibold text-text-strong">
        Consent
      </h4>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {CONSENT_CHANNELS.map((channel) => {
          const event = current[channel];
          const granted = Boolean(event?.granted);
          const status = !event ? 'No record' : granted ? 'Granted' : 'Denied';
          const tone = !event ? 'neutral' : granted ? 'success' : 'danger';
          return (
            <div key={channel} className="space-y-1.5 rounded-md border border-border-default p-3">
              <span className={labelClass}>{channel}</span>
              <StatusPill status={status} tone={tone} />
              <span className="block font-mono text-[0.625rem] text-text-faint">
                {event
                  ? `v${event.policyVersion} · ${fmtDate(event.occurredAt)}`
                  : 'Missing = denied'}
              </span>
            </div>
          );
        })}
      </div>

      {detail.consentEvents.length ? (
        <TableFrame label="Consent timeline table">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Policy</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Occurred</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.consentEvents.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-medium text-text-strong">{event.channel}</TableCell>
                  <TableCell>
                    <StatusPill
                      status={event.granted ? 'Granted' : 'Denied'}
                      tone={event.granted ? 'success' : 'danger'}
                    />
                  </TableCell>
                  <TableCell>{event.source}</TableCell>
                  <TableCell className="font-mono text-xs text-text-muted">
                    {event.policyVersion}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-text-muted">
                    {event.actorId ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-text-muted">
                    {fmtDateTime(event.occurredAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      ) : (
        <EmptyState
          title="No consent events"
          detail="No consent has been recorded. Missing consent means the channel is denied."
        />
      )}
    </section>
  );
}

function LoyaltySummarySection({
  summary,
}: {
  summary: NonNullable<CustomerDetail>['loyaltySummary'];
}) {
  return (
    <section aria-labelledby="customer-loyalty-heading">
      <h4 id="customer-loyalty-heading" className="mb-3 font-semibold text-text-strong">
        Loyalty account
      </h4>
      {summary ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Balance" value={summary.balance} />
          <div className="space-y-1.5">
            <span className={labelClass}>Status</span>
            <StatusPill
              status={summary.active ? 'Active' : 'Inactive'}
              tone={summary.active ? 'success' : 'neutral'}
            />
          </div>
          <Stat label="Enrolled" value={fmtDate(summary.enrolledAt)} />
          <Stat label="Account" value={<span className="font-mono text-sm">{summary.id}</span>} />
        </div>
      ) : (
        <EmptyState
          title="Not enrolled"
          detail="This customer has no loyalty account. Enroll from the Loyalty tab."
        />
      )}
    </section>
  );
}

function PrivacySection({
  detail,
  anonymized,
  onChanged,
}: {
  detail: NonNullable<CustomerDetail>;
  anonymized: boolean;
  onChanged: () => void;
}) {
  const [exportStatus, setExportStatus] = useState<'idle' | 'working' | 'error' | 'denied'>('idle');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const exportMutation = trpc.restaurantCustomers.export.useMutation();
  const anonymizeMutation = trpc.restaurantCustomers.anonymize.useMutation();

  const runExport = async () => {
    setExportStatus('working');
    try {
      const bundle = await exportMutation.mutateAsync({
        customerId: detail.id,
      });
      if (bundle) downloadJson(`customer-${detail.id}-export.json`, bundle);
      setExportStatus('idle');
    } catch (error) {
      setExportStatus(isDenied(error) ? 'denied' : 'error');
    }
  };

  const runAnonymize = async () => {
    try {
      await anonymizeMutation.mutateAsync({ customerId: detail.id });
      setConfirmOpen(false);
      onChanged();
    } catch {
      // Error surfaces inline in the dialog via the mutation state below.
    }
  };

  const anonymizeDenied = isDenied(anonymizeMutation.error);

  return (
    <section
      aria-labelledby="customer-privacy-heading"
      className="space-y-4 rounded-lg border border-border-default bg-surface-sunken/40 p-5"
    >
      <div>
        <h4 id="customer-privacy-heading" className="font-semibold text-text-strong">
          Privacy & data rights
        </h4>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          Export returns one customer-scoped JSON bundle. Anonymization is explicit, idempotent, and
          irreversible: it removes identifiers and profile PII, deactivates loyalty, and retains
          de-identified statutory history.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={exportStatus === 'working'}
          aria-label="Export customer data bundle"
          onClick={() => void runExport()}
        >
          {exportStatus === 'working' ? 'Preparing export…' : 'Export JSON bundle'}
        </Button>

        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={anonymized}
          onClick={() => {
            anonymizeMutation.reset();
            setConfirmOpen(true);
          }}
        >
          {anonymized ? 'Already anonymized' : 'Anonymize customer'}
        </Button>
      </div>

      {exportStatus === 'error' ? (
        <p role="alert" className="text-xs text-destructive">
          Export failed — no data changed. Try again.
        </p>
      ) : null}
      {exportStatus === 'denied' ? (
        <p role="alert" className="text-xs text-destructive">
          Export denied — your role does not grant customers access.
        </p>
      ) : null}

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!anonymizeMutation.isPending) setConfirmOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Anonymize this customer?</DialogTitle>
            <DialogDescription>
              This permanently removes identifiers and profile PII for {customerName(detail)},
              clears tag assignments, and deactivates the loyalty account. De-identified financial
              and order history is retained. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {anonymizeMutation.error ? (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {anonymizeDenied
                ? 'Anonymize denied — this action requires the restaurant configure capability.'
                : errorMessage(anonymizeMutation.error, 'Anonymize failed. No data changed.')}
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline" disabled={anonymizeMutation.isPending}>
                  Cancel
                </Button>
              }
            />
            <Button
              type="button"
              variant="destructive"
              disabled={anonymizeMutation.isPending}
              onClick={() => void runAnonymize()}
            >
              {anonymizeMutation.isPending ? 'Anonymizing…' : 'Anonymize permanently'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function LoyaltyPanel() {
  const [view, setView] = useState<'programs' | 'accounts'>('programs');
  return (
    <Tabs value={view} onValueChange={(value) => setView(value as 'programs' | 'accounts')}>
      <TabsList aria-label="Loyalty views">
        <TabsTrigger value="programs">Programs & config</TabsTrigger>
        <TabsTrigger value="accounts">Accounts & ledger</TabsTrigger>
      </TabsList>
      <TabsContent value="programs">{view === 'programs' ? <ProgramsPanel /> : null}</TabsContent>
      <TabsContent value="accounts">{view === 'accounts' ? <AccountsPanel /> : null}</TabsContent>
    </Tabs>
  );
}

function ProgramsPanel() {
  const programsQuery = trpc.restaurantLoyalty.listPrograms.useQuery(
    { limit: 100 },
    { enabled: true }
  );
  const denied = isDenied(programsQuery.error);
  const rows = denied || programsQuery.error ? [] : (programsQuery.data ?? []);

  return (
    <div className="space-y-5">
      <SectionCard eyebrow="Program governance" title="Program versions">
        <p className="mb-4 max-w-2xl text-sm text-text-muted">
          One organization-wide version is effective at an instant. Effective versions are
          immutable; any change creates a new version.
        </p>
        {programsQuery.isLoading ? (
          <LoadingState label="Loading loyalty programs" />
        ) : programsQuery.error ? (
          <ErrorState
            error={programsQuery.error}
            retry={() => void programsQuery.refetch()}
            subject="loyalty programs"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No program versions"
            detail="No loyalty program has been configured yet. Create the first version below."
          />
        ) : (
          <TableFrame label="Program versions table">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Effective from</TableHead>
                  <TableHead numeric>Earn rate</TableHead>
                  <TableHead numeric>Redemption value</TableHead>
                  <TableHead numeric>Expiry (days)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((program) => (
                  <TableRow key={program.id}>
                    <TableCell className="font-medium text-text-strong">
                      v{program.versionNumber}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-text-muted">
                      {fmtDateTime(program.effectiveFrom)}
                    </TableCell>
                    <TableCell numeric>{program.earnRate}</TableCell>
                    <TableCell numeric>{program.redemptionValue}</TableCell>
                    <TableCell numeric>{program.expiryDays ?? '∞'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        )}
      </SectionCard>

      <ConfigureProgramCard onConfigured={() => void programsQuery.refetch()} />
    </div>
  );
}

function ConfigureProgramCard({ onConfigured }: { onConfigured: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [earnRate, setEarnRate] = useState('');
  const [redemptionValue, setRedemptionValue] = useState('');
  const [expiryDays, setExpiryDays] = useState('');
  const configure = trpc.restaurantLoyalty.configure.useMutation();

  const ready =
    effectiveFrom.trim().length > 0 &&
    earnRate.trim().length > 0 &&
    redemptionValue.trim().length > 0;
  const denied = isDenied(configure.error);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    try {
      await configure.mutateAsync({
        effectiveFrom: new Date(effectiveFrom).toISOString(),
        earnRate: earnRate.trim(),
        redemptionValue: redemptionValue.trim(),
        ...(expiryDays.trim() ? { expiryDays: Number(expiryDays) } : {}),
      });
      setEffectiveFrom('');
      setEarnRate('');
      setRedemptionValue('');
      setExpiryDays('');
      onConfigured();
    } catch {
      // Error surfaces inline via the mutation state below.
    }
  };

  return (
    <SectionCard eyebrow="Restricted action" title="Create program version">
      <p className="mb-4 max-w-2xl text-sm text-text-muted">
        Configuring a new version requires the restaurant configure capability. Earn rate is
        points-per-currency-unit; redemption value is currency-per-point; empty expiry means no
        expiry.
      </p>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Field label="Effective from" description="Instant the version becomes effective.">
            <Input
              aria-label="Effective from"
              type="datetime-local"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              className="h-11"
              disabled={configure.isPending}
            />
          </Field>
          <Field label="Earn rate" description="Points per currency unit.">
            <Input
              aria-label="Earn rate"
              inputMode="decimal"
              value={earnRate}
              onChange={(event) => setEarnRate(event.target.value)}
              placeholder="1.5"
              className="h-11"
              disabled={configure.isPending}
            />
          </Field>
          <Field label="Redemption value" description="Currency per point.">
            <Input
              aria-label="Redemption value"
              inputMode="decimal"
              value={redemptionValue}
              onChange={(event) => setRedemptionValue(event.target.value)}
              placeholder="0.01"
              className="h-11"
              disabled={configure.isPending}
            />
          </Field>
          <Field label="Expiry days" description="Leave blank for no expiry.">
            <Input
              aria-label="Expiry days"
              inputMode="numeric"
              value={expiryDays}
              onChange={(event) => setExpiryDays(event.target.value)}
              placeholder="365"
              className="h-11"
              disabled={configure.isPending}
            />
          </Field>
        </div>

        {configure.error ? (
          <p role="alert" className="text-sm text-destructive">
            {denied
              ? 'Configure denied — this action requires the restaurant configure capability.'
              : errorMessage(configure.error, 'Could not create the version. No data changed.')}
          </p>
        ) : null}
        {configure.isSuccess ? (
          <p role="status" className="text-sm text-success">
            New program version created.
          </p>
        ) : null}

        <Button type="submit" disabled={!ready || configure.isPending}>
          {configure.isPending ? 'Creating…' : 'Create version'}
        </Button>
      </form>
    </SectionCard>
  );
}

function AccountsPanel() {
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const accountsQuery = trpc.restaurantLoyalty.listAccounts.useQuery(
    { limit: 100 },
    { enabled: true }
  );
  const ledgerQuery = trpc.restaurantLoyalty.listLedger.useQuery(
    { accountId: selectedAccountId, limit: 100 },
    { enabled: selectedAccountId.length > 0 }
  );

  const denied = isDenied(accountsQuery.error);
  const rows = denied || accountsQuery.error ? [] : (accountsQuery.data ?? []);
  const selectedAccount = rows.find((account) => account.id === selectedAccountId) ?? null;

  return (
    <div className="space-y-5">
      <SectionCard eyebrow="Loyalty accounts" title="Accounts & balances">
        <p className="mb-4 max-w-2xl text-sm text-text-muted">
          Balance equals the exact sum of the append-only signed ledger entries at read time.
        </p>
        {accountsQuery.isLoading ? (
          <LoadingState label="Loading loyalty accounts" />
        ) : accountsQuery.error ? (
          <ErrorState
            error={accountsQuery.error}
            retry={() => void accountsQuery.refetch()}
            subject="loyalty accounts"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No loyalty accounts"
            detail="No customer has been enrolled in the loyalty program yet."
          />
        ) : (
          <TableFrame label="Loyalty accounts table">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead numeric>Balance</TableHead>
                  <TableHead>Enrolled</TableHead>
                  <TableHead className="text-right">Ledger</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((account) => (
                  <TableRow
                    key={account.id}
                    data-state={selectedAccountId === account.id ? 'selected' : undefined}
                  >
                    <TableCell>
                      <span className="block font-medium text-text-strong">
                        {account.customer?.displayName ?? 'Unnamed customer'}
                      </span>
                      <span className="block font-mono text-[0.625rem] text-text-faint">
                        {account.id}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusPill
                        status={account.active ? 'Active' : 'Inactive'}
                        tone={account.active ? 'success' : 'neutral'}
                      />
                    </TableCell>
                    <TableCell numeric>{account.balance}</TableCell>
                    <TableCell className="font-mono text-xs text-text-muted">
                      {fmtDate(account.enrolledAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant={selectedAccountId === account.id ? 'secondary' : 'outline'}
                        aria-pressed={selectedAccountId === account.id}
                        onClick={() => setSelectedAccountId(account.id)}
                      >
                        View ledger
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        )}
      </SectionCard>

      {selectedAccountId ? (
        <SectionCard
          eyebrow="Selected account"
          title="Ledger & adjustments"
          actions={
            selectedAccount ? (
              <StatusPill
                status={selectedAccount.active ? 'Active' : 'Inactive'}
                tone={selectedAccount.active ? 'success' : 'neutral'}
              />
            ) : undefined
          }
        >
          {selectedAccount ? (
            <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Stat label="Balance" value={selectedAccount.balance} />
              <Stat
                label="Customer"
                value={selectedAccount.customer?.displayName ?? 'Unnamed customer'}
              />
              <Stat label="Enrolled" value={fmtDate(selectedAccount.enrolledAt)} />
            </div>
          ) : null}

          <AdjustAccountForm
            accountId={selectedAccountId}
            onAdjusted={() => {
              void ledgerQuery.refetch();
              void accountsQuery.refetch();
            }}
          />

          <div className="mt-6">
            <h4 className="mb-3 font-semibold text-text-strong">Ledger & redemption history</h4>
            {ledgerQuery.isLoading ? (
              <LoadingState label="Loading ledger entries" />
            ) : ledgerQuery.error ? (
              <ErrorState
                error={ledgerQuery.error}
                retry={() => void ledgerQuery.refetch()}
                subject="ledger entries"
              />
            ) : (ledgerQuery.data ?? []).length === 0 ? (
              <EmptyState
                title="No ledger entries"
                detail="This account has no earn, redemption, adjustment, reversal, or expiry entries yet."
              />
            ) : (
              <TableFrame label="Ledger entries table">
                <Table className="min-w-[860px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kind</TableHead>
                      <TableHead numeric>Points</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Bill</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Occurred</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(ledgerQuery.data ?? []).map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell>
                          <StatusPill
                            status={entry.kind}
                            tone={LEDGER_TONE[entry.kind] ?? 'neutral'}
                          />
                        </TableCell>
                        <TableCell numeric>{entry.points}</TableCell>
                        <TableCell>{entry.reason ?? '—'}</TableCell>
                        <TableCell className="font-mono text-xs text-text-muted">
                          {entry.billId ?? '—'}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-text-muted">
                          {entry.actorId ?? '—'}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-text-muted">
                          {fmtDateTime(entry.occurredAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableFrame>
            )}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

function AdjustAccountForm({
  accountId,
  onAdjusted,
}: {
  accountId: string;
  onAdjusted: () => void;
}) {
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const idempotencyKey = useRef(crypto.randomUUID());
  const adjust = trpc.restaurantLoyalty.adjust.useMutation();

  const parsedPoints = Number(points);
  const ready =
    points.trim().length > 0 &&
    Number.isInteger(parsedPoints) &&
    parsedPoints !== 0 &&
    reason.trim().length > 0;
  const denied = isDenied(adjust.error);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    try {
      await adjust.mutateAsync({
        accountId,
        points: parsedPoints,
        reason: reason.trim(),
        idempotencyKey: idempotencyKey.current,
      });
      idempotencyKey.current = crypto.randomUUID();
      setPoints('');
      setReason('');
      onAdjusted();
    } catch {
      // Error surfaces inline via the mutation state below.
    }
  };

  return (
    <form
      className="space-y-4 rounded-lg border border-border-default p-4"
      onSubmit={(event) => void submit(event)}
    >
      <div>
        <h4 className="font-semibold text-text-strong">Manual adjustment</h4>
        <p className="mt-1 text-sm text-text-muted">
          Whole points only, non-zero. Requires the restaurant configure capability, an actor, and a
          reason. Appends a signed ledger entry.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-[10rem_1fr]">
        <Field label="Points" description="Positive to grant, negative to deduct.">
          <Input
            aria-label="Adjustment points"
            inputMode="numeric"
            value={points}
            onChange={(event) => setPoints(event.target.value)}
            placeholder="100"
            className="h-11"
            disabled={adjust.isPending}
          />
        </Field>
        <Field label="Reason" description="Required audit reason.">
          <Textarea
            aria-label="Adjustment reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Goodwill credit for service recovery"
            disabled={adjust.isPending}
          />
        </Field>
      </div>

      {adjust.error ? (
        <p role="alert" className="text-sm text-destructive">
          {denied
            ? 'Adjustment denied — this action requires the restaurant configure capability.'
            : errorMessage(adjust.error, 'Could not record the adjustment. No data changed.')}
        </p>
      ) : null}
      {adjust.isSuccess ? (
        <p role="status" className="text-sm text-success">
          Adjustment recorded.
        </p>
      ) : null}

      <Button type="submit" disabled={!ready || adjust.isPending}>
        {adjust.isPending ? 'Recording…' : 'Record adjustment'}
      </Button>
    </form>
  );
}
