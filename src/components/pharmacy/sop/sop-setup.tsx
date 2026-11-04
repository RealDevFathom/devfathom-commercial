'use client';

import { useId, useMemo, useState } from 'react';

import { Field, fieldClass, WorkspaceState } from '@/components/pharmacy/dispensing/field';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Switch } from '@/components/ui/switch';
import { ianaTimezoneOptions } from '@/lib/platform/timezones';
import { workspaceToday } from '@/lib/timezone';
import { trpc } from '@/lib/trpc';

import {
  errorMessage,
  minutesToTime,
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
} from './sop-model';

type Notify = (notice: { tone: 'success' | 'danger'; text: string }) => void;

export type SopSetupViewProps = {
  branch: SopBranch;
  onChanged: () => void;
  onNotice: Notify;
};

/**
 * Manager setup for one branch. Every change here is explicit: turning on
 * procedures creates no schedules, adding the library creates no schedules,
 * and a schedule exists only after a manager confirms it below.
 */
export function SopSetupView({ branch, onChanged, onNotice }: SopSetupViewProps) {
  if (!branch.sopBranchId) {
    return <EnableSite branch={branch} onChanged={onChanged} onNotice={onNotice} />;
  }
  return (
    <div className="grid min-w-0 gap-6">
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
      <Schedules pharmacyBranchId={branch.pharmacyBranchId} onNotice={onNotice} />
    </div>
  );
}

