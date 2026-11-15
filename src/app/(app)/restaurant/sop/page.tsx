import { TRPCError } from '@trpc/server';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';
import { can, subjectFromSession } from '@/lib/abac';
import { businessDateToUtcDate, resolveBusinessDate } from '@/lib/restaurant/business-date';
import { hasModule } from '@/lib/entitlements';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { restaurantSopExecutionRouter } from '@/server/routers/restaurant-sop-execution';
import { createTRPCContext } from '@/server/trpc';

import { EvidenceCapture } from './evidence-capture';
import { SopLoadRecovery } from './sop-load-recovery';

/**
 * Resolve the tenant actor first, then hand the resolved session and
 * organization to the context factory.
 *
 * `createTRPCContext()` with no argument cannot stand in for this. It forwards
 * `{ request: undefined, session: undefined }` to `resolveTenantActor`, whose
 * `'session' in options` check reads that explicitly-undefined key as "the
 * caller already resolved the session". Auth.js is then never consulted, the
 * organization is always null, and the factory throws `Workspace not found.`
 * as an unhandled Server Component error on every request and every host.
 */
async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

/** The command action maps a throw to an error notice, so this reads there. */
const NO_ACTOR = 'Your session is no longer active. Sign in again and retry.';

const route = '/restaurant/sop';
const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-2.5 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50';

const GROUP_DEFINITIONS = [
  {
    status: 'SCHEDULED',
    label: 'Due',
    empty: 'No scheduled SOPs are due for this business date.',
  },
  {
    status: 'IN_PROGRESS',
    label: 'In progress',
    empty: 'No SOPs are currently being completed.',
  },
  {
    status: 'SUBMITTED',
    label: 'Awaiting review',
    empty: 'No submitted SOPs are waiting for verification.',
  },
  { status: 'LATE', label: 'Late', empty: 'No SOPs are currently late.' },
  { status: 'MISSED', label: 'Missed', empty: 'No SOPs were missed on this business date.' },
  { status: 'WAIVED', label: 'Waived', empty: 'No SOPs were waived on this business date.' },
  { status: 'REJECTED', label: 'Rework', empty: 'No rejected SOPs require rework.' },
] as const;

type SopStatus = (typeof GROUP_DEFINITIONS)[number]['status'];

const DEFAULT_STATUS_PRIORITY: readonly SopStatus[] = [
  'LATE',
  'MISSED',
  'SUBMITTED',
  'IN_PROGRESS',
  'SCHEDULED',
  'REJECTED',
  'WAIVED',
];

const STATUS_LABEL: Record<SopStatus, string> = {
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  LATE: 'Late',
  MISSED: 'Missed',
  WAIVED: 'Waived',
  REJECTED: 'Rejected',
};

const STATUS_TONE: Record<SopStatus, StatusTone> = {
  SCHEDULED: 'info',
  IN_PROGRESS: 'info',
  SUBMITTED: 'warning',
  LATE: 'danger',
  MISSED: 'danger',
  WAIVED: 'neutral',
  REJECTED: 'danger',
};

type BranchOption = {
  id: string;
  name: string;
  timezone: string;
  businessDayCutoff: string;
};

type StaffOption = { id: string; displayName: string };

type BoardItem = {
  id: string;
  status: SopStatus;
  templateName: string;
  category: string;
  dueAt: string;
  windowEndsAt: string;
  completedSteps: number;
  totalSteps: number;
  claimable: boolean;
};

type BoardGroup = {
  status: SopStatus;
  label: string;
  empty: string;
  items: BoardItem[];
};

type DetailStep = {
  templateStepId: string;
  occurrenceStepId: string | null;
  order: number;
  title: string;
  instructions: string | null;
  requirements: string[];
  completed: boolean;
  completedAt: string | null;
  completedByStaffProfileId: string | null;
  note: string | null;
};

type DetailEvidence = {
  id: string;
  occurrenceStepId: string | null;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
  storageRef: string | null;
  uploaderStaffProfileId: string | null;
  capturedAt: string;
  /** DEV-837: stored and hashed by the capture route, not caller-supplied metadata. */
  serverCaptured: boolean;
};

type DetailVerification = {
  id: string;
  action: string;
  actorStaffProfileId: string | null;
  coAuthorizationId: string | null;
  reason: string | null;
  createdAt: string;
};

type DetailEscalation = {
  id: string;
  kind: string;
  detail: string | null;
  actorStaffProfileId: string | null;
  createdAt: string;
};

type OccurrenceDetail = {
  id: string;
  status: SopStatus;
  businessDate: string;
  dueAt: string;
  windowEndsAt: string;
  templateName: string;
  category: string;
  versionNumber: number;
  steps: DetailStep[];
  evidence: DetailEvidence[];
  verifications: DetailVerification[];
  escalationEvents: DetailEscalation[];
  claimable: boolean;
};

type Notice = { kind: 'success' | 'error'; text: string };

