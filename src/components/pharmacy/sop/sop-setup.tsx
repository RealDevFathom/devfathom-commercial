'use client';

import { useId, useMemo, useRef, useState } from 'react';

import { Field, fieldClass, WorkspaceState } from '@/components/pharmacy/dispensing/field';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Switch } from '@/components/ui/switch';
import { PHARMACY_SOP_SCHEDULE_LIMITS } from '@/lib/pharmacy/sop-shared';
import { ianaTimezoneOptions } from '@/lib/platform/timezones';
import { isIanaTimezone, workspaceTimezone, workspaceToday } from '@/lib/timezone';
import { trpc } from '@/lib/trpc';

import {
  errorMessage,
  isValidationError,
  RECORD_LABEL,
  recurrenceLabel,
  ROLE_KEYS,
  ROLE_LABEL,
  timeToMinutes,
  TRIGGER_COPY,
  type SopAssignment,
  type SopBranch,
  type SopFrequency,
  type SopRoleHolder,
  type SopRoleKey,
  type SopTemplate,
  validationFields,
} from './sop-model';

type Notify = (notice: { tone: 'success' | 'danger'; text: string }) => void;

export type SopSetupViewProps = {
  branch: SopBranch;
  /** The organization's own timezone, when it has chosen one; prefills Turn on. */
  defaultTimezone?: string | null;
  onChanged: () => void;
  onNotice: Notify;
};

/**
 * Manager setup for one branch. Every change here is explicit: turning on
 * procedures creates no schedules, adding the library creates no schedules,
 * and a schedule exists only after a manager confirms it below.
 */
