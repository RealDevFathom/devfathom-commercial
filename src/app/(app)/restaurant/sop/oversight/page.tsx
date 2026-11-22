'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';
import { workspaceDateOffset } from '@/lib/timezone';
import { useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';
import { RestaurantBranchSelect } from '@/components/restaurant/restaurant-branch-select';
import { RestaurantStaffSelect } from '@/components/restaurant/restaurant-staff-select';

/**
 * WHA-226 — SOP oversight: escalation policy configuration, performance scoring,
 * and the immutable audit trail.
 *
 * Reuses the Studio grammar already established by the SOP authoring console:
 * `PageHeader` / `SectionCard` / `Table` / `StatusPill` / `Stat` / `Button` /
 * `Input`, semantic `surface-*`, `text-*` and `border-*` tokens, and the same
 * mono-uppercase label and select classes. No new palette, geometry, or
 * component vocabulary is introduced.
 *
 * The score panel deliberately renders the formula, window, denominator and
 * exclusions next to the figure. A compliance score is used to judge people, so
 * showing the number without the arithmetic that produced it would be the wrong
 * default — and the no-data case is rendered as "no scored work", never as 0%.
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
type EscalationPolicy = RouterOutputs['restaurantSop']['listEscalationPolicies'][number];
type ScoreReport = RouterOutputs['restaurantSop']['scoreReport'];
type AuditEntry = RouterOutputs['restaurantSop']['occurrenceAuditTrail'][number];
type UiError = { message: string; data?: { code?: string } | null };

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

const CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP'] as const;

function isPermissionError(error?: UiError | null) {
  return error?.data?.code === 'FORBIDDEN' || error?.data?.code === 'UNAUTHORIZED';
}

function formText(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

function formNumber(data: FormData, name: string, fallback: number) {
  const raw = formText(data, name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function minutesToClock(minutes: number | null) {
  if (minutes === null) return null;
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

const AUDIT_TONE: Record<string, StatusTone> = {
  STEP_COMPLETED: 'info',
  EVIDENCE_CAPTURED: 'info',
  ESCALATION_FIRED: 'warning',
  ESCALATION_ACKNOWLEDGED: 'info',
  ESCALATION_STOPPED: 'neutral',
  VERIFIED: 'success',
  REJECTED: 'danger',
  WAIVED: 'warning',
};

/** Score → tone. Null (no data) is neutral, never a failing red. */
function scoreTone(score: number | null): StatusTone {
  if (score === null) return 'neutral';
  if (score >= 90) return 'success';
  if (score >= 70) return 'warning';
  return 'danger';
}

/** The figure a score renders as. Absence is stated, not coerced to a number. */
function scoreFigure(score: number | null) {
  return score === null ? 'No data' : `${score}%`;
}

function timestamp(value: Date | string) {
  const iso = typeof value === 'string' ? value : value.toISOString();
  return iso.slice(0, 19).replace('T', ' ');
}

// ── Score panel ───────────────────────────────────────────────────────────────

function ScoreBreakdownRow({ report }: { report: ScoreReport }) {
  const { overall } = report;
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label="Compliance score"
        value={scoreFigure(overall.score)}
        sub={
          overall.reason === 'NO_DATA'
            ? 'No scored occurrences in this window'
            : `over ${overall.denominator} scored ${overall.denominator === 1 ? 'occurrence' : 'occurrences'}`
        }
      />
      <Stat label="On time" value={overall.counts.onTime} sub="full credit" />
      <Stat label="Late" value={overall.counts.late} sub={`${overall.lateCredit} credit each`} />
      <Stat
        label="Missed / rejected"
        value={overall.counts.missed + overall.counts.rejected}
        sub="no credit"
      />
    </div>
  );
}

