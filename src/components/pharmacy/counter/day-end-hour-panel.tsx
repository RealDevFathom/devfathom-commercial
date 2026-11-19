'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  PHARMACY_DEFAULT_DAY_END_HOUR,
  PHARMACY_MAX_DAY_END_HOUR,
  pharmacyDayEndLabel,
} from '@/lib/pharmacy/business-day';
import { trpc } from '@/lib/trpc';

const HOURS = Array.from(
  { length: PHARMACY_MAX_DAY_END_HOUR - PHARMACY_DEFAULT_DAY_END_HOUR + 1 },
  (_, index) => PHARMACY_DEFAULT_DAY_END_HOUR + index
);

/** "1 Nov 2026" for a `YYYY-MM-DD` business day: a day's name, not a clock time. */
function dayLabel(day: string) {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * DEV-958A — when this branch's business day ends. A shop open past midnight picks a later
 * hour so its late trade stays on one day and one drawer. A change first ends tomorrow's
 * business day at the new hour, so no day that has begun, and no past day, its close or its
 * reports, moves. "Ends at" is always the hour a day ends: today's is when tomorrow starts.
 * The server enforces who may change it (an owner, or a manager at the branch) and audits it;
 * this form only explains and asks.
 */
export function DayEndHourPanel({ branchId }: { branchId: string }) {
  const query = trpc.pharmacySales.dayEndHour.useQuery({ branchId }, { retry: false });
  const save = trpc.pharmacySales.saveDayEndHour.useMutation();
  const [draft, setDraft] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const data = query.data;
  const value = draft ?? data?.scheduledHour ?? PHARMACY_DEFAULT_DAY_END_HOUR;
  const denied = query.error?.data?.code === 'FORBIDDEN';
  const disabled = !data || save.isPending;
  const selectId = `day-end-hour-${branchId}`;
  const helpId = `${selectId}-help`;

  async function submit() {
    if (!data || draft === null || draft === data.scheduledHour) return;
    setNotice('');
    try {
      const saved = await save.mutateAsync({
        branchId,
        revision: data.revision,
        dayEndsAtHour: draft,
      });
      const refreshed = await query.refetch();
      setDraft(null);
      setNotice(
        refreshed.error
          ? 'Saved. Reload this setting before changing it again.'
          : saved.fromBusinessDay
            ? `Saved. From ${dayLabel(saved.fromBusinessDay)}, the day ends at ${pharmacyDayEndLabel(draft)}.`
            : 'Saved. Nothing changed.'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      setNotice(message || 'Could not save. Reload this setting to check access and changes.');
    }
  }

  return (
    <SectionCard
      title="When the business day ends"
      eyebrow="Branch business day"
      titleLevel={2}
      actions={
        data ? (
          <StatusPill
            status={`Ends at ${pharmacyDayEndLabel(data.dayEndsAtHour)}`}
            tone={data.dayEndsAtHour === PHARMACY_DEFAULT_DAY_END_HOUR ? 'neutral' : 'info'}
          />
        ) : null
      }
    >
      <p className="text-sm text-text-body">
        Sales, drawers, refunds and the day close count on the business day. Open past midnight? End
        the day later: with 5:00 AM, a 12:30 AM sale counts on the day before. Receipts keep the
        real time.
      </p>
      {query.isLoading ? (
        <p className="mt-4 text-sm text-text-muted" role="status">
          Loading this branch&apos;s business day…
        </p>
      ) : null}
      {query.isError ? (
        <div className="mt-4 space-y-2" role="alert">
          <p className="text-sm text-text-body">
            {denied
              ? 'Only the owner, or a manager assigned to this branch, can see and change when its day ends.'
              : 'This setting is unavailable right now. Nothing was changed.'}
          </p>
          {denied ? null : (
            <Button className="min-h-11" onClick={() => void query.refetch()} variant="outline">
              Retry
            </Button>
          )}
        </div>
      ) : null}
      {data ? (
        <div className="mt-4 space-y-4">
          <p className="font-mono text-xs text-text-muted">
            Today&apos;s business day: {dayLabel(data.currentBusinessDay)} · {data.timeZone}
          </p>
          {data.pendingChanges.length ? (
            <ul className="space-y-1 rounded-md border border-border-subtle bg-surface-sunken px-3 py-2 text-sm text-text-body">
              {data.pendingChanges.map((change) => (
                <li key={change.fromBusinessDay}>
                  From {dayLabel(change.fromBusinessDay)}, the day ends at{' '}
                  {pharmacyDayEndLabel(change.hour)}.
                </li>
              ))}
            </ul>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor={selectId}>The business day ends at</Label>
            <select
              aria-describedby={helpId}
              className="min-h-11 w-full max-w-xs rounded-control border border-border-default bg-surface-card px-3 text-sm text-text-strong focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
              disabled={disabled}
              id={selectId}
              onChange={(event) => {
                setNotice('');
                setDraft(Number(event.target.value));
              }}
              value={value}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>
                  {pharmacyDayEndLabel(hour)}
                </option>
              ))}
            </select>
            <p className="text-sm text-text-muted" id={helpId}>
              A change starts with tomorrow&apos;s business day, {dayLabel(data.nextBusinessDay)}.
              Today and earlier days, their closes and reports stay as they are.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="min-h-11"
              disabled={disabled || draft === null || draft === data.scheduledHour}
              onClick={() => void submit()}
            >
              {save.isPending ? 'Saving…' : 'Save day end'}
            </Button>
            {draft !== null ? (
              <Button
                className="min-h-11"
                disabled={save.isPending}
                onClick={() => {
                  setDraft(null);
                  setNotice('');
                }}
                variant="outline"
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {notice ? (
        <p className="mt-3 text-sm text-text-body" role="status">
          {notice}
        </p>
      ) : null}
    </SectionCard>
  );
}