function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function EnableSite({ branch, onChanged, onNotice }: SopSetupViewProps) {
  const zones = useMemo(() => {
    try {
      return ianaTimezoneOptions().map((option) => option.value);
    } catch {
      return ['UTC'];
    }
  }, []);
  const [timezone, setTimezone] = useState(branch.timezone ?? browserZone());
  const [cutoff, setCutoff] = useState('');
  const [error, setError] = useState<string | null>(null);
  const enable = trpc.pharmacySop.enableSite.useMutation({
    onSuccess: () => {
      setError(null);
      onNotice({ tone: 'success', text: `Procedures are now on at ${branch.name}.` });
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
        className="grid max-w-2xl gap-4 sm:grid-cols-2"
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

function RoleHoldings({ pharmacyBranchId }: { pharmacyBranchId: string }) {
  const utils = trpc.useUtils();
  const holdings = trpc.pharmacySop.roleHoldings.useQuery({ pharmacyBranchId }, { retry: false });
  const [error, setError] = useState<string | null>(null);
  const setHolding = trpc.pharmacySop.setRoleHolding.useMutation({
    onSuccess: async () => {
      setError(null);
      await utils.pharmacySop.roleHoldings.invalidate({ pharmacyBranchId });
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
                    </span>
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
                      return (
                        <label
                          key={roleKey}
                          className="inline-flex min-h-11 items-center gap-2 text-sm text-text-body"
                        >
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={held}
                            disabled={setHolding.isPending}
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
  const [dueTime, setDueTime] = useState(minutesToTime(suggestion.dueTimeMinutes));
  const [endTime, setEndTime] = useState(
    suggestion.intervalEndTimeMinutes != null
      ? minutesToTime(suggestion.intervalEndTimeMinutes)
      : ''
  );
  const [windowMinutes, setWindowMinutes] = useState(String(suggestion.windowMinutes));
  const [graceMinutes, setGraceMinutes] = useState(String(suggestion.graceMinutes));
  const [startDate, setStartDate] = useState(workspaceToday(branch.timezone));
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = trpc.pharmacySop.createAssignment.useMutation({
    onSuccess: async () => {
      setError(null);
      await utils.pharmacySop.assignments.invalidate({ pharmacyBranchId: branch.pharmacyBranchId });
      onDone();
    },
    onError: (cause) => setError(errorMessage(cause, 'The schedule could not be created. Retry.')),
  });

  function validate(): string | null {
    const due = timeToMinutes(dueTime);
    if (due === null) return 'Enter a valid due time.';
    if (targetType === 'PERSON' && !userId) return 'Choose the person who will do it.';
    const every = Number(interval);
    if (!Number.isInteger(every) || every < 1)
      return 'Enter how often it repeats as a whole number.';
    if (frequency === 'INTERVAL') {
      if (every < 15) return 'Repeat at least 15 minutes apart.';
      if (days.length === 0) return 'Choose at least one day of the week.';
      const end = timeToMinutes(endTime);
      if (end === null || end <= due) return 'Enter an end time later than the start time.';
    }
    if (frequency === 'WEEKLY' && days.length === 0) return 'Choose at least one day of the week.';
    if (frequency === 'MONTHLY') {
      const day = Number(monthDay);
      if (!Number.isInteger(day) || day < 1 || day > 31)
        return 'Choose a day of the month from 1 to 31.';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return 'Choose a start date.';
    if (endDate && endDate < startDate) return 'The end date must be on or after the start date.';
    return null;
  }

  return (
    <form
      aria-label={`Schedule for ${template.name}`}
      className="mt-4 grid gap-4 rounded-md border border-border-subtle bg-surface-sunken p-4 md:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = validate();
        if (problem) {
          setError(problem);
          return;
        }
        create.mutate({
          pharmacyBranchId: branch.pharmacyBranchId,
          templateId: template.id,
          target: targetType === 'ROLE' ? { type: 'ROLE', roleKey } : { type: 'PERSON', userId },
          frequency,
          interval: Number(interval),
          daysOfWeek: frequency === 'WEEKLY' || frequency === 'INTERVAL' ? days : [],
          monthDay: frequency === 'MONTHLY' ? Number(monthDay) : null,
          dueTimeMinutes: timeToMinutes(dueTime) ?? 0,
          intervalEndTimeMinutes: frequency === 'INTERVAL' ? timeToMinutes(endTime) : null,
          windowMinutes: Number(windowMinutes) || 0,
          graceMinutes: Number(graceMinutes) || 0,
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
        <Field label="Role">
          <select
            className={fieldClass}
            value={roleKey}
            onChange={(event) => setRoleKey(event.target.value as SopRoleKey)}
          >
            {ROLE_KEYS.map((key) => (
              <option key={key} value={key}>
                {ROLE_LABEL[key]}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label="Person" hint="Only people assigned to this branch are listed.">
          <select
            className={fieldClass}
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
        </Field>
      )}
      <Field label="How often">
        <select
          className={fieldClass}
          value={frequency}
          onChange={(event) => setFrequency(event.target.value as SopFrequency)}
        >
          {FREQUENCIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      {frequency !== 'ONCE' ? (
        <Field
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
        >
          <input
            className={fieldClass}
            inputMode="numeric"
            value={interval}
            onChange={(event) => setRepeat(event.target.value)}
          />
        </Field>
      ) : null}
      {frequency === 'WEEKLY' || frequency === 'INTERVAL' ? (
        <fieldset className="grid gap-2 md:col-span-2">
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
        </fieldset>
      ) : null}
      {frequency === 'MONTHLY' ? (
        <Field label="Day of the month">
          <input
            className={fieldClass}
            inputMode="numeric"
            value={monthDay}
            onChange={(event) => setMonthDay(event.target.value)}
          />
        </Field>
      ) : null}
      <Field label={frequency === 'INTERVAL' ? 'First one at' : 'Due at'}>
        <input
          type="time"
          className={fieldClass}
          value={dueTime}
          onChange={(event) => setDueTime(event.target.value)}
        />
      </Field>
      {frequency === 'INTERVAL' ? (
        <Field label="Last one by">
          <input
            type="time"
            className={fieldClass}
            value={endTime}
            onChange={(event) => setEndTime(event.target.value)}
          />
        </Field>
      ) : null}
      <Field
        label="Time allowed (minutes)"
        hint="How long after the due time it can still be done."
      >
        <input
          className={fieldClass}
          inputMode="numeric"
          value={windowMinutes}
          onChange={(event) => setWindowMinutes(event.target.value)}
        />
      </Field>
      <Field label="Grace before it counts as late (minutes)">
        <input
          className={fieldClass}
          inputMode="numeric"
          value={graceMinutes}
          onChange={(event) => setGraceMinutes(event.target.value)}
        />
      </Field>
      <Field label="Starts on">
        <input
          type="date"
          className={fieldClass}
          value={startDate}
          onChange={(event) => setStartDate(event.target.value)}
        />
      </Field>
      <Field label="Ends on · optional">
        <input
          type="date"
          className={fieldClass}
          value={endDate}
          onChange={(event) => setEndDate(event.target.value)}
        />
      </Field>
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

function Schedules({ pharmacyBranchId, onNotice }: { pharmacyBranchId: string; onNotice: Notify }) {
  const utils = trpc.useUtils();
  const assignments = trpc.pharmacySop.assignments.useQuery({ pharmacyBranchId }, { retry: false });
  const [error, setError] = useState<string | null>(null);
  const setActive = trpc.pharmacySop.setAssignmentActive.useMutation({
    onSuccess: async () => {
      setError(null);
      await utils.pharmacySop.assignments.invalidate({ pharmacyBranchId });
    },
    onError: (cause) => setError(errorMessage(cause, 'The schedule could not be changed. Retry.')),
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
        <ul className="divide-y divide-border-subtle">
          {list.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
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
              <label className="inline-flex min-h-11 items-center gap-2 text-sm text-text-body">
                <Switch
                  checked={row.active}
                  disabled={setActive.isPending}
                  aria-label={`${row.active ? 'Pause' : 'Resume'} ${row.templateName}`}
                  onCheckedChange={(active) =>
                    setActive.mutate({ pharmacyBranchId, assignmentId: row.id, active })
                  }
                />
                {row.active ? 'Active' : 'Paused'}
              </label>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
