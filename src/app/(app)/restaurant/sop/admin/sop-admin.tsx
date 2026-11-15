'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
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
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';
import { RestaurantBranchSelect } from '@/components/restaurant/restaurant-branch-select';
import { RestaurantStaffSelect } from '@/components/restaurant/restaurant-staff-select';
import { resolveEntitlementLimit, SOP_TEMPLATES_LIMIT } from '@/lib/entitlement-limits';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type RouterInputs = inferRouterInputs<AppRouter>;
type SopTemplate = RouterOutputs['restaurantSop']['listTemplates'][number];
type SopAssignment = RouterOutputs['restaurantSop']['listAssignments'][number];
type SopVersion = RouterOutputs['restaurantSop']['getVersion'];
type AssignableJobRole = RouterOutputs['restaurantSop']['listAssignableJobRoles'][number];
type SchedulePreview = RouterOutputs['restaurantSop']['previewSchedule'];
type SchedulePreviewInput = RouterInputs['restaurantSop']['previewSchedule'];
/** SOP-1: which of the two assignment modes the form is currently composing. */
type AssigneeMode = 'role' | 'person';
type UiError = { message: string; data?: { code?: string } | null };
type Frequency = 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'INTERVAL';
type PendingAction =
  | 'create-template'
  | 'set-template-active'
  | 'create-draft'
  | 'publish-version'
  | 'add-step'
  | 'update-step'
  | 'remove-step'
  | 'reorder-steps'
  | 'create-assignment'
  | 'toggle-assignment';

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';
const dayOptions = [
  ['0', 'Sun'],
  ['1', 'Mon'],
  ['2', 'Tue'],
  ['3', 'Wed'],
  ['4', 'Thu'],
  ['5', 'Fri'],
  ['6', 'Sat'],
] as const;

function formText(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

function formNumber(data: FormData, name: string, fallback = 0) {
  const value = formText(data, name);
  return value === '' ? fallback : Number(value);
}

function timeToMinutes(value: string) {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function minutesLabel(value: number) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function dateOnly(value: Date | string | null) {
  if (!value) return 'Ongoing';
  return (typeof value === 'string' ? value : value.toISOString()).slice(0, 10);
}

function isPermissionError(error?: UiError | null) {
  return error?.data?.code === 'FORBIDDEN' || error?.data?.code === 'UNAUTHORIZED';
}

function statusTone(status: string): StatusTone {
  if (status === 'ACTIVE' || status === 'PUBLISHED') return 'success';
  if (status === 'DRAFT') return 'warning';
  if (status === 'RETIRED') return 'neutral';
  return status === 'INACTIVE' ? 'neutral' : 'info';
}

/**
 * Active-template quota presentation states.
 *
 * `disabled` means the plan deliberately grants zero active templates.
 * `exhausted` means the plan grants this workspace a quota and the workspace has
 * used all of it — the remedy is in-product (archive a template). It is
 * deliberately distinct from the module-level "not in your plan" state, whose
 * remedy is commercial. `unconfigured` is neither: an absent limit is a platform
 * configuration fault, not a plan that permits zero templates, so it must never
 * render as `0 active · 0 allowed`.
 */
type TemplateCapacity =
  | { kind: 'available'; limit: number; used: number; remaining: number }
  | { kind: 'disabled'; used: number }
  | { kind: 'exhausted'; limit: number; used: number }
  | { kind: 'unconfigured'; used: number };

/**
 * WHA-265 owns the shared resolver policy for absent limits (declare-every-limit
 * with loud platform diagnostics vs. absent-means-unlimited). That contract does
 * not exist yet, so this view does not invent it: an unconfigured limit keeps the
 * pre-existing fail-closed behaviour (creation stays disabled) and simply stops
 * claiming the plan allows zero. When the policy lands, only this function
 * changes — if absent means unlimited it returns `available`, otherwise the
 * `unconfigured` branch stays as-is.
 */
function resolveTemplateCapacity(limit: number | undefined, activeCount: number): TemplateCapacity {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
    return { kind: 'unconfigured', used: activeCount };
  }
  if (limit === 0) return { kind: 'disabled', used: activeCount };
  const remaining = Math.max(0, limit - activeCount);
  return remaining === 0
    ? { kind: 'exhausted', limit, used: activeCount }
    : { kind: 'available', limit, used: activeCount, remaining };
}

function recurrenceLabel(assignment: SopAssignment) {
  if (assignment.frequency === 'INTERVAL') {
    const days = assignment.daysOfWeek
      .map((day) => dayOptions.find(([value]) => Number(value) === day)?.[1] ?? String(day))
      .join(', ');
    return `Every ${assignment.interval} min · ${days} · ${assignment.branch.timezone}`;
  }
  const interval = assignment.interval === 1 ? '' : ` every ${assignment.interval}`;
  if (assignment.frequency === 'WEEKLY' && assignment.daysOfWeek.length) {
    const days = assignment.daysOfWeek
      .map((day) => dayOptions.find(([value]) => Number(value) === day)?.[1] ?? String(day))
      .join(', ');
    return `${assignment.frequency}${interval} · ${days}`;
  }
  if (assignment.frequency === 'MONTHLY' && assignment.monthDay) {
    return `${assignment.frequency}${interval} · day ${assignment.monthDay}`;
  }
  return `${assignment.frequency}${interval}`;
}

function intervalMinutes(data: FormData): number {
  const value = formNumber(data, 'interval', 1);
  return formText(data, 'intervalUnit') === 'hours' ? value * 60 : value;
}

function schedulePreviewLine(
  preview: SchedulePreview,
  timeZone: string | undefined
): string | null {
  if (!preview.length || !timeZone) return null;
  const firstDate = preview[0]!.businessDate;
  const today = preview.filter((item) => item.businessDate === firstDate);
  const times = today.slice(0, 3).map((item) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(new Date(item.dueAt))
  );
  return `Next: ${times.join(', ')}${today.length > 3 ? ' …' : ''} (${today.length} today) · ${timeZone}`;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
      <p className="font-medium text-text-strong">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-text-muted">{detail}</p>
    </div>
  );
}

