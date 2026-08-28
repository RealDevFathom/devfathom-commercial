'use client';

import { useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
import type { EntitlementView } from '@/lib/module-catalog';
import { Button } from '@/components/ui/button';
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

type RouterOutputs = inferRouterOutputs<AppRouter>;
type SopTemplate = RouterOutputs['restaurantSop']['listTemplates'][number];
type SopAssignment = RouterOutputs['restaurantSop']['listAssignments'][number];
type SopVersion = RouterOutputs['restaurantSop']['getVersion'];
type UiError = { message: string; data?: { code?: string } | null };
type Frequency = 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
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

/**
 * The console has two unrelated reasons a template cannot be created, and they
 * are not interchangeable. `unavailable` means the module was never granted, so
 * the remedy is commercial and lives outside this product. `granted` means the
 * module is on and the active-template quota governs, so the remedy is
 * operational and lives on this page. Rendering both as the same amber warning
 * told operators to go free a slot when no slot could ever exist.
 */
export type SopEntitlementGrant =
  | { status: 'unavailable'; reason: 'not-in-plan' | 'administratively-disabled' }
  | { status: 'granted'; templateLimit: number | null };

/**
 * Reads the grant off the existing entitlement view. `source === 'OVERRIDE'` on
 * a disabled module means a granted module was switched off for this
 * organization; every other disabled case means the plan never included it —
 * the same split the settings console already draws.
 */
export function resolveSopEntitlement(entitlements: EntitlementView): SopEntitlementGrant {
  const sopModule = entitlements.modules.find((module) => module.key === 'restaurant-sop');
  const enabled = sopModule?.enabled ?? entitlements.enabledModules.includes('restaurant-sop');
  if (!enabled) {
    return {
      status: 'unavailable',
      reason: sopModule?.source === 'OVERRIDE' ? 'administratively-disabled' : 'not-in-plan',
    };
  }
  const limit = entitlements.limits['sop.templates.max'];
  return { status: 'granted', templateLimit: typeof limit === 'number' ? limit : null };
}

/**
 * `unmeasured` is the state a missing `sop.templates.max` used to collapse into
 * via `?? 0`, which rendered a truthful-looking "0 active · 0 allowed". An
 * absent limit is unknown capacity, not zero capacity, so it reports neither.
 */
export type TemplateCapacity =
  | { kind: 'unmeasured' }
  | { kind: 'exhausted'; activeCount: number; limit: number }
  | { kind: 'available'; activeCount: number; limit: number; remaining: number };

export function resolveTemplateCapacity(
  templateLimit: number | null,
  activeCount: number
): TemplateCapacity {
  if (templateLimit == null) return { kind: 'unmeasured' };
  const remaining = templateLimit - activeCount;
  return remaining > 0
    ? { kind: 'available', activeCount, limit: templateLimit, remaining }
    : { kind: 'exhausted', activeCount, limit: templateLimit };
}

/**
 * `StatusPill` renders `label ?? status`, so the state word has to live inside
 * the label or the pill degrades to colour-only — banned by the Studio contract
 * (§6 status, §9 "state is never communicated by color alone").
 */
function capacityPill(capacity: TemplateCapacity): {
  status: string;
  tone: StatusTone;
  label: string;
} {
  switch (capacity.kind) {
    case 'unmeasured':
      return { status: 'Capacity unknown', tone: 'neutral', label: 'Capacity unknown' };
    case 'exhausted':
      return {
        status: 'Limit reached',
        tone: 'warning',
        label: `Limit reached · ${capacity.activeCount} of ${capacity.limit} active`,
      };
    case 'available':
      return {
        status: 'Within limit',
        tone: 'success',
        label: `${capacity.activeCount} of ${capacity.limit} active`,
      };
  }
}

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

function recurrenceLabel(assignment: SopAssignment) {
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
  entitlement: SopEntitlementGrant;
  templates: SopTemplate[];
  assignments: SopAssignment[];
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
  onToggleAssignment: (id: string, active: boolean) => void;
};

export function SopAdminView({
  entitlement,
  templates,
  assignments,
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
  onToggleAssignment,
}: SopAdminViewProps) {
  const [frequency, setFrequency] = useState<Frequency>('DAILY');
  const selectedTemplate =
    templates.find((template) => template.id === selectedTemplateId) ?? templates[0] ?? null;
  const versions = selectedTemplate?.versions ?? [];
  const selectedVersion =
    versions.find((item) => item.id === selectedVersionId) ?? versions[0] ?? null;
  const draftVersion = versions.find((item) => item.status === 'DRAFT');
  const activeTemplateCount = templates.filter((template) => template.isActive).length;
  const capacity: TemplateCapacity =
    entitlement.status === 'granted'
      ? resolveTemplateCapacity(entitlement.templateLimit, activeTemplateCount)
      : { kind: 'unmeasured' };
  // Fails closed exactly as the router does (`sop.templates.max ?? 0`): only a
  // published, unexhausted quota may enable create. Unknown capacity blocks the
  // form, but it is reported as unknown rather than as an exhausted limit.
  const createBlocked = capacity.kind !== 'available';
  const anyPending = pendingAction != null;

  return (
    <main className="min-w-0 space-y-6" aria-busy={state === 'loading'}>
      <PageHeader
        eyebrow="Restaurant operations"
        heading="SOP administration"
        description="Author controlled procedures, publish immutable versions, and schedule branch work."
        actions={
          entitlement.status === 'unavailable' ? (
            <StatusPill
              status={entitlement.reason === 'not-in-plan' ? 'Not in plan' : 'Turned off'}
              tone="neutral"
            />
          ) : (
            <StatusPill {...capacityPill(capacity)} />
          )
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

      {entitlement.status === 'unavailable' ? (
        <SectionCard
          title={
            entitlement.reason === 'not-in-plan'
              ? 'SOP & Compliance is not included in your plan'
              : 'SOP & Compliance is turned off for this organization'
          }
        >
          <div className="space-y-3" role="status">
            <StatusPill
              status={entitlement.reason === 'not-in-plan' ? 'Not in plan' : 'Turned off'}
              tone="neutral"
            />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              {entitlement.reason === 'not-in-plan'
                ? 'This feature is not included in your organization’s current plan. Contact your administrator or DevFathom sales to enable it.'
                : 'SOP & Compliance is disabled for this organization. Existing templates and branch schedules are preserved and stay unavailable until it is re-enabled. Contact your platform administrator to enable it.'}
            </p>
            <p className="max-w-2xl text-sm leading-relaxed text-text-faint">
              This is not a usage limit. No template quota applies while the module is unavailable,
              and archiving templates will not restore access.
            </p>
          </div>
        </SectionCard>
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
            <Button type="button" variant="outline" className="min-h-11" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </SectionCard>
      ) : (
        <>
          <SectionCard
            eyebrow="sop.templates.max"
            title="Template library"
            actions={<StatusPill {...capacityPill(capacity)} />}
          >
            <form id="new-template" className="mb-6" onSubmit={onCreateTemplate}>
              <fieldset disabled={createBlocked || anyPending}>
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
                className={`mt-2 text-xs ${
                  capacity.kind === 'exhausted'
                    ? 'text-warning'
                    : capacity.kind === 'unmeasured'
                      ? 'text-text-muted'
                      : 'text-text-faint'
                }`}
              >
                {capacity.kind === 'exhausted'
                  ? `Create is disabled: ${
                      capacity.limit === 1
                        ? 'the 1 active template slot included in your plan is'
                        : `all ${capacity.limit} active template slots included in your plan are`
                    } in use. Archive an active template below to free a slot.`
                  : capacity.kind === 'unmeasured'
                    ? 'Create is disabled: your plan has not published an active-template limit, so capacity cannot be confirmed. Contact your administrator to publish sop.templates.max.'
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
                              disabled={anyPending || (!template.isActive && createBlocked)}
                              aria-describedby={
                                !template.isActive && createBlocked
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
                      <span className="text-xs text-text-faint">
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
                            <span className="font-mono text-xs text-text-faint">
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
                                <span className="text-xs text-text-faint">
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
              <form onSubmit={onCreateAssignment}>
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
                      <span className={labelClass}>Branch ID</span>
                      <Input
                        name="branchId"
                        required
                        className="h-11 font-mono"
                        aria-describedby="branch-id-help"
                      />
                    </label>
                    <p
                      id="branch-id-help"
                      className="text-xs leading-relaxed text-text-faint sm:col-span-2 xl:col-span-1 2xl:col-span-2"
                    >
                      No branch-directory procedure exists in the L3 authoring contract. Enter a
                      known branch ID; the server validates tenant scope.
                    </p>
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
                      </select>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Every</span>
                      <Input
                        name="interval"
                        type="number"
                        min={1}
                        max={365}
                        defaultValue={1}
                        required
                        className="h-11"
                      />
                    </label>
                    {frequency === 'WEEKLY' ? (
                      <fieldset className="sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                        <legend className={labelClass}>Days of week</legend>
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
                      <span className={labelClass}>Due time</span>
                      <Input
                        name="dueTime"
                        type="time"
                        defaultValue="09:00"
                        required
                        className="h-11"
                      />
                    </label>
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
                  <Button type="submit" className="mt-4 min-h-11">
                    {pendingAction === 'create-assignment' ? 'Creating…' : 'Create assignment'}
                  </Button>
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
                            <span className="block font-mono text-[0.6875rem] text-text-faint">
                              {assignment.branch.timezone} · {assignment.branch.id}
                            </span>
                          </TableCell>
                          <TableCell>{assignment.template.name}</TableCell>
                          <TableCell className="whitespace-normal">
                            <span className="block">{recurrenceLabel(assignment)}</span>
                            <span className="block text-xs text-text-faint">
                              {dateOnly(assignment.startDate)} – {dateOnly(assignment.endDate)}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="block">
                              Due {minutesLabel(assignment.dueTimeMinutes)}
                            </span>
                            <span className="block text-xs text-text-faint">
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

          <SectionCard eyebrow="Contract boundary" title="Escalation policies">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="max-w-3xl">
                <p className="text-sm leading-relaxed text-text-body">
                  Escalation-policy configuration is not available from the current L3 SOP authoring
                  contract. This console does not read or persist escalation rules.
                </p>
                <p className="mt-2 text-sm leading-relaxed text-text-muted">
                  Templates, evidence requirements, and branch schedules remain ready for a future
                  server-owned escalation policy without implying policy is active today.
                </p>
              </div>
              <StatusPill status="Information only" tone="info" />
            </div>
          </SectionCard>
        </>
      )}
    </main>
  );
}

export default function RestaurantSopAdminPage() {
  const entitlements = useEntitlements();
  const entitlement = resolveSopEntitlement(entitlements);
  const moduleEnabled = entitlement.status === 'granted';
  const utils = trpc.useUtils();
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [mutationError, setMutationError] = useState('');

  const templatesQuery = trpc.restaurantSop.listTemplates.useQuery(
    { includeInactive: true },
    { enabled: moduleEnabled }
  );
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
    createAssignment.mutate(
      {
        branchId: formText(data, 'branchId'),
        templateId: selectedTemplate.id,
        frequency,
        interval: formNumber(data, 'interval', 1),
        daysOfWeek:
          frequency === 'WEEKLY' ? data.getAll('daysOfWeek').map((day) => Number(day)) : [],
        monthDay: frequency === 'MONTHLY' ? formNumber(data, 'monthDay', 1) : null,
        startDate: formText(data, 'startDate'),
        endDate: formText(data, 'endDate') || null,
        dueTimeMinutes: timeToMinutes(formText(data, 'dueTime')),
        windowMinutes: formNumber(data, 'windowMinutes', 60),
        graceMinutes: formNumber(data, 'graceMinutes', 15),
      },
      { onSuccess: () => form.reset() }
    );
  };

  return (
    <SopAdminView
      entitlement={entitlement}
      templates={templates}
      assignments={assignmentsQuery.data ?? []}
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
      onToggleAssignment={(id, active) => toggleAssignment.mutate({ id, active })}
    />
  );
}