export function SopSetupView({ branch, defaultTimezone, onChanged, onNotice }: SopSetupViewProps) {
  if (!branch.sopBranchId) {
    return (
      <div className="grid min-w-0 gap-6">
        <SetupIntro />
        <EnableSite
          branch={branch}
          defaultTimezone={defaultTimezone}
          onChanged={onChanged}
          onNotice={onNotice}
        />
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-6">
      <SetupIntro />
      <SectionCard title="Branch">
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill status="active" tone="success" label="Procedures on" />
          <p className="text-sm text-text-body">
            {branch.name} · times shown in {branch.timezone ?? 'UTC'}
          </p>
        </div>
      </SectionCard>
      <RoleHoldings pharmacyBranchId={branch.pharmacyBranchId} />
      <Library branch={branch} onNotice={onNotice} />
      <Schedules
        pharmacyBranchId={branch.pharmacyBranchId}
        timezone={branch.timezone}
        onNotice={onNotice}
      />
    </div>
  );
}

/** What procedures are, said once at the top of Setup. */
export const SETUP_INTRO =
  "Procedures are instructions and proof for the people they're assigned to. They never block opening, closing or any other pharmacy work.";

function SetupIntro() {
  return <p className="max-w-2xl text-sm text-text-body">{SETUP_INTRO}</p>;
}

function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The zone "Turn on" starts from: the branch's own, else the organization's,
 * else this browser's. Never a guessed fixed zone.
 */
export function initialSiteTimezone(branchZone: string | null, organizationZone?: string | null) {
  if (branchZone) return branchZone;
  if (organizationZone && isIanaTimezone(organizationZone)) return organizationZone;
  return browserZone();
}

function EnableSite({ branch, defaultTimezone, onChanged, onNotice }: SopSetupViewProps) {
  const utils = trpc.useUtils();
  const zones = useMemo(() => {
    try {
      return ianaTimezoneOptions().map((option) => option.value);
    } catch {
      return ['UTC'];
    }
  }, []);
  const [timezone, setTimezone] = useState(() =>
    initialSiteTimezone(branch.timezone, defaultTimezone)
  );
  const [cutoff, setCutoff] = useState('');
  const [error, setError] = useState<string | null>(null);
  const enable = trpc.pharmacySop.enableSite.useMutation({
    onSuccess: () => {
      setError(null);
      onNotice({ tone: 'success', text: `Procedures are now on at ${branch.name}.` });
      // Turning on also set up this manager's own procedures profile.
      void utils.pharmacySop.board.invalidate({ pharmacyBranchId: branch.pharmacyBranchId });
      onChanged();
    },
    onError: (cause) => setError(errorMessage(cause, 'Procedures could not be turned on. Retry.')),
  });

  return (
    <SectionCard title={`Turn on procedures at ${branch.name}`}>
      <p className="-mt-2 mb-4 max-w-2xl text-sm text-text-muted">
        This prepares the branch for procedures. It does not schedule anything — you choose what
        runs and when in the next steps.
      </p>
      <form
        className="grid max-w-2xl items-start gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (cutoff && timeToMinutes(cutoff) === null) {
            setError('Enter the day start as a time, for example 04:00.');
            return;
          }
          enable.mutate({
            pharmacyBranchId: branch.pharmacyBranchId,
            timezone,
            ...(cutoff ? { businessDayCutoff: cutoff } : {}),
          });
        }}
      >
        <Field label="Branch timezone" hint="Due times and reports use this timezone.">
          <select
            className={fieldClass}
            value={timezone}
            disabled={enable.isPending}
            onChange={(event) => setTimezone(event.target.value)}
          >
            {(zones.includes(timezone) ? zones : [timezone, ...zones]).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Business day starts at · optional"
          hint="Work done after midnight but before this time counts toward the previous day."
        >
          <input
            type="time"
            className={fieldClass}
            value={cutoff}
            disabled={enable.isPending}
            onChange={(event) => setCutoff(event.target.value)}
          />
        </Field>
        {error ? (
          <p className="text-sm text-destructive sm:col-span-2" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="touch" className="w-fit" disabled={enable.isPending}>
          {enable.isPending ? 'Turning on…' : 'Turn on procedures'}
        </Button>
      </form>
    </SectionCard>
  );
}

/** Reviewing roles nobody may grant themselves (the adapter refuses it). */
const SELF_GRANT_BLOCKED = new Set<SopRoleKey>(['pharmacy-manager', 'pharmacy-qualified-person']);

function RoleHoldings({ pharmacyBranchId }: { pharmacyBranchId: string }) {
  const hintId = useId();
  const utils = trpc.useUtils();
  const holdings = trpc.pharmacySop.roleHoldings.useQuery({ pharmacyBranchId }, { retry: false });
  const [error, setError] = useState<string | null>(null);
  const setHolding = trpc.pharmacySop.setRoleHolding.useMutation({
    onSuccess: async () => {
      setError(null);
      // A first grant may also have set up the manager's own profile, and
      // roles decide the pool and the review queue.
      await Promise.all([
        utils.pharmacySop.roleHoldings.invalidate({ pharmacyBranchId }),
        utils.pharmacySop.board.invalidate({ pharmacyBranchId }),
      ]);
    },
    onError: (cause) => setError(errorMessage(cause, 'That role could not be changed. Retry.')),
  });

  return (
    <SectionCard title="People and roles">
      <p className="-mt-2 mb-4 max-w-2xl text-sm text-text-muted">
        Roles decide who sees work in the role pool and who can review. Only people assigned to this
        branch are listed. A person never reviews their own work.
      </p>
      {holdings.isLoading ? (
        <p className="text-sm text-text-muted" role="status">
          Loading people…
        </p>
      ) : holdings.error ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-destructive">
            {errorMessage(holdings.error, 'People could not be loaded.')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => void holdings.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : !holdings.data?.length ? (
        <p className="text-sm text-text-muted">
          No one is assigned to this branch yet. Add people in Branch assignments first.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {holdings.data.map((person: SopRoleHolder) => {
            const ambiguous = person.staffProfile === 'AMBIGUOUS';
            const selfHintId = `${hintId}-${person.userId}`;
            return (
              <li key={person.userId} className="py-3 first:pt-0 last:pb-0">
                <fieldset
                  disabled={ambiguous}
                  className="grid gap-2 sm:grid-cols-[minmax(10rem,1fr)_auto] sm:items-center"
                >
                  <legend className="sr-only">Roles for {person.displayName}</legend>
                  <span aria-hidden className="min-w-0">
                    <span className="block font-medium break-words text-text-strong">
                      {person.displayName}
                      {person.isViewer ? (
                        <span className="font-normal text-text-muted"> (you)</span>
                      ) : null}
                    </span>
                    {person.isViewer && !ambiguous ? (
                      <span id={selfHintId} className="mt-1 block text-xs text-text-muted">
                        You cannot give yourself the manager or qualified-person role, because those
                        roles review work. Ask another manager.
                      </span>
                    ) : null}
                    {ambiguous ? (
                      <span className="mt-1 block text-xs text-warning">
                        This account is linked to more than one staff profile. Ask an administrator
                        to fix it before giving roles.
                      </span>
                    ) : null}
                  </span>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {ROLE_KEYS.map((roleKey) => {
                      const held = person.roleKeys.includes(roleKey);
                      // The server refuses a self-grant of a reviewing role;
                      // removing one you hold stays allowed.
                      const selfGrantBlocked =
                        person.isViewer && !held && SELF_GRANT_BLOCKED.has(roleKey);
                      return (
                        <label
                          key={roleKey}
                          className="inline-flex min-h-11 items-center gap-2 text-sm text-text-body"
                        >
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={held}
                            disabled={setHolding.isPending || selfGrantBlocked}
                            aria-describedby={selfGrantBlocked ? selfHintId : undefined}
                            aria-label={`${ROLE_LABEL[roleKey]} for ${person.displayName}`}
                            onChange={(event) =>
                              setHolding.mutate({
                                pharmacyBranchId,
                                userId: person.userId,
                                roleKey,
                                held: event.target.checked,
                              })
                            }
                          />
                          {ROLE_LABEL[roleKey]}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {setHolding.isSuccess ? 'Role saved.' : ''}
      </span>
    </SectionCard>
  );
}

function Library({ branch, onNotice }: { branch: SopBranch; onNotice: Notify }) {
  const utils = trpc.useUtils();
  const templates = trpc.pharmacySop.templates.useQuery(undefined, { retry: false });
  const [error, setError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const install = trpc.pharmacySop.installLibrary.useMutation({
    onSuccess: async () => {
      setError(null);
      onNotice({
        tone: 'success',
        text: 'The pharmacy procedure library is ready. Nothing has been scheduled yet.',
      });
      await utils.pharmacySop.templates.invalidate();
    },
    onError: (cause) => setError(errorMessage(cause, 'The library could not be added. Retry.')),
  });
  const list: SopTemplate[] = templates.data ?? [];

  return (
    <SectionCard
      title="Procedure library"
      actions={
        <Button
          type="button"
          variant="outline"
          size="touch"
          disabled={install.isPending}
          onClick={() => install.mutate()}
        >
          {install.isPending ? 'Adding…' : list.length ? 'Update library' : 'Add library'}
        </Button>
      }
    >
      <p className="-mt-2 mb-4 max-w-2xl text-sm text-text-muted">
        Ready-made pharmacy procedures. Adding or updating the library never schedules anything —
        create a schedule for each procedure you want to run.
      </p>
      {error ? (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {templates.isLoading ? (
        <p className="text-sm text-text-muted" role="status">
          Loading procedures…
        </p>
      ) : templates.error ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-destructive">
            {errorMessage(templates.error, 'Procedures could not be loaded.')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => void templates.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-text-muted">No procedures yet. Add the library to begin.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {list.map((template) => {
            const trigger = TRIGGER_COPY[template.pack.trigger];
            const records = [
              ...new Set(
                template.steps.flatMap((step) =>
                  step.requiredRecordType ? [RECORD_LABEL[step.requiredRecordType]] : []
                )
              ),
            ];
            const onDemand = template.pack.trigger === 'EVENT';
            const schedulable =
              !onDemand && template.isActive && Boolean(template.publishedVersion);
            return (
              <li key={template.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium break-words text-text-strong">{template.name}</p>
                    <p className="mt-1 text-xs text-text-muted">
                      {template.steps.length} steps · done by {ROLE_LABEL[template.pack.roleKey]} ·
                      reviewed by{' '}
                      {template.pack.verifierRoleKeys.map((key) => ROLE_LABEL[key]).join(' or ')}
                      {records.length ? ` · links ${records.join(', ')}` : ''}
                    </p>
                    <p className="mt-1 text-xs text-text-muted">
                      {trigger.detail}
                      {onDemand
                        ? ''
                        : ` Suggested: ${recurrenceLabel(template.pack.suggestedRecurrence)}.`}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill
                      status={template.pack.trigger}
                      tone="neutral"
                      label={trigger.label}
                    />
                    {!template.isActive ? (
                      <StatusPill status="archived" tone="neutral" label="Archived" />
                    ) : null}
                    {!schedulable ? null : (
                      <Button
                        type="button"
                        variant="outline"
                        size="touch"
                        aria-expanded={scheduling === template.id}
                        aria-label={`Create schedule for ${template.name}`}
                        onClick={() =>
                          setScheduling((current) => (current === template.id ? null : template.id))
                        }
                      >
                        {scheduling === template.id ? 'Close' : 'Create schedule'}
                      </Button>
                    )}
                  </div>
                </div>
                {onDemand ? (
                  <p className="mt-2 text-xs text-text-muted">
                    No schedule needed. Staff start it from Today&apos;s work when it happens.
                  </p>
                ) : null}
                {scheduling === template.id ? (
                  <ScheduleForm
                    template={template}
                    branch={branch}
                    onDone={() => {
                      setScheduling(null);
                      onNotice({ tone: 'success', text: `Schedule created for ${template.name}.` });
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

const FREQUENCIES: { value: SopFrequency; label: string }[] = [
  { value: 'DAILY', label: 'Every day' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'INTERVAL', label: 'Repeats during the day' },
  { value: 'ONCE', label: 'Once' },
];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One input class for every schedule field, so time, date and text inputs share a height. */
const INPUT = `${fieldClass} h-11 aria-invalid:border-destructive`;

type ScheduleFieldKey =
  | 'userId'
  | 'interval'
  | 'daysOfWeek'
  | 'monthDay'
  | 'dueTime'
  | 'endTime'
  | 'windowMinutes'
  | 'graceMinutes'
  | 'startDate'
  | 'endDate';
type ScheduleErrors = Partial<Record<ScheduleFieldKey, string>>;

const FIELD_ORDER: ScheduleFieldKey[] = [
  'userId',
  'interval',
  'daysOfWeek',
  'monthDay',
  'dueTime',
  'endTime',
  'windowMinutes',
  'graceMinutes',
  'startDate',
  'endDate',
];

const MAX_WINDOW = PHARMACY_SOP_SCHEDULE_LIMITS.windowMinutes;
const MAX_GRACE = PHARMACY_SOP_SCHEDULE_LIMITS.graceMinutes;

/**
 * Plain wording per field for a refusal the server reports as an input
 * validation error. The server's own validation text is never shown.
 */
const PLAIN_FIELD_ERROR: Record<ScheduleFieldKey, string> = {
  userId: 'Choose someone assigned to this branch.',
  interval: 'Enter how often it repeats as a whole number.',
  daysOfWeek: 'Choose at least one day of the week.',
  monthDay: 'Choose a day of the month from 1 to 31.',
  dueTime: 'Choose the time it is due.',
  endTime: 'Choose a last time later than the first one.',
  windowMinutes: `Enter whole minutes from 0 to ${MAX_WINDOW} (one day).`,
  graceMinutes: `Enter whole minutes from 0 to ${MAX_GRACE} (one day).`,
  startDate: 'Choose a start date.',
  endDate: 'The end date must be on or after the start date.',
};

const MISSING_FIRST_TIME = 'Choose the time the first one is due.';
const MISSING_LAST_TIME = 'Choose the time the last one is due.';

/** Server input paths → the form field that owns them. */
const SERVER_FIELD: Record<string, ScheduleFieldKey> = {
  target: 'userId',
  interval: 'interval',
  daysOfWeek: 'daysOfWeek',
  monthDay: 'monthDay',
  dueTimeMinutes: 'dueTime',
  intervalEndTimeMinutes: 'endTime',
  windowMinutes: 'windowMinutes',
  graceMinutes: 'graceMinutes',
  startDate: 'startDate',
  endDate: 'endDate',
};

/** Field errors for a refused createAssignment, or null when it was not a validation refusal. */
export function scheduleErrorsFromServer(error: unknown): ScheduleErrors | null {
  if (!isValidationError(error)) return null;
  const errors: ScheduleErrors = {};
  for (const [path, messages] of Object.entries(validationFields(error))) {
    const key = SERVER_FIELD[path];
    if (key && messages?.length) errors[key] = PLAIN_FIELD_ERROR[key];
  }
  return errors;
}

/** A whole number of minutes in [0, max], or null. */
function wholeMinutes(value: string, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return minutes <= max ? minutes : null;
}

function ScheduleField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: (control: {
    id: string;
    'aria-invalid'?: true;
    'aria-describedby'?: string;
  }) => React.ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    // content-start keeps label, control and hint packed at the top of the
    // grid cell, so a hint on one field never pushes its neighbour's control.
    <div className="grid min-w-0 content-start gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text-strong">
        {label}
      </label>
      {children({
        id,
        ...(error ? { 'aria-invalid': true as const } : {}),
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      })}
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function ScheduleForm({
  template,
  branch,
  onDone,
}: {
  template: SopTemplate;
  branch: SopBranch;
  onDone: () => void;
}) {
  const id = useId();
  const fieldId = (key: ScheduleFieldKey) => `${id}-${key}`;
  const utils = trpc.useUtils();
  const suggestion = template.pack.suggestedRecurrence;
  const people = trpc.pharmacySop.roleHoldings.useQuery(
    { pharmacyBranchId: branch.pharmacyBranchId },
    { retry: false }
  );
  const [targetType, setTargetType] = useState<'ROLE' | 'PERSON'>(template.pack.assigneeTarget);
  const [roleKey, setRoleKey] = useState<SopRoleKey>(template.pack.roleKey);
  const [userId, setUserId] = useState('');
  const [frequency, setFrequency] = useState<SopFrequency>(suggestion.frequency);
  const [interval, setRepeat] = useState(String(suggestion.interval));
  const [days, setDays] = useState<number[]>(suggestion.daysOfWeek);
  const [monthDay, setMonthDay] = useState(String(suggestion.monthDay ?? 1));
  // Times always start empty: there is no assumed opening, closing or other
  // time of day. The manager chooses when the procedure is due at this branch.
  const [dueTime, setDueTime] = useState('');
  const [endTime, setEndTime] = useState('');
  // The suggested window and grace are clamped into the bounds the server
  // accepts, so they always save as offered once the times are chosen.
  const [windowMinutes, setWindowMinutes] = useState(
    String(Math.min(suggestion.windowMinutes, MAX_WINDOW))
  );
  const [graceMinutes, setGraceMinutes] = useState(
    String(Math.min(suggestion.graceMinutes, MAX_GRACE))
  );
  const [startDate, setStartDate] = useState(workspaceToday(branch.timezone));
  const [endDate, setEndDate] = useState('');
  const [fieldErrors, setFieldErrors] = useState<ScheduleErrors>({});
  const [error, setError] = useState<string | null>(null);

  function showErrors(errors: ScheduleErrors, summary: string) {
    setFieldErrors(errors);
    setError(summary);
    const first = FIELD_ORDER.find((key) => errors[key]);
    if (first) {
      // Days are a group of checkboxes; focus the first one.
      const element = document.getElementById(fieldId(first));
      const target = first === 'daysOfWeek' ? element?.querySelector('input') : element;
      target?.focus();
    }
  }

  const create = trpc.pharmacySop.createAssignment.useMutation({
    onSuccess: async () => {
      setError(null);
      setFieldErrors({});
      await utils.pharmacySop.assignments.invalidate({ pharmacyBranchId: branch.pharmacyBranchId });
      onDone();
    },
    onError: (cause) => {
      const errors = scheduleErrorsFromServer(cause);
      if (errors) {
        showErrors(
          errors,
          Object.keys(errors).length
            ? 'Some values were not accepted. Check the highlighted fields.'
            : 'The schedule could not be created. Check the values and retry.'
        );
        return;
      }
      setFieldErrors({});
      setError(errorMessage(cause, 'The schedule could not be created. Retry.'));
    },
  });

  function validate(): ScheduleErrors {
    const errors: ScheduleErrors = {};
    const due = timeToMinutes(dueTime);
    if (due === null) {
      errors.dueTime = frequency === 'INTERVAL' ? MISSING_FIRST_TIME : PLAIN_FIELD_ERROR.dueTime;
    }
    if (targetType === 'PERSON' && !userId) errors.userId = 'Choose the person who will do it.';
    if (frequency !== 'ONCE') {
      const every = /^\d+$/.test(interval.trim()) ? Number(interval.trim()) : NaN;
      if (!Number.isInteger(every) || every < 1 || every > 1440) {
        errors.interval =
          frequency === 'INTERVAL'
            ? 'Enter the minutes between each, from 15 to 1440.'
            : 'Enter how often it repeats as a whole number from 1.';
      } else if (frequency === 'INTERVAL' && every < 15) {
        errors.interval = 'Repeat at least 15 minutes apart.';
      }
    }
    if ((frequency === 'WEEKLY' || frequency === 'INTERVAL') && days.length === 0) {
      errors.daysOfWeek = PLAIN_FIELD_ERROR.daysOfWeek;
    }
    if (frequency === 'INTERVAL') {
      const end = timeToMinutes(endTime);
      if (end === null) errors.endTime = MISSING_LAST_TIME;
      else if (due !== null && end <= due) errors.endTime = PLAIN_FIELD_ERROR.endTime;
    }
    if (frequency === 'MONTHLY') {
      const day = Number(monthDay);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        errors.monthDay = PLAIN_FIELD_ERROR.monthDay;
      }
    }
    if (wholeMinutes(windowMinutes, MAX_WINDOW) === null) {
      errors.windowMinutes = PLAIN_FIELD_ERROR.windowMinutes;
    }
    if (wholeMinutes(graceMinutes, MAX_GRACE) === null) {
      errors.graceMinutes = PLAIN_FIELD_ERROR.graceMinutes;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) errors.startDate = PLAIN_FIELD_ERROR.startDate;
    if (endDate && endDate < startDate) errors.endDate = PLAIN_FIELD_ERROR.endDate;
    return errors;
  }

  return (
    <form
      aria-label={`Schedule for ${template.name}`}
      noValidate
      className="mt-4 grid items-start gap-4 rounded-md border border-border-subtle bg-surface-sunken p-4 md:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const errors = validate();
        if (Object.keys(errors).length) {
          showErrors(errors, 'Check the highlighted fields.');
          return;
        }
        setFieldErrors({});
        setError(null);
        create.mutate({
          pharmacyBranchId: branch.pharmacyBranchId,
          templateId: template.id,
          target: targetType === 'ROLE' ? { type: 'ROLE', roleKey } : { type: 'PERSON', userId },
          frequency,
          interval: frequency === 'ONCE' ? 1 : Number(interval),
          daysOfWeek: frequency === 'WEEKLY' || frequency === 'INTERVAL' ? days : [],
          monthDay: frequency === 'MONTHLY' ? Number(monthDay) : null,
          // Validated above; never defaulted to a time the manager did not choose.
          dueTimeMinutes: timeToMinutes(dueTime),
          intervalEndTimeMinutes: frequency === 'INTERVAL' ? timeToMinutes(endTime) : null,
          windowMinutes: wholeMinutes(windowMinutes, MAX_WINDOW) ?? 0,
          graceMinutes: wholeMinutes(graceMinutes, MAX_GRACE) ?? 0,
          startDate,
          endDate: endDate || null,
        });
      }}
    >
      <fieldset className="grid gap-2 md:col-span-2">
        <legend className="text-sm font-medium text-text-strong">Who does it</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {(['ROLE', 'PERSON'] as const).map((value) => (
            <label
              key={value}
              className="inline-flex min-h-11 items-center gap-2 text-sm text-text-body"
            >
              <input
                type="radio"
                name={`${id}-target`}
                className="size-4 accent-primary"
                checked={targetType === value}
                onChange={() => setTargetType(value)}
              />
              {value === 'ROLE' ? 'Anyone holding a role' : 'One named person'}
            </label>
          ))}
        </div>
      </fieldset>
      {targetType === 'ROLE' ? (
        <ScheduleField id={`${id}-role`} label="Role">
          {(control) => (
            <select
              {...control}
              className={INPUT}
              value={roleKey}
              onChange={(event) => setRoleKey(event.target.value as SopRoleKey)}
            >
              {ROLE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {ROLE_LABEL[key]}
                </option>
              ))}
            </select>
          )}
        </ScheduleField>
      ) : (
        <ScheduleField
          id={fieldId('userId')}
          label="Person"
          hint="Only people assigned to this branch are listed."
          error={fieldErrors.userId}
        >
          {(control) => (
            <select
              {...control}
              className={INPUT}
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            >
              <option value="">Select…</option>
              {(people.data ?? [])
                .filter((person: SopRoleHolder) => person.staffProfile !== 'AMBIGUOUS')
                .map((person: SopRoleHolder) => (
                  <option key={person.userId} value={person.userId}>
                    {person.displayName}
                  </option>
                ))}
            </select>
          )}
        </ScheduleField>
      )}
      <ScheduleField id={`${id}-frequency`} label="How often">
        {(control) => (
          <select
            {...control}
            className={INPUT}
            value={frequency}
            onChange={(event) => setFrequency(event.target.value as SopFrequency)}
          >
            {FREQUENCIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </ScheduleField>
      {frequency !== 'ONCE' ? (
        <ScheduleField
          id={fieldId('interval')}
          label={frequency === 'INTERVAL' ? 'Minutes between each' : 'Repeat every'}
          hint={
            frequency === 'INTERVAL'
              ? 'At least 15 minutes.'
              : frequency === 'DAILY'
                ? 'Days. 1 means every day.'
                : frequency === 'WEEKLY'
                  ? 'Weeks. 1 means every week.'
                  : 'Months. 1 means every month.'
          }
          error={fieldErrors.interval}
        >
          {(control) => (
            <input
              {...control}
              className={INPUT}
              inputMode="numeric"
              value={interval}
              onChange={(event) => setRepeat(event.target.value)}
            />
          )}
        </ScheduleField>
      ) : null}
      {frequency === 'WEEKLY' || frequency === 'INTERVAL' ? (
        <fieldset
          id={fieldId('daysOfWeek')}
          className="grid gap-2 md:col-span-2"
          aria-describedby={fieldErrors.daysOfWeek ? `${fieldId('daysOfWeek')}-error` : undefined}
        >
          <legend className="text-sm font-medium text-text-strong">Days of the week</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {WEEKDAY_NAMES.map((name, day) => (
              <label
                key={name}
                className="inline-flex min-h-11 items-center gap-2 text-sm text-text-body"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={days.includes(day)}
                  aria-invalid={fieldErrors.daysOfWeek ? true : undefined}
                  onChange={(event) =>
                    setDays((current) =>
                      event.target.checked
                        ? [...current, day].sort((left, right) => left - right)
                        : current.filter((value) => value !== day)
                    )
                  }
                />
                {name}
              </label>
            ))}
          </div>
          {fieldErrors.daysOfWeek ? (
            <p id={`${fieldId('daysOfWeek')}-error`} className="text-xs text-destructive">
              {fieldErrors.daysOfWeek}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {frequency === 'MONTHLY' ? (
        <ScheduleField
          id={fieldId('monthDay')}
          label="Day of the month"
          error={fieldErrors.monthDay}
        >
          {(control) => (
            <input
              {...control}
              className={INPUT}
              inputMode="numeric"
              value={monthDay}
              onChange={(event) => setMonthDay(event.target.value)}
            />
          )}
        </ScheduleField>
      ) : null}
      <ScheduleField
        id={fieldId('dueTime')}
        label={frequency === 'INTERVAL' ? 'First one at' : 'Due at'}
        hint="Required. Choose the time that suits this branch."
        error={fieldErrors.dueTime}
      >
        {(control) => (
          <input
            {...control}
            type="time"
            required
            className={INPUT}
            value={dueTime}
            onChange={(event) => setDueTime(event.target.value)}
          />
        )}
      </ScheduleField>
      {frequency === 'INTERVAL' ? (
        <ScheduleField
          id={fieldId('endTime')}
          label="Last one by"
          hint="Required."
          error={fieldErrors.endTime}
        >
          {(control) => (
            <input
              {...control}
              type="time"
              required
              className={INPUT}
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
          )}
        </ScheduleField>
      ) : null}
      <ScheduleField
        id={fieldId('windowMinutes')}
        label="Time allowed (minutes)"
        hint={`How long after the due time it counts as on time. Up to ${MAX_WINDOW} (one day).`}
        error={fieldErrors.windowMinutes}
      >
        {(control) => (
          <input
            {...control}
            className={INPUT}
            inputMode="numeric"
            value={windowMinutes}
            onChange={(event) => setWindowMinutes(event.target.value)}
          />
        )}
      </ScheduleField>
      <ScheduleField
        id={fieldId('graceMinutes')}
        label="Extra time before it is missed (minutes)"
        hint={`After the time allowed it can still be handed in, as late, for this long. Up to ${MAX_GRACE}.`}
        error={fieldErrors.graceMinutes}
      >
        {(control) => (
          <input
            {...control}
            className={INPUT}
            inputMode="numeric"
            value={graceMinutes}
            onChange={(event) => setGraceMinutes(event.target.value)}
          />
        )}
      </ScheduleField>
      <ScheduleField id={fieldId('startDate')} label="Starts on" error={fieldErrors.startDate}>
        {(control) => (
          <input
            {...control}
            type="date"
            className={INPUT}
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        )}
      </ScheduleField>
      <ScheduleField id={fieldId('endDate')} label="Ends on · optional" error={fieldErrors.endDate}>
        {(control) => (
          <input
            {...control}
            type="date"
            className={INPUT}
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        )}
      </ScheduleField>
      {error ? (
        <p className="text-sm text-destructive md:col-span-2" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="touch" className="w-fit" disabled={create.isPending}>
        {create.isPending ? 'Creating…' : 'Create schedule'}
      </Button>
    </form>
  );
}

/**
 * Off-state contrast for the shared Switch, applied locally. The shared
 * unchecked track (`bg-input`) and thumb (`bg-background`) sit at about 1.35:1
 * and 1.08:1 against a white card, below the 3:1 a control boundary needs.
 * Unchecked here: a sunken track with a `text-muted` border and a `text-muted`
 * thumb (light 5.27:1 border on the card, 4.66:1 on sunken, thumb 4.66:1 on the
 * track; dark 6.60:1 / 7.54:1, thumb 7.54:1). Remove once
 * src/components/ui/switch.tsx gives its unchecked state a 3:1 boundary.
 */
export const SWITCH_CONTRAST =
  'data-unchecked:border-text-muted data-unchecked:bg-surface-sunken dark:data-unchecked:bg-surface-sunken [&[data-unchecked]_[data-slot=switch-thumb]]:bg-text-muted dark:[&[data-unchecked]_[data-slot=switch-thumb]]:bg-text-muted';

/** Who a schedule's work goes to, in words. */
function scheduleTarget(row: SopAssignment) {
  return row.target.type === 'ROLE'
    ? row.target.roleKey
      ? ROLE_LABEL[row.target.roleKey]
      : 'a role'
    : (row.target.displayName ?? 'a named person');
}

/** What pausing a schedule does, said once above the list. */
export const PAUSE_COPY =
  'Pausing a schedule stops new work being created from it. Work already created stays and can still be done.';

function Schedules({
  pharmacyBranchId,
  timezone = null,
  onNotice,
}: {
  pharmacyBranchId: string;
  timezone?: string | null;
  onNotice: Notify;
}) {
  const utils = trpc.useUtils();
  const assignments = trpc.pharmacySop.assignments.useQuery({ pharmacyBranchId }, { retry: false });
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  /** The schedule being paused or resumed, named in the notice once it is saved. */
  const toggling = useRef<{ name: string; target: string; active: boolean } | null>(null);
  const setActive = trpc.pharmacySop.setAssignmentActive.useMutation({
    onSuccess: async () => {
      setError(null);
      const done = toggling.current;
      if (done) {
        setChanged(
          done.active
            ? `Resumed ${done.name} for ${done.target}. New work will be created from it again.`
            : `Paused ${done.name} for ${done.target}. Work already created stays and can still be done.`
        );
      }
      await utils.pharmacySop.assignments.invalidate({ pharmacyBranchId });
    },
    onError: (cause) => {
      setChanged(null);
      setError(errorMessage(cause, 'The schedule could not be changed. Retry.'));
    },
  });
  const generate = trpc.pharmacySop.generate.useMutation({
    onSuccess: async () => {
      setError(null);
      onNotice({ tone: 'success', text: "Today's work is up to date with your schedules." });
      await utils.pharmacySop.board.invalidate({ pharmacyBranchId });
    },
    onError: (cause) => setError(errorMessage(cause, "Today's work could not be created. Retry.")),
  });
  const list: SopAssignment[] = (assignments.data ?? []).filter((row) => !row.superseded);

  return (
    <SectionCard
      title="Schedules"
      actions={
        list.some((row) => row.active) ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={generate.isPending}
            onClick={() => generate.mutate({ pharmacyBranchId })}
          >
            {generate.isPending ? 'Creating…' : "Create today's work now"}
          </Button>
        ) : null
      }
    >
      <AutoScheduling pharmacyBranchId={pharmacyBranchId} timezone={timezone} />
      {error ? (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {assignments.isLoading ? (
        <p className="text-sm text-text-muted" role="status">
          Loading schedules…
        </p>
      ) : assignments.error ? (
        <WorkspaceState title="Schedules could not be loaded" tone="danger">
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => void assignments.refetch()}
          >
            Retry
          </Button>
        </WorkspaceState>
      ) : list.length === 0 ? (
        <p className="text-sm text-text-muted">
          No schedules yet. Choose Create schedule on a procedure above.
        </p>
      ) : (
        <div className="grid gap-3">
          <p className="text-xs text-text-muted">{PAUSE_COPY}</p>
          <p role="status" className="text-sm text-text-body empty:hidden">
            {changed}
          </p>
          <ul className="divide-y divide-border-subtle">
            {list.map((row) => (
              // One grid for every row, so the toggle sits at the same place on
              // a phone whether or not the details wrap.
              <li
                key={row.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="font-medium break-words text-text-strong">{row.templateName}</p>
                  <p className="mt-1 text-xs text-text-muted">
                    {recurrenceLabel(row)} ·{' '}
                    {row.target.type === 'ROLE'
                      ? row.target.roleKey
                        ? `Anyone holding ${ROLE_LABEL[row.target.roleKey]}`
                        : 'A role'
                      : (row.target.displayName ?? 'A named person')}
                  </p>
                </div>
                {/* Not a <label>: Base UI names a switch after its enclosing
                    label, which would replace the specific name below with
                    just "Active" or "Paused". */}
                <div className="inline-flex min-h-11 items-center gap-2 justify-self-end text-sm text-text-body">
                  <Switch
                    className={SWITCH_CONTRAST}
                    checked={row.active}
                    disabled={setActive.isPending}
                    aria-label={`${row.active ? 'Pause' : 'Resume'} ${row.templateName} for ${scheduleTarget(row)}`}
                    onCheckedChange={(active) => {
                      toggling.current = {
                        name: row.templateName,
                        target: scheduleTarget(row),
                        active,
                      };
                      setChanged(null);
                      setActive.mutate({ pharmacyBranchId, assignmentId: row.id, active });
                    }}
                  />
                  {row.active ? 'Active' : 'Paused'}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

/** What the automatic-scheduling switch does, said in plain words beside it. */
export const AUTO_SCHEDULE_COPY =
  "When on, this branch's procedures are created automatically from its schedules, due at the times you set. It checks every hour. When off, use 'Create today's work now'. Procedures never block pharmacy work.";

/** A time of day at the branch, for the next automatic run ("12:00"). */
function branchTime(value: Date | string, timezone: string | null) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: workspaceTimezone(timezone),
  }).format(date);
}

/** The result of turning automatic scheduling on or off, said beside the switch. */
export function autoScheduleNotice(
  result: {
    autoScheduleEnabled: boolean;
    generated?: number | null;
    nextRunAt?: Date | string | null;
  },
  timezone: string | null
) {
  if (!result.autoScheduleEnabled) {
    return "Turned off. Use 'Create today's work now' when you are ready.";
  }
  const created =
    result.generated == null
      ? null
      : result.generated === 0
        ? 'No procedures were due to be created yet'
        : `${result.generated} ${result.generated === 1 ? 'procedure was' : 'procedures were'} created for today`;
  const at = result.nextRunAt ? branchTime(result.nextRunAt, timezone) : null;
  const next = at ? `next automatic run at ${at}` : null;
  if (created && next) return `Turned on. ${created}; ${next}.`;
  if (created) return `Turned on. ${created}. It checks every hour.`;
  if (next) return `Turned on. Next automatic run at ${at}.`;
  return 'Turned on. It checks every hour.';
}

type AutoScheduleResult = Parameters<typeof autoScheduleNotice>[0];

function branchTimeOrNull(value: Date | string | null, timezone: string | null) {
  return value ? branchTime(value, timezone) : null;
}

/**
 * Per-branch automatic scheduling. OFF until a manager turns it on; a missing
 * or unreadable setting is shown as off and the switch stays disabled. What a
 * change did is said beside the switch, not in a banner far from it.
 */
function AutoScheduling({
  pharmacyBranchId,
  timezone,
}: {
  pharmacyBranchId: string;
  timezone: string | null;
}) {
  const labelId = useId();
  const copyId = useId();
  const utils = trpc.useUtils();
  const settings = trpc.pharmacySop.siteSettings.useQuery({ pharmacyBranchId }, { retry: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nextRunAt, setNextRunAt] = useState<Date | string | null>(null);
  const setAuto = trpc.pharmacySop.setAutoSchedule.useMutation({
    onSuccess: async (result: AutoScheduleResult) => {
      setError(null);
      setNotice(autoScheduleNotice(result, timezone));
      setNextRunAt(result.autoScheduleEnabled ? (result.nextRunAt ?? null) : null);
      await utils.pharmacySop.siteSettings.invalidate({ pharmacyBranchId });
    },
    onError: (cause) => {
      setNotice(null);
      setError(errorMessage(cause, 'Automatic scheduling could not be changed. Retry.'));
    },
  });
  const enabled = settings.data?.autoScheduleEnabled ?? false;
  // The setting read may carry the next run once the server reports it.
  const savedNextRun = (settings.data as { nextRunAt?: Date | string | null } | undefined)
    ?.nextRunAt;
  const nextAt = enabled ? branchTimeOrNull(nextRunAt ?? savedNextRun ?? null, timezone) : null;

  return (
    <div className="mb-4 grid gap-2 rounded-md border border-border-subtle bg-surface-sunken p-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <p id={labelId} className="text-sm font-medium text-text-strong">
          Automatic scheduling
        </p>
        <label className="inline-flex min-h-11 items-center gap-2 justify-self-end text-sm text-text-body">
          <Switch
            className={SWITCH_CONTRAST}
            checked={enabled}
            disabled={settings.isLoading || !settings.data || setAuto.isPending}
            aria-labelledby={labelId}
            aria-describedby={copyId}
            onCheckedChange={(checked) => {
              setNotice(null);
              setAuto.mutate({ pharmacyBranchId, enabled: checked });
            }}
          />
          {settings.isLoading ? 'Loading…' : enabled ? 'On' : 'Off'}
        </label>
      </div>
      <p role="status" className="text-sm text-text-body empty:hidden">
        {notice}
      </p>
      <p id={copyId} className="max-w-2xl text-xs text-text-muted">
        {AUTO_SCHEDULE_COPY}
      </p>
      {nextAt && !notice ? (
        <p className="text-xs text-text-muted">Next automatic run at {nextAt}.</p>
      ) : null}
      {settings.error ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-destructive">
            {errorMessage(settings.error, 'Automatic scheduling could not be loaded.')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => void settings.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
