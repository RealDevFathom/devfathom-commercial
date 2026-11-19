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
 * hour so its late trade stays on one day and one drawer. The server enforces who may change
 * it (an owner, or a manager at the branch), refuses a change while a drawer is open, and
 * audits it; this form only explains and asks.
 */
export function DayEndHourPanel({ branchId }: { branchId: string }) {
  const query = trpc.pharmacySales.dayEndHour.useQuery({ branchId }, { retry: false });
  const save = trpc.pharmacySales.saveDayEndHour.useMutation();
  const [draft, setDraft] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const data = query.data;
  const value = draft ?? data?.dayEndsAtHour ?? PHARMACY_DEFAULT_DAY_END_HOUR;
  const drawersOpen = (data?.openDrawers ?? 0) > 0;
  const denied = query.error?.data?.code === 'FORBIDDEN';
  const disabled = !data || save.isPending || drawersOpen;
  const selectId = `day-end-hour-${branchId}`;
  const helpId = `${selectId}-help`;

  async function submit() {
    if (!data || draft === null || draft === data.dayEndsAtHour) return;
    setNotice('');
    try {
      await save.mutateAsync({ branchId, revision: data.revision, dayEndsAtHour: draft });
      const refreshed = await query.refetch();
      setDraft(null);
      setNotice(
        refreshed.error
          ? 'Saved. Reload this setting before changing it again.'
          : `Saved. This branch's business day now ends at ${pharmacyDayEndLabel(draft)}.`
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
        Sales, drawers, refunds and the day close count on the business day. It normally ends at
        midnight. If this shop stays open past midnight, choose a later hour: with 5:00 AM, a sale
        at 12:30 AM belongs to the day before and goes in the drawer opened that day. Receipts still
        print the real date and time.
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
            Today&apos;s business day: {dayLabel(data.currentBusinessDay)} · times in{' '}
            {data.timeZone}
          </p>
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
              {drawersOpen
                ? `${data.openDrawers} drawer${data.openDrawers === 1 ? ' is' : 's are'} open. Close the day first, then change this before opening the next day's drawers.`
                : 'Change it between days, when no drawer is open. Days already closed, and everything already recorded, stay as they are.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="min-h-11"
              disabled={disabled || draft === null || draft === data.dayEndsAtHour}
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