type BoardStateProps = {
  state: 'ready' | 'empty';
  branches: BranchOption[];
  staff: StaffOption[];
  selectedBranch: BranchOption | null;
  businessDate: string;
  groups: BoardGroup[];
  selected: OccurrenceDetail | null;
  canVerify: boolean;
  notice?: Notice;
  action?: (formData: FormData) => void | Promise<void>;
};

export type SopBoardViewProps = { state: 'disabled' | 'permission' | 'error' } | BoardStateProps;

type SearchParams = Promise<{
  branch?: string | string[];
  date?: string | string[];
  occurrence?: string | string[];
  notice?: string | string[];
  kind?: string | string[];
}>;

const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const optionalField = (form: FormData, name: string) => field(form, name) || undefined;
const queryValue = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

function validBusinessDate(value: string | undefined) {
  if (!value) return undefined;
  try {
    businessDateToUtcDate(value);
    return value;
  } catch {
    return undefined;
  }
}

function formatBusinessDate(value: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(
    businessDateToUtcDate(value)
  );
}

function formatBranchDateTime(value: string | null, timeZone: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}

function formatBytes(value: number) {
  return `${new Intl.NumberFormat('en').format(value)} bytes`;
}

function staffName(staff: StaffOption[], id: string | null) {
  if (!id) return 'Web user / system';
  return staff.find((person) => person.id === id)?.displayName ?? 'Staff name unavailable';
}

function commandError(error: unknown, fallback: string) {
  return error instanceof TRPCError ? error.message : fallback;
}

function destination(form: FormData, notice: string, kind: Notice['kind']) {
  const params = new URLSearchParams({ notice, kind });
  const branchId = optionalField(form, 'branchId');
  const businessDate = optionalField(form, 'businessDate');
  const occurrenceId = optionalField(form, 'occurrenceId');
  if (branchId) params.set('branch', branchId);
  if (businessDate) params.set('date', businessDate);
  if (occurrenceId) params.set('occurrence', occurrenceId);
  return `${route}?${params}`;
}

function selectionHref(branchId: string, businessDate: string, occurrenceId: string) {
  const params = new URLSearchParams({
    branch: branchId,
    date: businessDate,
    occurrence: occurrenceId,
  });
  return `${route}?${params}`;
}

function emptyGroups(): BoardGroup[] {
  return GROUP_DEFINITIONS.map((group) => ({ ...group, items: [] }));
}

function CommandScope({
  branchId,
  businessDate,
  occurrenceId,
  intent,
}: {
  branchId: string;
  businessDate: string;
  occurrenceId: string;
  intent?: string;
}) {
  return (
    <>
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="businessDate" value={businessDate} />
      <input type="hidden" name="occurrenceId" value={occurrenceId} />
      {intent ? <input type="hidden" name="intent" value={intent} /> : null}
    </>
  );
}