function ScoreMethod({ report }: { report: ScoreReport }) {
  const { overall } = report;
  return (
    <div className="mt-6 rounded-md border border-border-subtle bg-surface-sunken p-4">
      <p className={labelClass}>How this score is calculated</p>
      <p className="mt-2 font-mono text-xs leading-relaxed text-text-body">{overall.formula}</p>
      <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4 border-b border-border-subtle pb-2">
          <dt className="text-text-muted">Window</dt>
          <dd className="font-mono text-xs tabular-nums text-text-body">
            {timestamp(report.window.fromBusinessDate).slice(0, 10)} →{' '}
            {timestamp(report.window.toBusinessDate).slice(0, 10)}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-border-subtle pb-2">
          <dt className="text-text-muted">Denominator</dt>
          <dd className="font-mono text-xs tabular-nums text-text-body">{overall.denominator}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-border-subtle pb-2">
          <dt className="text-text-muted">Excluded — waived</dt>
          <dd className="font-mono text-xs tabular-nums text-text-body">
            {overall.excluded.waived}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-border-subtle pb-2">
          <dt className="text-text-muted">Excluded — pending</dt>
          <dd className="font-mono text-xs tabular-nums text-text-body">
            {overall.excluded.pending}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-sm leading-relaxed text-text-muted">
        Waived work is excused and pending work has no outcome yet, so neither counts for or against
        a score. An operator with no scored occurrences shows “No data” rather than 0%.
      </p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RestaurantSopOversightPage() {
  const entitlements = useEntitlements();
  const sopModule = entitlements.modules.find((module) => module.key === 'restaurant-sop');
  const moduleEnabled =
    sopModule?.enabled ?? entitlements.enabledModules.includes('restaurant-sop');

  const utils = trpc.useUtils();
  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: moduleEnabled,
  });
  const staffQuery = trpc.restaurantStaff.listDirectory.useQuery(undefined, {
    enabled: moduleEnabled,
  });
  const [statusMessage, setStatusMessage] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [selectedPolicyId, setSelectedPolicyId] = useState('');
  const [from, setFrom] = useState(() => workspaceDateOffset(entitlements.timeZone, -30));
  const [to, setTo] = useState(() => workspaceDateOffset(entitlements.timeZone, 0));
  const [scoreWindow, setScoreWindow] = useState(() => ({
    from: workspaceDateOffset(entitlements.timeZone, -30),
    to: workspaceDateOffset(entitlements.timeZone, 0),
  }));
  const [auditOccurrenceId, setAuditOccurrenceId] = useState('');

  const policiesQuery = trpc.restaurantSop.listEscalationPolicies.useQuery(undefined, {
    enabled: moduleEnabled,
  });
  const scoreQuery = trpc.restaurantSop.scoreReport.useQuery(
    { from: scoreWindow.from, to: scoreWindow.to, branchId: null },
    { enabled: moduleEnabled }
  );
  const recentOccurrencesQuery = trpc.restaurantSop.listRecentOccurrences.useQuery(undefined, {
    enabled: moduleEnabled,
  });
  const auditQuery = trpc.restaurantSop.occurrenceAuditTrail.useQuery(
    { occurrenceId: auditOccurrenceId },
    { enabled: moduleEnabled && auditOccurrenceId.length > 0, retry: false }
  );

  const policies: EscalationPolicy[] = policiesQuery.data ?? [];
  const selectedPolicy =
    policies.find((policy) => policy.id === selectedPolicyId) ?? policies[0] ?? null;

  const succeed = (message: string) => {
    setMutationError('');
    setStatusMessage(message);
    toast.success(message);
  };
  const fail = (error: { message: string }) => {
    setStatusMessage('');
    setMutationError(error.message);
    toast.error(error.message);
  };
  const refreshPolicies = () => void utils.restaurantSop.listEscalationPolicies.invalidate();

  const createPolicy = trpc.restaurantSop.createEscalationPolicy.useMutation({
    onSuccess: (policy) => {
      setSelectedPolicyId(policy.id);
      refreshPolicies();
      succeed(`Escalation policy “${policy.name}” created.`);
    },
    onError: fail,
  });
  const setPolicyActive = trpc.restaurantSop.setEscalationPolicyActive.useMutation({
    onSuccess: (_, variables) => {
      refreshPolicies();
      succeed(variables.active ? 'Escalation policy activated.' : 'Escalation policy deactivated.');
    },
    onError: fail,
  });
  const upsertStep = trpc.restaurantSop.upsertEscalationStep.useMutation({
    onSuccess: (step) => {
      refreshPolicies();
      succeed(`Escalation step ${step.stepOrder} saved.`);
    },
    onError: fail,
  });
  const removeStep = trpc.restaurantSop.removeEscalationStep.useMutation({
    onSuccess: (removed) => {
      refreshPolicies();
      succeed(`Escalation step ${removed.stepOrder} removed.`);
    },
    onError: fail,
  });

  const anyPending =
    createPolicy.isPending ||
    setPolicyActive.isPending ||
    upsertStep.isPending ||
    removeStep.isPending;

  const queryError = (policiesQuery.error ?? scoreQuery.error) as UiError | null;
  const state = policiesQuery.isLoading
    ? 'loading'
    : isPermissionError(queryError)
      ? 'permission'
      : queryError
        ? 'error'
        : 'ready';

  const submitPolicy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const scope = formText(data, 'scope') === 'BRANCH' ? 'BRANCH' : 'ORG';
    const branchId = formText(data, 'branchId');
    const quietStart = formText(data, 'quietHoursStartMinutes');
    const quietEnd = formText(data, 'quietHoursEndMinutes');
    createPolicy.mutate(
      {
        name: formText(data, 'name'),
        scope,
        branchId: scope === 'BRANCH' ? branchId || null : null,
        stopOnAcknowledged: data.get('stopOnAcknowledged') === 'on',
        stopOnVerified: data.get('stopOnVerified') === 'on',
        quietHoursStartMinutes: quietStart ? Number(quietStart) : null,
        quietHoursEndMinutes: quietEnd ? Number(quietEnd) : null,
      },
      { onSuccess: () => form.reset() }
    );
  };

  const submitStep = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPolicy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    upsertStep.mutate(
      {
        policyId: selectedPolicy.id,
        stepOrder: formNumber(data, 'stepOrder', 1),
        delayMinutes: formNumber(data, 'delayMinutes', 0),
        target: formText(data, 'target'),
        channel: (formText(data, 'channel') || 'IN_APP') as (typeof CHANNELS)[number],
        maxAttempts: formNumber(data, 'maxAttempts', 1),
      },
      { onSuccess: () => form.reset() }
    );
  };

  const report = scoreQuery.data ?? null;
  const auditTrail: AuditEntry[] = auditQuery.data ?? [];

  return (
    <div className="min-w-0 space-y-6" aria-busy={state === 'loading'}>
      <PageHeader
        eyebrow="Restaurant operations"
        heading="SOP oversight"
        description="Configure escalation chains, review compliance scores, and read the immutable audit trail."
        actions={
          moduleEnabled && report ? (
            <StatusPill
              status={report.overall.reason === 'NO_DATA' ? 'No data' : 'Compliance'}
              tone={scoreTone(report.overall.score)}
              label={scoreFigure(report.overall.score)}
            />
          ) : null
        }
      />

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </div>
      {statusMessage ? (
        <div
          className="rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success"
          role="status"
        >
          {statusMessage}
        </div>
      ) : null}
      {mutationError ? (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          {mutationError}
        </div>
      ) : null}

      {!moduleEnabled ? (
        <SectionCard title="SOP & Compliance unavailable">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              Enable the Restaurant SOP &amp; Compliance module to configure escalation policies and
              review compliance scoring.
            </p>
          </div>
        </SectionCard>
      ) : state === 'loading' ? (
        <>
          <SectionCard eyebrow="Escalation" title="Loading policies…">
            <div className="space-y-3">
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-14 w-full motion-reduce:animate-none" />
              ))}
            </div>
          </SectionCard>
          <SectionCard eyebrow="Performance" title="Loading scores…">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {[0, 1, 2, 3].map((tile) => (
                <Skeleton key={tile} className="h-20 w-full motion-reduce:animate-none" />
              ))}
            </div>
          </SectionCard>
        </>
      ) : state === 'permission' ? (
        <SectionCard title="SOP oversight unavailable">
          <div className="space-y-3" role="alert">
            <StatusPill status="Permission required" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              The <span className="font-mono text-xs">sop:manage</span> capability is required to
              configure escalation policies and read compliance scores.
            </p>
          </div>
        </SectionCard>
      ) : state === 'error' ? (
        <SectionCard title="SOP oversight could not load">
          <div className="flex flex-wrap items-center justify-between gap-4" role="alert">
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              {queryError?.message ?? 'The oversight workspace failed to load.'}
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                void policiesQuery.refetch();
                void scoreQuery.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        </SectionCard>
      ) : (
        <>
          {/* ── Escalation policy configuration ───────────────────────────── */}
          <SectionCard
            eyebrow="Escalation"
            title="Escalation policies"
            titleLevel={2}
            actions={
              <StatusPill
                status={policies.length ? 'Configured' : 'None'}
                tone={policies.length ? 'info' : 'neutral'}
                label={`${policies.length} ${policies.length === 1 ? 'policy' : 'policies'}`}
              />
            }
          >
            <p className="mb-5 max-w-3xl text-sm leading-relaxed text-text-muted">
              A policy fires its ordered steps when an occurrence is overdue and unresolved. Each
              step fires at most once; the chain stops on acknowledgement or verification, and
              pauses during branch-local quiet hours.
            </p>

            <form
              onSubmit={submitPolicy}
              className="grid gap-3 lg:grid-cols-[1.4fr_0.8fr_1fr_auto]"
            >
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="policy-name">
                  Policy name
                </label>
                <Input
                  id="policy-name"
                  name="name"
                  required
                  maxLength={200}
                  placeholder="Overdue line checks"
                />
              </div>
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="policy-scope">
                  Scope
                </label>
                <StudioSelect
                  id="policy-scope"
                  name="scope"
                  className={selectClass}
                  defaultValue="ORG"
                >
                  <option value="ORG">Organization</option>
                  <option value="BRANCH">Branch</option>
                </StudioSelect>
              </div>
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="policy-branch">
                  Branch (branch scope only)
                </label>
                <RestaurantBranchSelect
                  id="policy-branch"
                  name="branchId"
                  branches={branchesQuery.data ?? []}
                  loading={branchesQuery.isLoading}
                  error={Boolean(branchesQuery.error)}
                  allowEmpty
                  emptyLabel="Organization scope"
                />
              </div>
              <div className="flex items-end">
                <Button type="submit" disabled={anyPending}>
                  {createPolicy.isPending ? 'Creating…' : 'Create policy'}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-6 lg:col-span-4">
                <label className="flex items-center gap-2 text-sm text-text-body">
                  <input
                    type="checkbox"
                    name="stopOnAcknowledged"
                    defaultChecked
                    className="size-4"
                  />
                  Stop when acknowledged
                </label>
                <label className="flex items-center gap-2 text-sm text-text-body">
                  <input type="checkbox" name="stopOnVerified" defaultChecked className="size-4" />
                  Stop when verified
                </label>
                <div className="flex items-center gap-2">
                  <label className={labelClass} htmlFor="quiet-start">
                    Quiet from (min of day)
                  </label>
                  <Input
                    id="quiet-start"
                    name="quietHoursStartMinutes"
                    type="number"
                    min={0}
                    max={1439}
                    className="w-24"
                  />
                  <label className={labelClass} htmlFor="quiet-end">
                    to
                  </label>
                  <Input
                    id="quiet-end"
                    name="quietHoursEndMinutes"
                    type="number"
                    min={0}
                    max={1439}
                    className="w-24"
                  />
                </div>
              </div>
            </form>

            <div className="mt-6 overflow-x-auto">
              <Table>
                {policies.length === 0 ? (
                  <TableCaption>
                    No escalation policies yet. Create one above to start escalating overdue SOP
                    occurrences.
                  </TableCaption>
                ) : null}
                <TableHeader>
                  <TableRow>
                    <TableHead>Policy</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Stops on</TableHead>
                    <TableHead>Quiet hours</TableHead>
                    <TableHead className="text-right">Steps</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {policies.map((policy) => {
                    const quiet = minutesToClock(policy.quietHoursStartMinutes);
                    const quietEnd = minutesToClock(policy.quietHoursEndMinutes);
                    const stops = [
                      policy.stopOnAcknowledged ? 'acknowledged' : null,
                      policy.stopOnVerified ? 'verified' : null,
                    ].filter(Boolean);
                    return (
                      <TableRow
                        key={policy.id}
                        data-state={selectedPolicy?.id === policy.id ? 'selected' : undefined}
                      >
                        <TableCell className="font-medium text-text-strong">
                          {policy.name}
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-xs">{policy.scope}</span>
                        </TableCell>
                        <TableCell className="text-sm text-text-muted">
                          {stops.length ? stops.join(' · ') : 'chain exhaustion only'}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">
                          {quiet && quietEnd ? `${quiet}–${quietEnd}` : '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {policy.steps.length}
                        </TableCell>
                        <TableCell className="text-right">
                          <StatusPill
                            status={policy.active ? 'Active' : 'Inactive'}
                            tone={policy.active ? 'success' : 'neutral'}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => setSelectedPolicyId(policy.id)}
                            >
                              {selectedPolicy?.id === policy.id ? 'Editing' : 'Edit steps'}
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={anyPending}
                              onClick={() =>
                                setPolicyActive.mutate({ id: policy.id, active: !policy.active })
                              }
                            >
                              {policy.active ? 'Deactivate' : 'Activate'}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </SectionCard>

          {/* ── Chain steps for the selected policy ───────────────────────── */}
          {selectedPolicy ? (
            <SectionCard
              eyebrow="Escalation chain"
              title={`Steps — ${selectedPolicy.name}`}
              actions={
                <StatusPill
                  status={selectedPolicy.active ? 'Active' : 'Inactive'}
                  tone={selectedPolicy.active ? 'success' : 'neutral'}
                />
              }
            >
              <p className="mb-5 max-w-3xl text-sm leading-relaxed text-text-muted">
                Step 1 is delayed from the occurrence’s window close; every later step is delayed
                from the previous step firing. Saving a step keeps its identity, so events already
                recorded against it stay resolvable in the audit trail.
              </p>

              <form
                onSubmit={submitStep}
                className="grid gap-3 lg:grid-cols-[0.5fr_0.7fr_1.4fr_0.9fr_0.6fr_auto]"
              >
                <div className="space-y-1.5">
                  <label className={labelClass} htmlFor="step-order">
                    Order
                  </label>
                  <Input
                    id="step-order"
                    name="stepOrder"
                    type="number"
                    min={1}
                    max={50}
                    defaultValue={1}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass} htmlFor="step-delay">
                    Delay (min)
                  </label>
                  <Input
                    id="step-delay"
                    name="delayMinutes"
                    type="number"
                    min={0}
                    max={10080}
                    defaultValue={0}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass} htmlFor="step-target">
                    Target staff member
                  </label>
                  <RestaurantStaffSelect
                    id="step-target"
                    name="target"
                    required
                    staff={staffQuery.data ?? []}
                    loading={staffQuery.isLoading}
                    error={Boolean(staffQuery.error)}
                    label="Target staff member"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass} htmlFor="step-channel">
                    Channel
                  </label>
                  <StudioSelect
                    id="step-channel"
                    name="channel"
                    className={selectClass}
                    defaultValue="IN_APP"
                  >
                    {CHANNELS.map((channel) => (
                      <option key={channel} value={channel}>
                        {channel}
                      </option>
                    ))}
                  </StudioSelect>
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass} htmlFor="step-attempts">
                    Attempts
                  </label>
                  <Input
                    id="step-attempts"
                    name="maxAttempts"
                    type="number"
                    min={1}
                    max={10}
                    defaultValue={1}
                  />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={anyPending}>
                    {upsertStep.isPending ? 'Saving…' : 'Save step'}
                  </Button>
                </div>
              </form>

              <div className="mt-6 overflow-x-auto">
                <Table>
                  {selectedPolicy.steps.length === 0 ? (
                    <TableCaption>
                      This policy has no steps, so it will never fire. Add step 1 above.
                    </TableCaption>
                  ) : null}
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right">Order</TableHead>
                      <TableHead className="text-right">Delay</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead className="text-right">Attempts</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedPolicy.steps.map((step) => (
                      <TableRow key={step.id}>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {step.stepOrder}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {step.delayMinutes}m
                        </TableCell>
                        <TableCell className="font-mono text-xs">{step.target}</TableCell>
                        <TableCell>
                          <StatusPill status={step.channel} tone="info" />
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {step.maxAttempts}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={anyPending}
                            onClick={() =>
                              removeStep.mutate({
                                policyId: selectedPolicy.id,
                                stepOrder: step.stepOrder,
                              })
                            }
                          >
                            Remove
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>
          ) : null}

          {/* ── Performance scoring ────────────────────────────────────────── */}
          <SectionCard
            eyebrow="Performance"
            title="Compliance scoring"
            actions={
              report ? (
                <StatusPill
                  status={report.overall.reason === 'NO_DATA' ? 'No data' : 'Scored'}
                  tone={scoreTone(report.overall.score)}
                  label={scoreFigure(report.overall.score)}
                />
              ) : null
            }
          >
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                setScoreWindow({ from, to });
              }}
            >
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="score-from">
                  From (business date)
                </label>
                <Input
                  id="score-from"
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="score-to">
                  To (business date)
                </label>
                <Input
                  id="score-to"
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" variant="secondary" disabled={scoreQuery.isFetching}>
                {scoreQuery.isFetching ? 'Loading…' : 'Apply window'}
              </Button>
            </form>

            {scoreQuery.isLoading ? (
              <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                {[0, 1, 2, 3].map((tile) => (
                  <Skeleton key={tile} className="h-20 w-full motion-reduce:animate-none" />
                ))}
              </div>
            ) : scoreQuery.error ? (
              <p className="mt-6 text-sm leading-relaxed text-destructive" role="alert">
                {scoreQuery.error.message}
              </p>
            ) : report ? (
              <>
                <div className="mt-6">
                  <ScoreBreakdownRow report={report} />
                </div>
                <ScoreMethod report={report} />

                <div className="mt-6 overflow-x-auto">
                  <Table>
                    {report.staff.length === 0 ? (
                      <TableCaption>
                        No occurrence in this window records who completed it, so there is nothing
                        to attribute. Scores appear once operators complete steps.
                      </TableCaption>
                    ) : null}
                    <TableHeader>
                      <TableRow>
                        <TableHead>Operator</TableHead>
                        <TableHead className="text-right">Score</TableHead>
                        <TableHead className="text-right">On time</TableHead>
                        <TableHead className="text-right">Late</TableHead>
                        <TableHead className="text-right">Missed</TableHead>
                        <TableHead className="text-right">Rejected</TableHead>
                        <TableHead className="text-right">Denominator</TableHead>
                        <TableHead className="text-right">Excluded</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.staff.map((row) => (
                        <TableRow key={row.staffProfileId}>
                          <TableCell className="font-medium text-text-strong">
                            {row.staffName ?? 'Staff name unavailable'}
                          </TableCell>
                          <TableCell className="text-right">
                            <StatusPill
                              status={row.breakdown.reason === 'NO_DATA' ? 'No data' : 'Score'}
                              tone={scoreTone(row.breakdown.score)}
                              label={scoreFigure(row.breakdown.score)}
                            />
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {row.breakdown.counts.onTime}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {row.breakdown.counts.late}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {row.breakdown.counts.missed}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {row.breakdown.counts.rejected}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {row.breakdown.denominator}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums text-text-muted">
                            {row.breakdown.excluded.waived + row.breakdown.excluded.pending}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {report.unattributed.denominator > 0 ? (
                  <p className="mt-4 text-sm leading-relaxed text-text-muted">
                    {report.unattributed.denominator} scored{' '}
                    {report.unattributed.denominator === 1 ? 'occurrence' : 'occurrences'} in this
                    window record no completing operator and are not attributed to anyone. They
                    still count in the branch total above.
                  </p>
                ) : null}
              </>
            ) : null}
          </SectionCard>

          {/* ── Immutable audit trail ──────────────────────────────────────── */}
          <SectionCard
            eyebrow="Audit"
            title="Occurrence audit history"
            actions={<StatusPill status="Append-only" tone="info" />}
          >
            <p className="mb-5 max-w-3xl text-sm leading-relaxed text-text-muted">
              The trail is derived from the append-only step, evidence, verification, and escalation
              records — it is never written to, so it cannot drift from what actually happened.
            </p>

            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1 space-y-1.5">
                <label className={labelClass} htmlFor="audit-occurrence">
                  Recent occurrence
                </label>
                <StudioSelect
                  id="audit-occurrence"
                  className={selectClass}
                  value={auditOccurrenceId}
                  onChange={(event) => setAuditOccurrenceId(event.target.value)}
                  disabled={
                    recentOccurrencesQuery.isLoading || Boolean(recentOccurrencesQuery.error)
                  }
                >
                  <option value="">
                    {recentOccurrencesQuery.isLoading
                      ? 'Loading recent occurrences…'
                      : recentOccurrencesQuery.error
                        ? isPermissionError(recentOccurrencesQuery.error)
                          ? 'Occurrences unavailable for your access'
                          : 'Occurrences unavailable'
                        : recentOccurrencesQuery.data?.length
                          ? 'Choose an occurrence'
                          : 'No accessible recent occurrences'}
                  </option>
                  {(recentOccurrencesQuery.data ?? []).map((occurrence) => (
                    <option key={occurrence.id} value={occurrence.id}>
                      {occurrence.templateVersion.template.name} — {occurrence.branch.name} —{' '}
                      {new Date(occurrence.businessDate).toLocaleDateString()} —{' '}
                      {occurrence.status.replaceAll('_', ' ').toLowerCase()}
                    </option>
                  ))}
                </StudioSelect>
              </div>
            </div>

            {!auditOccurrenceId ? (
              <p className="mt-6 text-sm leading-relaxed text-text-muted">
                Choose a recent occurrence to read its history.
              </p>
            ) : auditQuery.isLoading ? (
              <div className="mt-6 space-y-2">
                {[0, 1, 2].map((row) => (
                  <Skeleton key={row} className="h-14 w-full motion-reduce:animate-none" />
                ))}
              </div>
            ) : auditQuery.error ? (
              <p className="mt-6 text-sm leading-relaxed text-destructive" role="alert">
                {auditQuery.error.message}
              </p>
            ) : (
              <div className="mt-6 overflow-x-auto">
                <Table>
                  {auditTrail.length === 0 ? (
                    <TableCaption>
                      This occurrence has no recorded acts yet — no step completed, evidence
                      captured, escalation fired, or decision made.
                    </TableCaption>
                  ) : null}
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Proof</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditTrail.map((entry) => (
                      <TableRow key={`${entry.action}-${entry.id}`}>
                        <TableCell className="font-mono text-xs tabular-nums whitespace-nowrap">
                          {timestamp(entry.at)}
                        </TableCell>
                        <TableCell>
                          <StatusPill
                            status={entry.action.replaceAll('_', ' ').toLowerCase()}
                            tone={AUDIT_TONE[entry.action] ?? 'neutral'}
                          />
                        </TableCell>
                        <TableCell className="text-sm">
                          {entry.actorName ?? <span className="text-text-muted">System</span>}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-text-muted">
                          {entry.proofRef === null
                            ? '—'
                            : entry.proofRef.kind === 'EVIDENCE'
                              ? entry.proofRef.contentHash
                              : entry.proofRef.kind === 'CO_AUTHORIZATION'
                                ? `co-auth ${entry.proofRef.coAuthorizationId}`
                                : `step ${entry.proofRef.stepOrder ?? '—'}`}
                        </TableCell>
                        <TableCell className="text-sm text-text-muted">
                          {entry.detail ?? '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