function QueryLoading() {
  return (
    <div className="grid gap-5 xl:grid-cols-2" role="status" aria-label="Loading SOP workspace">
      {[0, 1].map((panel) => (
        <SectionCard key={panel} title="Loading workspace…">
          <div className="space-y-3">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-12 w-full motion-reduce:animate-none" />
            ))}
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

export type SopAdminViewProps = {
  moduleEnabled: boolean;
  /**
   * How the module reached its current state. `NONE` means the plan never
   * granted it; the other sources mean it was granted and then switched off.
   */
  moduleSource?: 'BASELINE' | 'PACKAGE' | 'CONTRACT' | 'OVERRIDE' | 'NONE';
  /** `undefined` when the platform never configured `sop.templates.max`. */
  templateLimit: number | undefined;
  templates: SopTemplate[];
  assignments: SopAssignment[];
  jobRoles: AssignableJobRole[];
  selectedTemplateId: string;
  selectedVersionId: string;
  version: SopVersion | null;
  state: 'loading' | 'ready' | 'error' | 'permission';
  loadError?: string;
  versionLoading?: boolean;
  versionError?: string;
  statusMessage?: string;
  mutationError?: string;
  pendingAction?: PendingAction;
  onRetry: () => void;
  onSelectTemplate: (id: string) => void;
  onSelectVersion: (id: string) => void;
  onCreateTemplate: (event: FormEvent<HTMLFormElement>) => void;
  onSetTemplateActive: (id: string, active: boolean, name: string) => void;
  onCreateDraft: (templateId: string) => void;
  onPublishVersion: (versionId: string) => void;
  onAddStep: (event: FormEvent<HTMLFormElement>) => void;
  onUpdateStep: (event: FormEvent<HTMLFormElement>, stepId: string) => void;
  onRemoveStep: (stepId: string, title: string) => void;
  onReorderSteps: (versionId: string, orderedStepIds: string[]) => void;
  onCreateAssignment: (event: FormEvent<HTMLFormElement>) => void;
  onPreviewSchedule?: (event: FormEvent<HTMLFormElement>) => void;
  schedulePreview?: SchedulePreview;
  previewBranchId?: string;
  previewLoading?: boolean;
  previewError?: string;
  onToggleAssignment: (id: string, active: boolean) => void;
};

export function SopAdminView({
  moduleEnabled,
  moduleSource,
  templateLimit,
  templates,
  assignments,
  jobRoles,
  selectedTemplateId,
  selectedVersionId,
  version,
  state,
  loadError,
  versionLoading = false,
  versionError,
  statusMessage,
  mutationError,
  pendingAction,
  onRetry,
  onSelectTemplate,
  onSelectVersion,
  onCreateTemplate,
  onSetTemplateActive,
  onCreateDraft,
  onPublishVersion,
  onAddStep,
  onUpdateStep,
  onRemoveStep,
  onReorderSteps,
  onCreateAssignment,
  onPreviewSchedule,
  schedulePreview = [],
  previewBranchId,
  previewLoading = false,
  previewError,
  onToggleAssignment,
}: SopAdminViewProps) {
  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: moduleEnabled,
  });
  const staffQuery = trpc.restaurantStaff.listDirectory.useQuery(undefined, {
    enabled: moduleEnabled,
  });
  const [frequency, setFrequency] = useState<Frequency>('DAILY');
  // SOP-1: the two assignment modes are mutually exclusive per assignment, so the
  // form swaps one control for the other rather than showing both and validating
  // afterwards — an invalid combination is never expressible.
  const [assigneeMode, setAssigneeMode] = useState<AssigneeMode>('role');
  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'hours'>('minutes');
  const previewTimezone = branchesQuery.data?.find(
    (branch) => branch.id === previewBranchId
  )?.timezone;
  const selectedTemplate =
    templates.find((template) => template.id === selectedTemplateId) ?? templates[0] ?? null;
  const versions = selectedTemplate?.versions ?? [];
  const previewLine = schedulePreviewLine(schedulePreview, previewTimezone);
  const selectedVersion =
    versions.find((item) => item.id === selectedVersionId) ?? versions[0] ?? null;
  const draftVersion = versions.find((item) => item.status === 'DRAFT');
  const activeTemplateCount = templates.filter((template) => template.isActive).length;
  const capacity = resolveTemplateCapacity(templateLimit, activeTemplateCount);
  const canCreateTemplate = capacity.kind === 'available';
  const notInPlan = moduleSource === 'NONE';
  const anyPending = pendingAction != null;
  // WCAG 2.4.3: Retry sends the queries back through 'loading', which unmounts the
  // error card that held focus. Once they settle, focus the page heading (or the new
  // Retry button if the retry failed) instead of letting focus fall back to <body>.
  const headingRef = useRef<HTMLSpanElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const retryRequestedRef = useRef(false);
  useEffect(() => {
    if (!retryRequestedRef.current || state === 'loading') return;
    retryRequestedRef.current = false;
    if (state === 'ready') headingRef.current?.focus();
    else if (state === 'error') retryButtonRef.current?.focus();
  }, [state]);

  return (
    <div className="min-w-0 space-y-6" aria-busy={state === 'loading'}>
      <PageHeader
        eyebrow="Restaurant operations"
        heading={
          <span
            ref={headingRef}
            tabIndex={-1}
            className="rounded-[3px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            SOP administration
          </span>
        }
        description="Author controlled procedures, publish immutable versions, and schedule branch work."
        actions={
          moduleEnabled ? (
            capacity.kind === 'unconfigured' ? (
              <StatusPill
                status="Limit not configured"
                tone="danger"
                label={`Limit not set · ${capacity.used} active`}
              />
            ) : capacity.kind === 'disabled' ? (
              <StatusPill
                status="Plan disabled"
                tone="neutral"
                label="Plan allowance · 0 allowed"
              />
            ) : capacity.kind === 'exhausted' ? (
              <StatusPill
                status="Limit reached"
                tone="warning"
                label={`Limit reached · ${capacity.used} / ${capacity.limit} active`}
              />
            ) : (
              <StatusPill
                status="Template capacity"
                tone="info"
                label={`Capacity · ${capacity.used} / ${capacity.limit} active`}
              />
            )
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
        notInPlan ? (
          <SectionCard title="SOP & Compliance is not in this plan">
            <div className="space-y-3" role="status">
              <StatusPill status="Not in plan" tone="neutral" />
              <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
                Your organization’s current plan does not include SOP &amp; Compliance, so there is
                no template quota to spend here. Nothing has been used up and no data is missing.
              </p>
              <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
                Contact your administrator or DevFathom sales to add the module. Your current
                package and contract are listed on the organization page.
              </p>
              <Link
                className={`${buttonVariants({ variant: 'secondary' })} min-h-11`}
                href="/organization"
              >
                Review plan &amp; modules
              </Link>
            </div>
          </SectionCard>
        ) : (
          <SectionCard title="SOP & Compliance is turned off">
            <div className="space-y-3" role="status">
              <StatusPill status="Disabled" tone="warning" />
              <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
                SOP &amp; Compliance is included in your plan but is currently switched off for this
                organization. Existing templates, versions, and schedules are retained.
              </p>
              <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
                Ask your platform administrator to re-enable the module to resume authoring.
              </p>
            </div>
          </SectionCard>
        )
      ) : state === 'loading' ? (
        <QueryLoading />
      ) : state === 'permission' ? (
        <SectionCard title="SOP administration unavailable">
          <div className="space-y-3" role="alert">
            <StatusPill status="Permission required" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              The <span className="font-mono text-xs">sop:manage</span> capability is required to
              open this authoring console.
            </p>
          </div>
        </SectionCard>
      ) : state === 'error' ? (
        <SectionCard title="SOP workspace could not load">
          <div className="flex flex-wrap items-center justify-between gap-4" role="alert">
            <p className="max-w-2xl text-sm text-text-muted">
              {loadError || 'No data was changed. Retry the authoring contract.'}
            </p>
            <Button
              ref={retryButtonRef}
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                retryRequestedRef.current = true;
                onRetry();
              }}
            >
              Retry
            </Button>
          </div>
        </SectionCard>
      ) : (
        <>
          <SectionCard
            eyebrow="sop.templates.max"
            title="Template library"
            titleLevel={2}
            actions={
              capacity.kind === 'unconfigured' ? (
                <StatusPill
                  status="Allowance not configured"
                  tone="danger"
                  label={`Not configured · ${capacity.used} active`}
                />
              ) : capacity.kind === 'disabled' ? (
                <StatusPill
                  status="Disabled by plan"
                  tone="neutral"
                  label={`Disabled · ${capacity.used} active · 0 allowed`}
                />
              ) : capacity.kind === 'exhausted' ? (
                <StatusPill
                  status="Quota used"
                  tone="warning"
                  label={`Quota used · ${capacity.used} of ${capacity.limit} allowed`}
                />
              ) : (
                <StatusPill
                  status="Available"
                  tone="success"
                  label={`Available · ${capacity.used} of ${capacity.limit} allowed`}
                />
              )
            }
          >
            <form id="new-template" className="mb-6" onSubmit={onCreateTemplate}>
              <fieldset disabled={!canCreateTemplate || anyPending}>
                <legend className="font-display text-base font-semibold text-text-strong">
                  Create template
                </legend>
                <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_0.7fr_1.4fr_auto] lg:items-end">
                  <label className="space-y-1.5">
                    <span className={labelClass}>Name</span>
                    <Input name="name" required maxLength={200} className="h-11" />
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Category</span>
                    <Input name="category" maxLength={200} className="h-11" />
                  </label>
                  <label className="space-y-1.5">
                    <span className={labelClass}>Description</span>
                    <Input name="description" maxLength={2000} className="h-11" />
                  </label>
                  <Button type="submit" className="min-h-11">
                    {pendingAction === 'create-template' ? 'Creating…' : 'Create template'}
                  </Button>
                </div>
              </fieldset>
              <p
                id="template-limit-note"
                data-capacity={capacity.kind}
                className={`mt-2 text-xs ${
                  capacity.kind === 'unconfigured'
                    ? 'text-destructive'
                    : capacity.kind === 'disabled'
                      ? 'text-text-muted'
                      : capacity.kind === 'exhausted'
                        ? 'text-warning'
                        : 'text-text-muted'
                }`}
              >
                {capacity.kind === 'unconfigured'
                  ? 'The active-template allowance is not configured for this plan. Creating templates is paused until a platform administrator sets sop.templates.max — this is a configuration fault, not a used-up quota.'
                  : capacity.kind === 'disabled'
                    ? 'Your plan deliberately disables active SOP templates with an allowance of 0. Ask your administrator to change the plan allowance to enable template creation.'
                    : capacity.kind === 'exhausted'
                      ? `Your plan’s active-template quota is fully used (${capacity.limit} of ${capacity.limit}). Archive an active template below to free a slot.`
                      : `${capacity.remaining} active template slot${
                          capacity.remaining === 1 ? '' : 's'
                        } remaining.`}
              </p>
            </form>

            {templates.length ? (
              <Table className="min-w-[720px]">
                <TableCaption className="sr-only">
                  SOP templates with lifecycle and version history
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Template</TableHead>
                    <TableHead>Family state</TableHead>
                    <TableHead numeric>Versions</TableHead>
                    <TableHead>Latest version</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {templates.map((template) => {
                    const latest = template.versions[0];
                    const selected = template.id === selectedTemplate?.id;
                    return (
                      <TableRow key={template.id} aria-selected={selected}>
                        <TableCell className="whitespace-normal">
                          <span className="block font-medium text-text-strong">
                            {template.name}
                          </span>
                          <span className="block max-w-md text-xs text-text-muted">
                            {template.category || template.description || 'Uncategorized procedure'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <StatusPill
                            status={template.isActive ? 'ACTIVE' : 'INACTIVE'}
                            tone={statusTone(template.isActive ? 'ACTIVE' : 'INACTIVE')}
                          />
                        </TableCell>
                        <TableCell numeric>{template.versions.length}</TableCell>
                        <TableCell>
                          {latest ? (
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs">v{latest.versionNumber}</span>
                              <StatusPill status={latest.status} tone={statusTone(latest.status)} />
                            </div>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant={selected ? 'secondary' : 'outline'}
                              aria-pressed={selected}
                              onClick={() => onSelectTemplate(template.id)}
                            >
                              {selected ? 'Selected' : 'Open'}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={anyPending || (!template.isActive && !canCreateTemplate)}
                              aria-describedby={
                                !template.isActive && !canCreateTemplate
                                  ? 'template-limit-note'
                                  : undefined
                              }
                              onClick={() =>
                                onSetTemplateActive(template.id, !template.isActive, template.name)
                              }
                            >
                              {pendingAction === 'set-template-active'
                                ? 'Updating…'
                                : template.isActive
                                  ? 'Archive'
                                  : 'Reactivate'}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                title="No SOP templates yet"
                detail="Create the first template family above. Its initial draft opens automatically."
              />
            )}
          </SectionCard>

          <SectionCard
            eyebrow="Version workspace"
            title={selectedTemplate?.name ?? 'Select a template'}
            actions={
              selectedTemplate ? (
                <StatusPill
                  status={selectedTemplate.isActive ? 'ACTIVE' : 'INACTIVE'}
                  tone={statusTone(selectedTemplate.isActive ? 'ACTIVE' : 'INACTIVE')}
                />
              ) : null
            }
          >
            {!selectedTemplate ? (
              <EmptyState
                title="No template selected"
                detail="Create or select a template to inspect immutable version history and steps."
              />
            ) : (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle pb-4">
                  <div>
                    <p className={labelClass}>Version history</p>
                    <div
                      className="mt-2 flex flex-wrap gap-2"
                      role="group"
                      aria-label="Version history"
                    >
                      {versions.map((item) => (
                        <Button
                          key={item.id}
                          type="button"
                          size="sm"
                          variant={item.id === selectedVersion?.id ? 'secondary' : 'outline'}
                          aria-pressed={item.id === selectedVersion?.id}
                          onClick={() => onSelectVersion(item.id)}
                        >
                          v{item.versionNumber} · {item.status}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={Boolean(draftVersion) || anyPending}
                      onClick={() => onCreateDraft(selectedTemplate.id)}
                    >
                      {pendingAction === 'create-draft'
                        ? 'Opening draft…'
                        : draftVersion
                          ? 'Draft already open'
                          : 'Create draft version'}
                    </Button>
                    {selectedVersion?.status === 'DRAFT' ? (
                      <Button
                        type="button"
                        className="min-h-11"
                        disabled={versionLoading || !version?.steps.length || anyPending}
                        onClick={() => onPublishVersion(selectedVersion.id)}
                      >
                        {pendingAction === 'publish-version' ? 'Publishing…' : 'Publish draft'}
                      </Button>
                    ) : null}
                  </div>
                </div>

                {versionLoading ? (
                  <div className="space-y-3" role="status" aria-label="Loading SOP version">
                    {[0, 1, 2].map((row) => (
                      <Skeleton key={row} className="h-16 w-full motion-reduce:animate-none" />
                    ))}
                  </div>
                ) : versionError ? (
                  <p
                    className="rounded-md bg-destructive/10 p-4 text-sm text-destructive"
                    role="alert"
                  >
                    {versionError}
                  </p>
                ) : version ? (
                  <>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono text-xs text-text-muted">
                        VERSION {version.versionNumber}
                      </span>
                      <StatusPill status={version.status} tone={statusTone(version.status)} />
                      <span className="text-xs text-text-muted">
                        {version.steps.length} step{version.steps.length === 1 ? '' : 's'}
                      </span>
                    </div>

                    {version.steps.length ? (
                      <ol className="divide-y divide-border-subtle rounded-md border border-border-subtle">
                        {version.steps.map((step, index) => (
                          <li
                            key={step.id}
                            className="grid gap-3 p-4 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:items-start"
                          >
                            <span className="font-mono text-xs text-text-muted">
                              {String(step.stepOrder).padStart(2, '0')}
                            </span>
                            <div className="min-w-0">
                              <p className="font-medium text-text-strong">{step.title}</p>
                              {step.instructions ? (
                                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-muted">
                                  {step.instructions}
                                </p>
                              ) : null}
                            </div>
                            <div
                              className="flex flex-wrap gap-1.5 sm:justify-end"
                              aria-label="Required evidence"
                            >
                              {step.requiresPhoto ? (
                                <StatusPill status="Photo" tone="info" />
                              ) : null}
                              {step.requiresSignature ? (
                                <StatusPill status="Signature" tone="warning" />
                              ) : null}
                              {step.requiresNote ? (
                                <StatusPill status="Note" tone="neutral" />
                              ) : null}
                              {!step.requiresPhoto &&
                              !step.requiresSignature &&
                              !step.requiresNote ? (
                                <span className="text-xs text-text-muted">
                                  No evidence required
                                </span>
                              ) : null}
                            </div>
                            {version.status === 'DRAFT' ? (
                              <div className="space-y-3 sm:col-span-2 sm:col-start-2">
                                <div
                                  className="flex flex-wrap gap-2"
                                  role="group"
                                  aria-label={`Manage ${step.title}`}
                                >
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={index === 0 || anyPending}
                                    aria-label={`Move ${step.title} up`}
                                    onClick={() => {
                                      const orderedStepIds = version.steps.map((item) => item.id);
                                      [orderedStepIds[index - 1], orderedStepIds[index]] = [
                                        orderedStepIds[index],
                                        orderedStepIds[index - 1],
                                      ];
                                      onReorderSteps(version.id, orderedStepIds);
                                    }}
                                  >
                                    Move up
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={index === version.steps.length - 1 || anyPending}
                                    aria-label={`Move ${step.title} down`}
                                    onClick={() => {
                                      const orderedStepIds = version.steps.map((item) => item.id);
                                      [orderedStepIds[index], orderedStepIds[index + 1]] = [
                                        orderedStepIds[index + 1],
                                        orderedStepIds[index],
                                      ];
                                      onReorderSteps(version.id, orderedStepIds);
                                    }}
                                  >
                                    Move down
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="text-destructive"
                                    disabled={anyPending}
                                    onClick={() => onRemoveStep(step.id, step.title)}
                                  >
                                    {pendingAction === 'remove-step' ? 'Removing…' : 'Remove'}
                                  </Button>
                                </div>
                                <details className="rounded-md border border-border-subtle bg-surface-raised p-3">
                                  <summary className="min-h-11 cursor-pointer font-medium text-text-strong outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                                    Edit step
                                  </summary>
                                  <form
                                    className="mt-3 grid gap-3 lg:grid-cols-2"
                                    onSubmit={(event) => onUpdateStep(event, step.id)}
                                  >
                                    <fieldset className="contents" disabled={anyPending}>
                                      <label className="space-y-1.5">
                                        <span className={labelClass}>Step title</span>
                                        <Input
                                          name="title"
                                          required
                                          maxLength={500}
                                          defaultValue={step.title}
                                          className="h-11"
                                        />
                                      </label>
                                      <label className="space-y-1.5 lg:row-span-2">
                                        <span className={labelClass}>Instructions</span>
                                        <Textarea
                                          name="instructions"
                                          maxLength={2000}
                                          defaultValue={step.instructions ?? ''}
                                          className="min-h-28"
                                        />
                                      </label>
                                      <fieldset>
                                        <legend className={labelClass}>
                                          Evidence requirements
                                        </legend>
                                        <div className="mt-2 flex flex-wrap gap-3">
                                          {[
                                            ['requiresPhoto', 'Photo', step.requiresPhoto],
                                            [
                                              'requiresSignature',
                                              'Signature',
                                              step.requiresSignature,
                                            ],
                                            ['requiresNote', 'Note', step.requiresNote],
                                          ].map(([name, label, checked]) => (
                                            <label
                                              key={String(name)}
                                              className="flex min-h-11 items-center gap-2 rounded-md border border-border-subtle px-3 text-sm text-text-body"
                                            >
                                              <input
                                                type="checkbox"
                                                name={String(name)}
                                                defaultChecked={Boolean(checked)}
                                                className="size-4 accent-primary"
                                              />
                                              {String(label)}
                                            </label>
                                          ))}
                                        </div>
                                      </fieldset>
                                      <Button type="submit" className="min-h-11 lg:col-span-2">
                                        {pendingAction === 'update-step' ? 'Saving…' : 'Save step'}
                                      </Button>
                                    </fieldset>
                                  </form>
                                </details>
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <EmptyState
                        title="Draft has no steps"
                        detail="Add at least one ordered step before this version can be published."
                      />
                    )}

                    {version.status === 'DRAFT' ? (
                      <form className="border-t border-border-subtle pt-5" onSubmit={onAddStep}>
                        <fieldset disabled={anyPending}>
                          <legend className="font-display text-base font-semibold text-text-strong">
                            Add draft step
                          </legend>
                          <div className="mt-3 grid gap-3 lg:grid-cols-2">
                            <label className="space-y-1.5">
                              <span className={labelClass}>Step title</span>
                              <Input name="title" required maxLength={500} className="h-11" />
                            </label>
                            <label className="space-y-1.5 lg:row-span-2">
                              <span className={labelClass}>Instructions</span>
                              <Textarea name="instructions" maxLength={2000} className="min-h-28" />
                            </label>
                            <fieldset>
                              <legend className={labelClass}>Evidence requirements</legend>
                              <div className="mt-2 flex flex-wrap gap-3">
                                {[
                                  ['requiresPhoto', 'Photo'],
                                  ['requiresSignature', 'Signature'],
                                  ['requiresNote', 'Note'],
                                ].map(([name, label]) => (
                                  <label
                                    key={name}
                                    className="flex min-h-11 items-center gap-2 rounded-md border border-border-subtle px-3 text-sm text-text-body"
                                  >
                                    <input
                                      type="checkbox"
                                      name={name}
                                      className="size-4 accent-primary"
                                    />
                                    {label}
                                  </label>
                                ))}
                              </div>
                            </fieldset>
                          </div>
                          <Button type="submit" className="mt-4 min-h-11">
                            {pendingAction === 'add-step' ? 'Adding step…' : 'Add step'}
                          </Button>
                        </fieldset>
                      </form>
                    ) : (
                      <p className="border-t border-border-subtle pt-4 text-sm text-text-muted">
                        {version.status === 'PUBLISHED'
                          ? 'Published steps are immutable. Open a new draft to revise this procedure.'
                          : 'Retired versions remain available as read-only history.'}
                      </p>
                    )}
                  </>
                ) : (
                  <EmptyState
                    title="No version selected"
                    detail="Select a version to inspect its ordered procedure steps."
                  />
                )}
              </div>
            )}
          </SectionCard>

          <SectionCard
            eyebrow="Branch schedules"
            title="Assignments"
            actions={
              <StatusPill
                status="Assignments"
                tone="info"
                label={`${assignments.filter((assignment) => assignment.active).length} active`}
              />
            }
          >
            <div className="grid gap-6 xl:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]">
              <form
                onSubmit={(event) => {
                  const submitter = (event.nativeEvent as SubmitEvent)
                    .submitter as HTMLButtonElement;
                  if (submitter?.value === 'preview' && onPreviewSchedule) onPreviewSchedule(event);
                  else onCreateAssignment(event);
                }}
              >
                <fieldset disabled={!selectedTemplate || anyPending}>
                  <legend className="font-display text-base font-semibold text-text-strong">
                    Create assignment
                  </legend>
                  <p className="mt-1 text-sm text-text-muted">
                    {selectedTemplate
                      ? `Scheduling ${selectedTemplate.name}.`
                      : 'Select a template before creating a branch schedule.'}
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                    <label className="space-y-1.5 sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                      <span className={labelClass}>Branch</span>
                      <RestaurantBranchSelect
                        name="branchId"
                        required
                        branches={branchesQuery.data ?? []}
                        loading={branchesQuery.isLoading}
                        error={Boolean(branchesQuery.error)}
                      />
                    </label>
                    <label className="space-y-1.5 sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                      <span className={labelClass}>Assign to</span>
                      <select
                        name="assigneeMode"
                        className={selectClass}
                        value={assigneeMode}
                        onChange={(event) => setAssigneeMode(event.target.value as AssigneeMode)}
                        aria-describedby="assignee-mode-help"
                      >
                        <option value="role">A job role (claimable pool)</option>
                        <option value="person">A named person (assigned directly)</option>
                      </select>
                    </label>
                    <p
                      id="assignee-mode-help"
                      className="text-xs leading-relaxed text-text-muted sm:col-span-2 xl:col-span-1 2xl:col-span-2"
                    >
                      {assigneeMode === 'role'
                        ? 'Every occurrence becomes an unclaimed item in that role’s branch pool. Any holder of the role at the branch can claim it; the first claim wins.'
                        : 'Every occurrence is assigned directly to this person. There is nothing to claim.'}
                    </p>
                    {assigneeMode === 'role' ? (
                      <label className="space-y-1.5 sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                        <span className={labelClass}>Job role</span>
                        {jobRoles.length ? (
                          <select name="assigneeJobRoleId" required className={selectClass}>
                            {jobRoles.map((role) => (
                              <option key={role.id} value={role.id}>
                                {role.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <p className="rounded-md border border-dashed border-border-subtle px-3 py-2 text-xs text-text-muted">
                            No active job roles yet. Create them in staff administration before
                            pooling work to a role.
                          </p>
                        )}
                      </label>
                    ) : (
                      <label className="space-y-1.5 sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                        <span className={labelClass}>Staff member</span>
                        <RestaurantStaffSelect
                          name="assigneeStaffProfileId"
                          required
                          staff={staffQuery.data ?? []}
                          loading={staffQuery.isLoading}
                          error={Boolean(staffQuery.error)}
                        />
                      </label>
                    )}
                    <label className="space-y-1.5">
                      <span className={labelClass}>Frequency</span>
                      <select
                        name="frequency"
                        className={selectClass}
                        value={frequency}
                        onChange={(event) => setFrequency(event.target.value as Frequency)}
                      >
                        <option value="ONCE">Once</option>
                        <option value="DAILY">Daily</option>
                        <option value="WEEKLY">Weekly</option>
                        <option value="MONTHLY">Monthly</option>
                        <option value="INTERVAL">Every N minutes</option>
                      </select>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Every</span>
                      <Input
                        key={`${frequency}-${intervalUnit}`}
                        name="interval"
                        type="number"
                        min={frequency === 'INTERVAL' ? (intervalUnit === 'hours' ? 1 : 15) : 1}
                        max={
                          frequency === 'INTERVAL' ? (intervalUnit === 'hours' ? 24 : 1440) : 365
                        }
                        defaultValue={
                          frequency === 'INTERVAL' ? (intervalUnit === 'hours' ? 1 : 15) : 1
                        }
                        required
                        className="h-11"
                      />
                    </label>
                    {frequency === 'INTERVAL' ? (
                      <label className="space-y-1.5">
                        <span className={labelClass}>Interval unit</span>
                        <select
                          name="intervalUnit"
                          className={selectClass}
                          value={intervalUnit}
                          onChange={(event) =>
                            setIntervalUnit(event.target.value as 'minutes' | 'hours')
                          }
                        >
                          <option value="minutes">Minutes</option>
                          <option value="hours">Hours</option>
                        </select>
                      </label>
                    ) : null}
                    {frequency === 'WEEKLY' || frequency === 'INTERVAL' ? (
                      <fieldset className="sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                        <legend className={labelClass}>
                          Days of week{frequency === 'INTERVAL' ? ' · required' : ''}
                        </legend>
                        <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-7 xl:grid-cols-4 2xl:grid-cols-7">
                          {dayOptions.map(([value, label]) => (
                            <label
                              key={value}
                              className="flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border-subtle px-2 text-xs text-text-body"
                            >
                              <input
                                type="checkbox"
                                name="daysOfWeek"
                                value={value}
                                className="size-4 accent-primary"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ) : null}
                    {frequency === 'MONTHLY' ? (
                      <label className="space-y-1.5">
                        <span className={labelClass}>Month day</span>
                        <Input
                          name="monthDay"
                          type="number"
                          min={1}
                          max={31}
                          defaultValue={1}
                          required
                          className="h-11"
                        />
                      </label>
                    ) : null}
                    <label className="space-y-1.5">
                      <span className={labelClass}>Start date</span>
                      <Input name="startDate" type="date" required className="h-11" />
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>End date</span>
                      <Input name="endDate" type="date" className="h-11" />
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>
                        {frequency === 'INTERVAL' ? 'Start time' : 'Due time'}
                      </span>
                      <Input
                        name="dueTime"
                        type="time"
                        defaultValue="09:00"
                        required
                        className="h-11"
                      />
                    </label>
                    {frequency === 'INTERVAL' ? (
                      <label className="space-y-1.5">
                        <span className={labelClass}>End time</span>
                        <Input
                          name="intervalEndTime"
                          type="time"
                          defaultValue="17:00"
                          required
                          className="h-11"
                        />
                      </label>
                    ) : null}
                    <label className="space-y-1.5">
                      <span className={labelClass}>Due window · min</span>
                      <Input
                        name="windowMinutes"
                        type="number"
                        min={0}
                        max={1440}
                        defaultValue={60}
                        required
                        className="h-11"
                      />
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Grace · min</span>
                      <Input
                        name="graceMinutes"
                        type="number"
                        min={0}
                        max={1440}
                        defaultValue={15}
                        required
                        className="h-11"
                      />
                    </label>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button type="submit" className="min-h-11">
                      {pendingAction === 'create-assignment' ? 'Creating…' : 'Create assignment'}
                    </Button>
                    <Button
                      type="submit"
                      name="intent"
                      value="preview"
                      variant="outline"
                      className="min-h-11"
                    >
                      {previewLoading ? 'Previewing…' : 'Preview schedule'}
                    </Button>
                  </div>
                  {previewError ? (
                    <p className="mt-3 text-sm text-destructive" role="alert">
                      {previewError}
                    </p>
                  ) : null}
                  {previewLine ? (
                    <div
                      className="mt-3 rounded-md border border-border-subtle bg-surface-sunken p-3"
                      role="status"
                    >
                      <p className="text-sm text-text-body">{previewLine}</p>
                    </div>
                  ) : null}
                </fieldset>
              </form>

              <div className="min-w-0 border-t border-border-subtle pt-5 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6">
                {assignments.length ? (
                  <Table className="min-w-[920px]">
                    <TableCaption className="sr-only">
                      Branch SOP assignments and recurrence settings
                    </TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Branch</TableHead>
                        <TableHead>Template</TableHead>
                        <TableHead>Recurrence</TableHead>
                        <TableHead>Schedule</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {assignments.map((assignment) => (
                        <TableRow key={assignment.id}>
                          <TableCell>
                            <span className="block font-medium text-text-strong">
                              {assignment.branch.name}
                            </span>
                            <span className="block font-mono text-[0.6875rem] text-text-muted">
                              {assignment.branch.timezone}
                            </span>
                          </TableCell>
                          <TableCell>{assignment.template.name}</TableCell>
                          <TableCell className="whitespace-normal">
                            <span className="block">{recurrenceLabel(assignment)}</span>
                            <span className="block text-xs text-text-muted">
                              {dateOnly(assignment.startDate)} – {dateOnly(assignment.endDate)}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="block">
                              {assignment.frequency === 'INTERVAL'
                                ? `${minutesLabel(assignment.dueTimeMinutes)}–${minutesLabel(assignment.intervalEndTimeMinutes!)}`
                                : `Due ${minutesLabel(assignment.dueTimeMinutes)}`}
                            </span>
                            <span className="block text-xs text-text-muted">
                              {assignment.windowMinutes}m window · {assignment.graceMinutes}m grace
                            </span>
                          </TableCell>
                          <TableCell>
                            <StatusPill
                              status={assignment.active ? 'ACTIVE' : 'PAUSED'}
                              tone={assignment.active ? 'success' : 'neutral'}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={anyPending}
                              onClick={() => onToggleAssignment(assignment.id, !assignment.active)}
                            >
                              {pendingAction === 'toggle-assignment'
                                ? 'Updating…'
                                : assignment.active
                                  ? 'Pause'
                                  : 'Activate'}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState
                    title="No branch assignments"
                    detail="Create a schedule to connect a template family to branch-local time."
                  />
                )}
              </div>
            </div>
          </SectionCard>

          <SectionCard eyebrow="Related surface" title="Escalation policies">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="max-w-3xl">
                <p className="text-sm leading-relaxed text-text-body">
                  Escalation chains, compliance scoring, and occurrence audit history live in SOP
                  oversight. This authoring console still owns templates, versions, evidence
                  requirements, and branch schedules only.
                </p>
                <p className="mt-2 text-sm leading-relaxed text-text-muted">
                  Escalation policies are configured per organization or branch and apply to the
                  occurrences these assignments generate.
                </p>
              </div>
              <Link
                className={`${buttonVariants({ variant: 'secondary' })} min-h-11 shrink-0`}
                href="/restaurant/sop/oversight"
              >
                Open SOP oversight
              </Link>
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}

export default function RestaurantSopAdminPage() {
  const entitlements = useEntitlements();
  const sopModule = entitlements.modules.find((module) => module.key === 'restaurant-sop');
  const moduleEnabled =
    sopModule?.enabled ?? entitlements.enabledModules.includes('restaurant-sop');
  const templateLimitResolution = resolveEntitlementLimit(entitlements.limits, SOP_TEMPLATES_LIMIT);
  const templateLimit =
    templateLimitResolution.status === 'configured' ? templateLimitResolution.value : undefined;
  const utils = trpc.useUtils();
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [previewInput, setPreviewInput] = useState<SchedulePreviewInput | null>(null);

  const templatesQuery = trpc.restaurantSop.listTemplates.useQuery(
    { includeInactive: true },
    { enabled: moduleEnabled }
  );
  const jobRolesQuery = trpc.restaurantSop.listAssignableJobRoles.useQuery(undefined, {
    enabled: moduleEnabled,
  });
  const assignmentsQuery = trpc.restaurantSop.listAssignments.useQuery(undefined, {
    enabled: moduleEnabled,
  });
  const templates = templatesQuery.data ?? [];
  const selectedTemplate =
    templates.find((template) => template.id === selectedTemplateId) ?? templates[0] ?? null;
  const selectedVersion =
    selectedTemplate?.versions.find((version) => version.id === selectedVersionId) ??
    selectedTemplate?.versions[0] ??
    null;
  const versionQuery = trpc.restaurantSop.getVersion.useQuery(
    { versionId: selectedVersion?.id ?? '' },
    { enabled: moduleEnabled && Boolean(selectedVersion) }
  );
  const previewQuery = trpc.restaurantSop.previewSchedule.useQuery(
    previewInput ?? {
      branchId: '',
      from: '2000-01-01',
      to: '2000-01-01',
      frequency: 'DAILY',
      startDate: '2000-01-01',
    },
    { enabled: Boolean(previewInput) }
  );

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
  const refreshTemplates = () => void utils.restaurantSop.listTemplates.invalidate();
  const refreshVersion = () => void utils.restaurantSop.getVersion.invalidate();
  const refreshAssignments = () => void utils.restaurantSop.listAssignments.invalidate();

  const createTemplate = trpc.restaurantSop.createTemplate.useMutation({
    onSuccess: (template) => {
      setSelectedTemplateId(template.id);
      setSelectedVersionId(template.versions[0]?.id ?? '');
      refreshTemplates();
      succeed('SOP template created.');
    },
    onError: fail,
  });
  const setTemplateActive = trpc.restaurantSop.setTemplateActive.useMutation({
    onSuccess: (_, variables) => {
      refreshTemplates();
      succeed(variables.isActive ? 'SOP template reactivated.' : 'SOP template archived.');
    },
    onError: fail,
  });
  const createDraft = trpc.restaurantSop.createDraftVersion.useMutation({
    onSuccess: (created) => {
      setSelectedVersionId(created.id);
      refreshTemplates();
      refreshVersion();
      succeed(`Draft v${created.versionNumber} opened.`);
    },
    onError: fail,
  });
  const publishVersion = trpc.restaurantSop.publishVersion.useMutation({
    onSuccess: () => {
      refreshTemplates();
      refreshVersion();
      succeed('SOP draft published.');
    },
    onError: fail,
  });
  const addStep = trpc.restaurantSop.addStep.useMutation({
    onSuccess: () => {
      refreshVersion();
      succeed('Draft step added.');
    },
    onError: fail,
  });
  const updateStep = trpc.restaurantSop.updateStep.useMutation({
    onSuccess: () => {
      refreshVersion();
      succeed('Draft step updated.');
    },
    onError: fail,
  });
  const removeStep = trpc.restaurantSop.removeStep.useMutation({
    onSuccess: () => {
      refreshVersion();
      succeed('Draft step removed.');
    },
    onError: fail,
  });
  const reorderSteps = trpc.restaurantSop.reorderSteps.useMutation({
    onSuccess: () => {
      refreshVersion();
      succeed('Draft steps reordered.');
    },
    onError: fail,
  });
  const createAssignment = trpc.restaurantSop.createAssignment.useMutation({
    onSuccess: () => {
      refreshAssignments();
      succeed('Branch assignment created.');
    },
    onError: fail,
  });
  const toggleAssignment = trpc.restaurantSop.setAssignmentActive.useMutation({
    onSuccess: (_, variables) => {
      refreshAssignments();
      succeed(variables.active ? 'Assignment activated.' : 'Assignment paused.');
    },
    onError: fail,
  });

  const pendingAction: PendingAction | undefined = createTemplate.isPending
    ? 'create-template'
    : setTemplateActive.isPending
      ? 'set-template-active'
      : createDraft.isPending
        ? 'create-draft'
        : publishVersion.isPending
          ? 'publish-version'
          : addStep.isPending
            ? 'add-step'
            : updateStep.isPending
              ? 'update-step'
              : removeStep.isPending
                ? 'remove-step'
                : reorderSteps.isPending
                  ? 'reorder-steps'
                  : createAssignment.isPending
                    ? 'create-assignment'
                    : toggleAssignment.isPending
                      ? 'toggle-assignment'
                      : undefined;
  const queryError = templatesQuery.error ?? assignmentsQuery.error;
  const state =
    templatesQuery.isLoading || assignmentsQuery.isLoading
      ? 'loading'
      : isPermissionError(queryError)
        ? 'permission'
        : queryError
          ? 'error'
          : 'ready';

  const submitTemplate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    createTemplate.mutate(
      {
        name: formText(data, 'name'),
        category: formText(data, 'category') || null,
        description: formText(data, 'description') || null,
      },
      { onSuccess: () => form.reset() }
    );
  };

  const submitStep = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedVersion) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    addStep.mutate(
      {
        templateVersionId: selectedVersion.id,
        title: formText(data, 'title'),
        instructions: formText(data, 'instructions') || null,
        requiresPhoto: data.has('requiresPhoto'),
        requiresSignature: data.has('requiresSignature'),
        requiresNote: data.has('requiresNote'),
      },
      { onSuccess: () => form.reset() }
    );
  };

  const submitStepUpdate = (event: FormEvent<HTMLFormElement>, stepId: string) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    updateStep.mutate({
      stepId,
      title: formText(data, 'title'),
      instructions: formText(data, 'instructions') || null,
      requiresPhoto: data.has('requiresPhoto'),
      requiresSignature: data.has('requiresSignature'),
      requiresNote: data.has('requiresNote'),
    });
  };

  const submitAssignment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTemplate) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const frequency = formText(data, 'frequency') as Frequency;
    // SOP-1: the form renders exactly one of the two assignee controls, so the
    // mode decides which field to read. Reading both and picking a winner would
    // let a stale hidden value survive a mode switch.
    const assigneeTarget =
      formText(data, 'assigneeMode') === 'person'
        ? ({ type: 'person', staffProfileId: formText(data, 'assigneeStaffProfileId') } as const)
        : ({ type: 'role', jobRoleId: formText(data, 'assigneeJobRoleId') } as const);
    createAssignment.mutate(
      {
        branchId: formText(data, 'branchId'),
        templateId: selectedTemplate.id,
        assigneeTarget,
        frequency,
        interval:
          frequency === 'INTERVAL' ? intervalMinutes(data) : formNumber(data, 'interval', 1),
        daysOfWeek:
          frequency === 'WEEKLY' || frequency === 'INTERVAL'
            ? data.getAll('daysOfWeek').map((day) => Number(day))
            : [],
        monthDay: frequency === 'MONTHLY' ? formNumber(data, 'monthDay', 1) : null,
        startDate: formText(data, 'startDate'),
        endDate: formText(data, 'endDate') || null,
        dueTimeMinutes: timeToMinutes(formText(data, 'dueTime')),
        intervalEndTimeMinutes:
          frequency === 'INTERVAL' ? timeToMinutes(formText(data, 'intervalEndTime')) : null,
        windowMinutes: formNumber(data, 'windowMinutes', 60),
        graceMinutes: formNumber(data, 'graceMinutes', 15),
      },
      { onSuccess: () => form.reset() }
    );
  };

  const previewAssignment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const frequency = formText(data, 'frequency') as Frequency;
    const startDate = formText(data, 'startDate');
    setPreviewInput({
      branchId: formText(data, 'branchId'),
      from: startDate,
      to: formText(data, 'endDate') || startDate,
      frequency,
      interval: frequency === 'INTERVAL' ? intervalMinutes(data) : formNumber(data, 'interval', 1),
      daysOfWeek:
        frequency === 'WEEKLY' || frequency === 'INTERVAL'
          ? data.getAll('daysOfWeek').map(Number)
          : [],
      monthDay: frequency === 'MONTHLY' ? formNumber(data, 'monthDay', 1) : null,
      startDate,
      endDate: formText(data, 'endDate') || null,
      dueTimeMinutes: timeToMinutes(formText(data, 'dueTime')),
      intervalEndTimeMinutes:
        frequency === 'INTERVAL' ? timeToMinutes(formText(data, 'intervalEndTime')) : null,
      windowMinutes: formNumber(data, 'windowMinutes', 60),
    });
  };

  return (
    <SopAdminView
      moduleEnabled={moduleEnabled}
      moduleSource={sopModule?.source ?? 'NONE'}
      templateLimit={templateLimit}
      templates={templates}
      assignments={assignmentsQuery.data ?? []}
      jobRoles={jobRolesQuery.data ?? []}
      selectedTemplateId={selectedTemplate?.id ?? ''}
      selectedVersionId={selectedVersion?.id ?? ''}
      version={versionQuery.data ?? null}
      state={state}
      loadError={queryError?.message}
      versionLoading={versionQuery.isLoading}
      versionError={versionQuery.error?.message}
      statusMessage={statusMessage}
      mutationError={mutationError}
      pendingAction={pendingAction}
      onRetry={() => void Promise.all([templatesQuery.refetch(), assignmentsQuery.refetch()])}
      onSelectTemplate={(id) => {
        setSelectedTemplateId(id);
        setSelectedVersionId('');
      }}
      onSelectVersion={setSelectedVersionId}
      onCreateTemplate={submitTemplate}
      onSetTemplateActive={(id, active, name) => {
        if (
          !active &&
          !window.confirm(
            `Archive ${name}? New occurrences may no longer be scheduled from this template.`
          )
        )
          return;
        setTemplateActive.mutate({ id, isActive: active });
      }}
      onCreateDraft={(templateId) => createDraft.mutate({ templateId })}
      onPublishVersion={(versionId) => {
        if (
          window.confirm(
            `Publish draft v${selectedVersion?.versionNumber}? Publishing makes this draft immutable and retires the previously published version.`
          )
        )
          publishVersion.mutate({ versionId });
      }}
      onAddStep={submitStep}
      onUpdateStep={submitStepUpdate}
      onRemoveStep={(stepId, title) => {
        if (window.confirm(`Remove "${title}" from this draft? This cannot be undone.`))
          removeStep.mutate({ stepId });
      }}
      onReorderSteps={(versionId, orderedStepIds) =>
        reorderSteps.mutate({ versionId, orderedStepIds })
      }
      onCreateAssignment={submitAssignment}
      onPreviewSchedule={previewAssignment}
      schedulePreview={previewQuery.data ?? []}
      previewLoading={previewQuery.isFetching}
      previewError={previewQuery.error?.message}
      previewBranchId={previewInput?.branchId}
      onToggleAssignment={(id, active) => toggleAssignment.mutate({ id, active })}
    />
  );
}