function StaffSelect({
  staff,
  label,
  name = 'actorStaffProfileId',
  required = false,
}: {
  staff: StaffOption[];
  label: string;
  name?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-sm text-text-body">
      {label}
      <select className={selectClass} name={name} required={required}>
        <option value="">{required ? 'Select active staff' : 'Current web user'}</option>
        {staff.map((person) => (
          <option key={person.id} value={person.id}>
            {person.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}

function Status({ status }: { status: SopStatus }) {
  return <StatusPill status={status} label={STATUS_LABEL[status]} tone={STATUS_TONE[status]} />;
}

function SopBoardView(props: SopBoardViewProps) {
  const header = (
    <PageHeader
      eyebrow="Restaurant operations"
      heading="Branch SOP board"
      description="Due work, evidence, verification, and escalations for one branch business date."
    />
  );

  if (props.state !== 'ready' && props.state !== 'empty') {
    const copy = {
      disabled: {
        title: 'SOP module disabled',
        body: 'Enable the Restaurant SOP module to open the branch execution board.',
      },
      permission: {
        title: 'Permission denied',
        body: 'The sop:complete permission is required to view and operate the branch SOP board.',
      },
      error: {
        title: 'SOP board could not load',
        body: 'No SOP data was changed. Retry the board request when you are ready.',
      },
    }[props.state];

    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard>
          <h2 className="text-lg font-semibold text-text-strong">{copy.title}</h2>
          <p className="mt-2 text-sm text-text-muted">{copy.body}</p>
          {props.state === 'error' ? <SopLoadRecovery /> : null}
        </SectionCard>
      </div>
    );
  }

  const {
    action,
    branches,
    businessDate,
    canVerify,
    groups,
    notice,
    selected,
    selectedBranch,
    staff,
  } = props;
  const total = groups.reduce((count, group) => count + group.items.length, 0);
  const reviewAllowed = selected ? ['SUBMITTED', 'LATE'].includes(selected.status) : false;
  const waiveAllowed = selected ? ['SUBMITTED', 'LATE', 'MISSED'].includes(selected.status) : false;
  const startAllowed = selected
    ? ['SCHEDULED', 'REJECTED'].includes(selected.status) && !selected.claimable
    : false;
  const submitAllowed =
    selected?.status === 'IN_PROGRESS' && selected.steps.every((step) => step.completed);
  const escalationKinds = new Set(selected?.escalationEvents.map((event) => event.kind) ?? []);
  const acknowledgeAllowed =
    escalationKinds.has('FIRED') &&
    !escalationKinds.has('ACKNOWLEDGED') &&
    !escalationKinds.has('STOPPED');
  const occurrenceStepNames = new Map(
    selected?.steps.flatMap((step) =>
      step.occurrenceStepId ? [[step.occurrenceStepId, step.title] as const] : []
    ) ?? []
  );

  return (
    <div className="min-w-0 space-y-6">
      {header}

      {notice ? (
        <div
          className={`rounded-[var(--radius-sm)] border p-3 text-sm ${
            notice.kind === 'error'
              ? 'border-destructive bg-destructive-background text-destructive-foreground'
              : 'border-success bg-success-background text-success-foreground'
          }`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </div>
      ) : null}

      <SectionCard>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-text-strong">Board date</h2>
            <p className="mt-1 text-sm text-text-muted">
              {selectedBranch
                ? `${selectedBranch.name} · ${formatBusinessDate(businessDate)} · ${selectedBranch.timezone}`
                : 'No active restaurant branch is available.'}
            </p>
          </div>
          {selectedBranch ? (
            <span className="font-mono text-xs text-text-muted">
              Cutoff {selectedBranch.businessDayCutoff}
            </span>
          ) : null}
        </div>
        <form
          className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          method="get"
        >
          <label className="text-sm text-text-body">
            Branch
            <select
              className={selectClass}
              defaultValue={selectedBranch?.id ?? ''}
              disabled={!branches.length}
              name="branch"
              required
            >
              {!branches.length ? <option value="">No active branches</option> : null}
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-text-body">
            Business date
            <Input
              className="mt-1 min-h-11"
              defaultValue={businessDate}
              disabled={!selectedBranch}
              name="date"
              required
              type="date"
            />
          </label>
          <Button
            className="min-h-11 self-end"
            disabled={!selectedBranch}
            type="submit"
            variant="secondary"
          >
            Load board
          </Button>
        </form>
      </SectionCard>

      <section
        aria-label={`SOP summary, ${total} occurrences`}
        className="grid grid-cols-2 gap-4 sm:grid-cols-4 xl:grid-cols-7"
      >
        {groups.map((group) => (
          <Stat
            key={group.status}
            label={group.label}
            value={group.items.length}
            valueClassName="text-[1.75rem]"
          />
        ))}
      </section>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <SectionCard className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text-strong">Execution board</h2>
            <span className="font-mono text-xs text-text-muted">
              {total} {total === 1 ? 'occurrence' : 'occurrences'}
            </span>
          </div>
          <div className="mt-4 divide-y divide-border-subtle">
            {groups.map((group) => (
              <section className="py-5 first:pt-0 last:pb-0" key={group.status}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold text-text-strong">{group.label}</h3>
                  <span className="font-mono text-xs tabular-nums text-text-muted">
                    {group.items.length}
                  </span>
                </div>
                {group.items.length ? (
                  <ul className="mt-3 space-y-2">
                    {group.items.map((item) => {
                      const isSelected = item.id === selected?.id;
                      return (
                        <li key={item.id}>
                          <Link
                            aria-current={isSelected ? 'true' : undefined}
                            className={`block min-h-11 rounded-[var(--radius-sm)] border p-3 outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ${
                              isSelected
                                ? 'border-border-strong bg-surface-sunken'
                                : 'border-border-subtle hover:bg-surface-sunken'
                            }`}
                            href={selectionHref(selectedBranch?.id ?? '', businessDate, item.id)}
                          >
                            <span className="flex flex-wrap items-start justify-between gap-2">
                              <span className="min-w-0">
                                <span className="block font-medium break-words text-text-strong">
                                  {item.templateName}
                                </span>
                                <span className="mt-1 block font-mono text-xs text-text-muted">
                                  {item.category} · {item.completedSteps}/{item.totalSteps} steps
                                </span>
                              </span>
                              <Status status={item.status} />
                            </span>
                            <span className="mt-2 block text-xs leading-relaxed text-text-muted">
                              Due{' '}
                              {formatBranchDateTime(item.dueAt, selectedBranch?.timezone ?? 'UTC')}
                              {' · '}Window ends{' '}
                              {formatBranchDateTime(
                                item.windowEndsAt,
                                selectedBranch?.timezone ?? 'UTC'
                              )}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-text-muted">{group.empty}</p>
                )}
              </section>
            ))}
          </div>
        </SectionCard>

        <SectionCard className="min-w-0">
          {selected && selectedBranch ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-mono text-xs uppercase tracking-wider text-text-muted">
                    Selected SOP · version {selected.versionNumber}
                  </p>
                  <h2 className="mt-1 text-lg font-semibold break-words text-text-strong">
                    {selected.templateName}
                  </h2>
                  <p className="mt-1 text-sm text-text-muted">{selected.category}</p>
                </div>
                <Status status={selected.status} />
              </div>

              <dl className="mt-5 grid gap-3 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="font-mono text-xs uppercase tracking-wider text-text-muted">
                    Branch
                  </dt>
                  <dd className="mt-1 text-text-strong">{selectedBranch.name}</dd>
                </div>
                <div>
                  <dt className="font-mono text-xs uppercase tracking-wider text-text-muted">
                    Business date
                  </dt>
                  <dd className="mt-1 text-text-strong">
                    {formatBusinessDate(selected.businessDate)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-xs uppercase tracking-wider text-text-muted">
                    Due · {selectedBranch.timezone}
                  </dt>
                  <dd className="mt-1 text-text-strong">
                    {formatBranchDateTime(selected.dueAt, selectedBranch.timezone)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-xs uppercase tracking-wider text-text-muted">
                    Window ends · {selectedBranch.timezone}
                  </dt>
                  <dd className="mt-1 text-text-strong">
                    {formatBranchDateTime(selected.windowEndsAt, selectedBranch.timezone)}
                  </dd>
                </div>
              </dl>

              {startAllowed || selected.claimable || submitAllowed || acknowledgeAllowed ? (
                <section className="mt-6 border-t border-border-subtle pt-5">
                  <h3 className="font-semibold text-text-strong">Operator controls</h3>
                  <form action={action} className="mt-3 space-y-3">
                    <CommandScope
                      branchId={selectedBranch.id}
                      businessDate={businessDate}
                      occurrenceId={selected.id}
                    />
                    <p className="text-xs text-text-muted">
                      Recorded as your signed-in staff profile.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {startAllowed ? (
                        <Button
                          className="min-h-11"
                          disabled={!action}
                          name="intent"
                          type="submit"
                          value="start"
                        >
                          {selected.status === 'REJECTED' ? 'Start rework' : 'Start SOP'}
                        </Button>
                      ) : null}
                      {selected.claimable ? (
                        <Button
                          className="min-h-11"
                          disabled={!action}
                          name="intent"
                          type="submit"
                          value="claim"
                        >
                          Claim SOP
                        </Button>
                      ) : null}
                      {submitAllowed ? (
                        <Button
                          className="min-h-11"
                          disabled={!action}
                          name="intent"
                          type="submit"
                          value="submit"
                        >
                          Submit for review
                        </Button>
                      ) : null}
                      {acknowledgeAllowed ? (
                        <Button
                          className="min-h-11"
                          disabled={!action}
                          name="intent"
                          type="submit"
                          value="acknowledge"
                          variant="secondary"
                        >
                          Acknowledge escalation
                        </Button>
                      ) : null}
                    </div>
                  </form>
                </section>
              ) : null}

              <section className="mt-6 border-t border-border-subtle pt-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-semibold text-text-strong">Checklist</h3>
                  <span className="font-mono text-xs text-text-muted">
                    {selected.steps.filter((step) => step.completed).length}/{selected.steps.length}{' '}
                    complete
                  </span>
                </div>
                <ol className="mt-3 divide-y divide-border-subtle">
                  {selected.steps.map((step) => {
                    // DEV-837: only captured proof counts, exactly as the server gate does.
                    const stepEvidence = selected.evidence.filter(
                      (evidence) =>
                        evidence.occurrenceStepId === step.occurrenceStepId &&
                        evidence.serverCaptured
                    );
                    const hasPhoto = stepEvidence.some((evidence) =>
                      evidence.mimeType.includes('evidence=photo')
                    );
                    const hasSignature = stepEvidence.some(
                      (evidence) =>
                        evidence.mimeType.includes('evidence=signature') ||
                        evidence.mimeType === 'application/vnd.devfathom.signature+json'
                    );
                    const needsPhoto = step.requirements.includes('photo') && !hasPhoto;
                    const needsSignature = step.requirements.includes('signature') && !hasSignature;
                    return (
                      <li className="py-4 first:pt-0 last:pb-0" key={step.templateStepId}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-mono text-xs text-text-muted">Step {step.order}</p>
                            <p className="mt-1 font-medium break-words text-text-strong">
                              {step.title}
                            </p>
                          </div>
                          <StatusPill
                            status={step.completed ? 'COMPLETED' : 'PENDING'}
                            label={step.completed ? 'Complete' : 'Pending'}
                            tone={step.completed ? 'success' : 'neutral'}
                          />
                        </div>
                        {step.instructions ? (
                          <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-text-muted">
                            {step.instructions}
                          </p>
                        ) : null}
                        <p className="mt-2 text-xs text-text-muted">
                          Requirements:{' '}
                          {step.requirements.length
                            ? step.requirements.join(', ')
                            : 'No evidence required'}
                        </p>
                        {step.note ? (
                          <p className="mt-2 rounded-[var(--radius-xs)] bg-surface-sunken p-3 text-sm whitespace-pre-wrap text-text-body">
                            Note: {step.note}
                          </p>
                        ) : null}
                        {step.completed ? (
                          <p className="mt-2 text-xs text-text-muted">
                            Completed by {staffName(staff, step.completedByStaffProfileId)} ·{' '}
                            {formatBranchDateTime(step.completedAt, selectedBranch.timezone)}
                          </p>
                        ) : selected.status === 'IN_PROGRESS' ? (
                          <>
                            {step.occurrenceStepId && (needsPhoto || needsSignature) ? (
                              <div className="mt-3" aria-label={`Required proof for ${step.title}`}>
                                {needsPhoto ? (
                                  <EvidenceCapture
                                    branchId={selectedBranch.id}
                                    businessDate={businessDate}
                                    occurrenceId={selected.id}
                                    occurrenceStepId={step.occurrenceStepId}
                                    purpose="photo"
                                    staff={staff}
                                  />
                                ) : null}
                                {needsSignature ? (
                                  <EvidenceCapture
                                    branchId={selectedBranch.id}
                                    businessDate={businessDate}
                                    occurrenceId={selected.id}
                                    occurrenceStepId={step.occurrenceStepId}
                                    purpose="signature"
                                    staff={staff}
                                  />
                                ) : null}
                              </div>
                            ) : null}
                            <form action={action} className="mt-3 grid gap-3 sm:grid-cols-2">
                              <CommandScope
                                branchId={selectedBranch.id}
                                businessDate={businessDate}
                                intent="completeStep"
                                occurrenceId={selected.id}
                              />
                              <input
                                type="hidden"
                                name="templateStepId"
                                value={step.templateStepId}
                              />
                              <p className="text-xs text-text-muted">
                                Recorded as your signed-in staff profile.
                              </p>
                              <label className="text-sm text-text-body">
                                Completion note
                                <Input
                                  className="mt-1 min-h-11"
                                  maxLength={2000}
                                  name="note"
                                  pattern={
                                    step.requirements.includes('note') ? '.*\\S.*' : undefined
                                  }
                                  required={step.requirements.includes('note')}
                                />
                              </label>
                              <Button
                                className="min-h-11 sm:col-span-2"
                                disabled={!action || needsPhoto || needsSignature}
                                type="submit"
                              >
                                Complete step
                              </Button>
                            </form>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </section>

              {!canVerify || reviewAllowed || waiveAllowed ? (
                <section className="mt-6 border-t border-border-subtle pt-5">
                  <fieldset disabled={!canVerify}>
                    <legend className="font-semibold text-text-strong">Verifier controls</legend>
                    {reviewAllowed ? (
                      <form action={action} className="mt-3 grid gap-3 sm:grid-cols-2">
                        <CommandScope
                          branchId={selectedBranch.id}
                          businessDate={businessDate}
                          occurrenceId={selected.id}
                        />
                        <p className="text-xs text-text-muted">
                          Recorded as your signed-in staff profile.
                        </p>
                        <label className="text-sm text-text-body">
                          Verification reason
                          <Input
                            className="mt-1 min-h-11"
                            maxLength={2000}
                            name="reason"
                            pattern=".*\S.*"
                            required
                          />
                        </label>
                        <div className="flex flex-wrap gap-2 sm:col-span-2">
                          <Button
                            className="min-h-11"
                            disabled={!action}
                            formNoValidate
                            name="intent"
                            type="submit"
                            value="verify"
                          >
                            Verify
                          </Button>
                          <Button
                            className="min-h-11"
                            disabled={!action}
                            name="intent"
                            type="submit"
                            value="reject"
                            variant="destructive"
                          >
                            Reject for rework
                          </Button>
                        </div>
                      </form>
                    ) : null}
                    {waiveAllowed ? (
                      <form
                        action={action}
                        className="mt-5 grid gap-3 border-t border-border-subtle pt-5 sm:grid-cols-2"
                      >
                        <CommandScope
                          branchId={selectedBranch.id}
                          businessDate={businessDate}
                          intent="waive"
                          occurrenceId={selected.id}
                        />
                        <p className="text-xs text-text-muted">
                          Recorded as your signed-in staff profile.
                        </p>
                        <StaffSelect
                          label="Approving co-author"
                          name="approvingStaffProfileId"
                          required
                          staff={staff}
                        />
                        <label className="text-sm text-text-body">
                          Approving credential type
                          <select className={selectClass} name="approvingType" defaultValue="PIN">
                            <option value="PIN">PIN</option>
                            <option value="BADGE">Badge</option>
                          </select>
                        </label>
                        <label className="text-sm text-text-body">
                          Approving manager credential
                          <Input
                            className="mt-1"
                            name="approvingSecret"
                            type="password"
                            autoComplete="off"
                            required
                            maxLength={256}
                          />
                        </label>
                        <p className="text-xs text-text-muted sm:col-span-2">
                          Co-authorization requires a different approving staff member, who confirms
                          with their own PIN or badge. If you are the only active staff member and
                          an owner, you may approve your own waive by re-entering your PIN.
                        </p>
                        <label className="text-sm text-text-body sm:col-span-2">
                          Waiver reason
                          <Textarea
                            className="mt-1 min-h-24"
                            maxLength={2000}
                            name="reason"
                            required
                          />
                        </label>
                        <Button
                          className="min-h-11 sm:col-span-2"
                          disabled={!action}
                          type="submit"
                          variant="destructive"
                        >
                          Waive occurrence
                        </Button>
                      </form>
                    ) : null}
                    {!reviewAllowed && !waiveAllowed ? (
                      <div className="mt-3">
                        <p className="text-xs text-text-muted">
                          Recorded as your signed-in staff profile.
                        </p>
                        <p className="mt-2 text-sm text-text-muted">
                          No verifier action is valid for{' '}
                          {STATUS_LABEL[selected.status].toLowerCase()} occurrences.
                        </p>
                      </div>
                    ) : null}
                  </fieldset>
                  {!canVerify ? (
                    <p className="mt-3 text-sm text-text-muted">
                      The sop:verify permission is required to verify, reject, or waive SOPs.
                    </p>
                  ) : null}
                </section>
              ) : null}

              <section className="mt-6 border-t border-border-subtle pt-5">
                <h3 className="font-semibold text-text-strong">Evidence records</h3>
                {selected.evidence.length ? (
                  <ul className="mt-3 divide-y divide-border-subtle">
                    {selected.evidence.map((evidence) => (
                      <li className="py-4 first:pt-0 last:pb-0" key={evidence.id}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="min-w-0 font-medium break-words text-text-strong">
                            {evidence.occurrenceStepId
                              ? (occurrenceStepNames.get(evidence.occurrenceStepId) ??
                                evidence.occurrenceStepId)
                              : 'Whole occurrence'}
                          </p>
                          <StatusPill
                            status={evidence.serverCaptured ? 'CAPTURED' : 'UNVERIFIED'}
                            label={
                              evidence.serverCaptured ? 'Captured proof' : 'Unverified metadata'
                            }
                            tone={evidence.serverCaptured ? 'success' : 'warning'}
                          />
                        </div>
                        {evidence.serverCaptured ? null : (
                          <p className="mt-2 text-xs text-text-muted">
                            Recorded from details the submitter supplied. No captured file backs it,
                            so it does not count as photo or signature proof.
                          </p>
                        )}
                        <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                          <div>
                            <dt className="text-text-muted">Content hash</dt>
                            <dd className="mt-1 font-mono break-all text-text-body">
                              {evidence.contentHash}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-text-muted">File metadata</dt>
                            <dd className="mt-1 text-text-body">
                              {evidence.mimeType} · {formatBytes(evidence.sizeBytes)}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-text-muted">Storage reference</dt>
                            <dd className="mt-1 break-all text-text-body">
                              {evidence.storageRef ?? 'Not supplied'}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-text-muted">Captured</dt>
                            <dd className="mt-1 text-text-body">
                              {staffName(staff, evidence.uploaderStaffProfileId)} ·{' '}
                              {formatBranchDateTime(evidence.capturedAt, selectedBranch.timezone)}
                            </dd>
                          </div>
                        </dl>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-text-muted">
                    No evidence metadata is attached to this occurrence.
                  </p>
                )}
              </section>

              <section className="mt-6 border-t border-border-subtle pt-5">
                <h3 className="font-semibold text-text-strong">Verification history</h3>
                {selected.verifications.length ? (
                  <ul className="mt-3 divide-y divide-border-subtle">
                    {selected.verifications.map((verification) => (
                      <li className="py-3 first:pt-0 last:pb-0" key={verification.id}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <StatusPill status={verification.action} />
                          <time className="font-mono text-xs text-text-muted">
                            {formatBranchDateTime(verification.createdAt, selectedBranch.timezone)}
                          </time>
                        </div>
                        <p className="mt-2 text-sm text-text-body">
                          Actor: {staffName(staff, verification.actorStaffProfileId)}
                        </p>
                        <p className="mt-1 font-mono text-xs break-all text-text-muted">
                          Co-auth: {verification.coAuthorizationId ?? 'Not required'}
                        </p>
                        {verification.reason ? (
                          <p className="mt-2 text-sm whitespace-pre-wrap text-text-muted">
                            {verification.reason}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-text-muted">No verification events recorded.</p>
                )}
              </section>

              <section className="mt-6 border-t border-border-subtle pt-5">
                <h3 className="font-semibold text-text-strong">Escalation events</h3>
                {selected.escalationEvents.length ? (
                  <ul className="mt-3 divide-y divide-border-subtle">
                    {selected.escalationEvents.map((event) => (
                      <li className="py-3 first:pt-0 last:pb-0" key={event.id}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <StatusPill status={event.kind} />
                          <time className="font-mono text-xs text-text-muted">
                            {formatBranchDateTime(event.createdAt, selectedBranch.timezone)}
                          </time>
                        </div>
                        <p className="mt-2 text-sm text-text-body">
                          Actor: {staffName(staff, event.actorStaffProfileId)}
                        </p>
                        {event.detail ? (
                          <p className="mt-1 text-sm whitespace-pre-wrap text-text-muted">
                            {event.detail}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-text-muted">No escalation events recorded.</p>
                )}
              </section>
            </>
          ) : (
            <div className="py-12 text-center">
              <h2 className="text-lg font-semibold text-text-strong">No SOP selected</h2>
              <p className="mt-2 text-sm text-text-muted">
                {selectedBranch
                  ? 'No occurrences match this branch business date.'
                  : 'Create or activate a restaurant branch before using the SOP board.'}
              </p>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

export default async function SopPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const ctx = await tenantContext();
  // Tenancy did not resolve. Entitlements are unknowable here, so show the
  // permission surface rather than let a missing workspace reach the user as an
  // unhandled Server Component crash.
  if (!ctx) return <SopBoardView state="permission" />;

  const moduleEnabled = hasModule(ctx.entitlements, 'restaurant-sop');
  const user = ctx.session?.user;

  if (!moduleEnabled) return <SopBoardView state="disabled" />;
  if (!user) return <SopBoardView state="permission" />;

  const subject = subjectFromSession(user);
  const [canComplete, canVerify, canConfigure] = await Promise.all([
    can(subject, 'sop:complete', undefined, { db: ctx.db, source: 'TRPC' }),
    can(subject, 'sop:verify', undefined, { db: ctx.db, source: 'TRPC' }),
    can(subject, 'restaurant:configure', undefined, { db: ctx.db, source: 'TRPC' }),
  ]);

  if (!canComplete) return <SopBoardView state="permission" />;

  async function runCommand(form: FormData) {
    'use server';

    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx) throw new Error(NO_ACTOR);
      const caller = restaurantSopExecutionRouter.createCaller(actionCtx);
      const occurrenceId = field(form, 'occurrenceId');
      const intent = field(form, 'intent');
      let success: string;

      switch (intent) {
        case 'claim': {
          const outcome = await caller.claim({ occurrenceId });
          success =
            outcome.status === 'CLAIMED_BY_OTHER'
              ? 'Another eligible staff member claimed this SOP first.'
              : 'SOP claimed. You can now start it.';
          break;
        }
        case 'start':
          await caller.start({ occurrenceId });
          success = 'SOP started.';
          break;
        case 'completeStep':
          await caller.completeStep({
            occurrenceId,
            templateStepId: field(form, 'templateStepId'),
            note: optionalField(form, 'note'),
          });
          success = 'Checklist step completed.';
          break;
        case 'attachEvidence':
          await caller.attachEvidence({
            occurrenceId,
            occurrenceStepId: optionalField(form, 'occurrenceStepId'),
            contentHashHex: field(form, 'contentHashHex'),
            mimeType: field(form, 'mimeType'),
            sizeBytes: Number(field(form, 'sizeBytes')),
            storageRef: optionalField(form, 'storageRef'),
          });
          success = 'Evidence metadata attached.';
          break;
        case 'submit':
          await caller.submit({ occurrenceId });
          success = 'SOP submitted for review.';
          break;
        case 'verify':
          await caller.verify({
            occurrenceId,
            reason: optionalField(form, 'reason'),
          });
          success = 'SOP verified.';
          break;
        case 'reject': {
          const reason = field(form, 'reason');
          if (!reason) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Rejection rationale is required.',
            });
          }
          await caller.reject({
            occurrenceId,
            reason,
          });
          success = 'SOP rejected for rework.';
          break;
        }
        case 'waive': {
          const approvingStaffProfileId = field(form, 'approvingStaffProfileId');
          if (!approvingStaffProfileId) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Select the approving staff member for co-authorization.',
            });
          }
          await caller.waive({
            occurrenceId,
            approvingStaffProfileId,
            approvingType: field(form, 'approvingType') === 'BADGE' ? 'BADGE' : 'PIN',
            approvingSecret: field(form, 'approvingSecret'),
            reason: field(form, 'reason'),
          });
          success = 'SOP waived with co-authorization.';
          break;
        }
        case 'acknowledge':
          await caller.acknowledge({ occurrenceId });
          success = 'Escalation acknowledged.';
          break;
        default:
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown SOP command.' });
      }

      revalidatePath(route);
      next = destination(form, success, 'success');
    } catch (error) {
      next = destination(form, commandError(error, 'SOP command failed.'), 'error');
    }
    redirect(next);
  }

  let boardProps: BoardStateProps;
  try {
    const [branches, staff] = await Promise.all([
      ctx.db.restaurantBranch.findMany({
        where: {
          organizationId: ctx.organization?.id ?? ctx.session!.user.organizationId,
          active: true,
          ...(canConfigure
            ? {}
            : {
                OR: [
                  { staffProfiles: { some: { userId: user.id, status: 'ACTIVE' } } },
                  { assignments: { some: { userId: user.id } } },
                ],
              }),
        },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          timezone: true,
          businessDayCutoff: true,
        },
      }),
      ctx.db.restaurantStaffProfile.findMany({
        where: {
          organizationId: ctx.organization?.id ?? ctx.session!.user.organizationId,
          status: 'ACTIVE',
        },
        orderBy: { displayName: 'asc' },
        select: { id: true, displayName: true },
      }),
    ]);
    const noticeText = queryValue(query.notice);
    const notice = noticeText
      ? {
          kind: queryValue(query.kind) === 'error' ? ('error' as const) : ('success' as const),
          text: noticeText.slice(0, 500),
        }
      : undefined;

    if (!branches.length) {
      boardProps = {
        action: runCommand,
        branches,
        businessDate: '',
        canVerify,
        groups: emptyGroups(),
        notice,
        selected: null,
        selectedBranch: null,
        staff,
        state: 'empty',
      };
    } else {
      const requestedBranchId = queryValue(query.branch);
      const selectedBranch =
        branches.find((branch) => branch.id === requestedBranchId) ?? branches[0];
      const businessDate =
        validBusinessDate(queryValue(query.date)) ??
        resolveBusinessDate(new Date(), selectedBranch.timezone, selectedBranch.businessDayCutoff);
      const caller = restaurantSopExecutionRouter.createCaller(ctx);
      const pages = await Promise.all(
        GROUP_DEFINITIONS.map((group) =>
          caller.listOccurrences({
            branchId: selectedBranch.id,
            businessDate,
            status: group.status,
            limit: 200,
          })
        )
      );
      const groups = GROUP_DEFINITIONS.map<BoardGroup>((group, index) => ({
        ...group,
        items: pages[index].items.map((item) => ({
          id: item.id,
          status: group.status,
          templateName: item.assignment.template.name,
          category: item.assignment.template.category ?? 'Uncategorized',
          dueAt: item.dueAt.toISOString(),
          windowEndsAt: item.windowEndsAt.toISOString(),
          completedSteps: item.steps.filter((step) => step.completed).length,
          totalSteps: item.steps.length,
          claimable: item.canClaim,
        })),
      }));
      const allItems = groups.flatMap((group) => group.items);
      const requestedOccurrenceId = queryValue(query.occurrence);
      let selectedSummary = allItems.find((item) => item.id === requestedOccurrenceId);
      for (const status of DEFAULT_STATUS_PRIORITY) {
        selectedSummary ??= allItems.find((item) => item.status === status);
      }

      let selected: OccurrenceDetail | null = null;
      if (selectedSummary) {
        const detail = await caller.getOccurrence({ id: selectedSummary.id });
        const completedSteps = new Map(detail.steps.map((step) => [step.templateStepId, step]));
        selected = {
          id: detail.id,
          status: selectedSummary.status,
          businessDate: detail.businessDate.toISOString().slice(0, 10),
          dueAt: detail.dueAt.toISOString(),
          windowEndsAt: detail.windowEndsAt.toISOString(),
          templateName: detail.assignment.template.name,
          category: detail.assignment.template.category ?? 'Uncategorized',
          versionNumber: detail.templateVersion.versionNumber,
          steps: detail.templateVersion.steps.map((templateStep) => {
            const occurrenceStep = completedSteps.get(templateStep.id);
            return {
              templateStepId: templateStep.id,
              occurrenceStepId: occurrenceStep?.id ?? null,
              order: templateStep.stepOrder,
              title: templateStep.title,
              instructions: templateStep.instructions,
              requirements: [
                templateStep.requiresPhoto ? 'photo' : null,
                templateStep.requiresSignature ? 'signature' : null,
                templateStep.requiresNote ? 'note' : null,
              ].filter((requirement): requirement is string => requirement !== null),
              completed: occurrenceStep?.completed ?? false,
              completedAt: occurrenceStep?.completedAt?.toISOString() ?? null,
              completedByStaffProfileId: occurrenceStep?.completedByStaffProfileId ?? null,
              note: occurrenceStep?.note ?? null,
            };
          }),
          evidence: detail.evidence.map((evidence) => ({
            id: evidence.id,
            occurrenceStepId: evidence.occurrenceStepId,
            contentHash: evidence.contentHash,
            mimeType: evidence.mimeType,
            sizeBytes: evidence.sizeBytes,
            storageRef: evidence.storageRef,
            uploaderStaffProfileId: evidence.uploaderStaffProfileId,
            capturedAt: evidence.capturedAt.toISOString(),
            serverCaptured: evidence.serverCaptured,
          })),
          verifications: detail.verifications.map((verification) => ({
            id: verification.id,
            action: verification.action,
            actorStaffProfileId: verification.actorStaffProfileId,
            coAuthorizationId: verification.coAuthorizationId,
            reason: verification.reason,
            createdAt: verification.createdAt.toISOString(),
          })),
          escalationEvents: detail.escalationEvents.map((event) => ({
            id: event.id,
            kind: event.kind,
            detail: event.detail,
            actorStaffProfileId: event.actorStaffProfileId,
            createdAt: event.createdAt.toISOString(),
          })),
          claimable: selectedSummary.claimable,
        };
      }

      boardProps = {
        action: runCommand,
        branches,
        businessDate,
        canVerify,
        groups,
        notice,
        selected,
        selectedBranch,
        staff,
        state: allItems.length ? 'ready' : 'empty',
      };
    }
  } catch {
    return <SopBoardView state="error" />;
  }
  return <SopBoardView {...boardProps} />;
}
