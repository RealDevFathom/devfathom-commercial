'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { parseMajorToMinor } from '@/lib/pharmacy/khata-payment-slip';
import {
  KHATA_REMINDER_CADENCE_RANGE,
  khataReminderSettingsSchema,
  type KhataReminderSettings,
} from '@/lib/pharmacy/khata-reminder-settings';
import { trpc } from '@/lib/trpc';

type Draft = { enabled: boolean; cadenceDays: string; minBalance: string };

function toDraft(settings: KhataReminderSettings): Draft {
  return {
    enabled: settings.enabled,
    cadenceDays: String(settings.cadenceDays),
    minBalance: (settings.minBalanceMinor / 100).toFixed(2),
  };
}

/**
 * DEV-76 — the owner's khata collection reminder schedule for one branch.
 * Quiet hours (22:00–09:00 local) and customer consent are fixed policy and
 * are enforced by the scheduled job, not by this form.
 */
export function KhataReminderSettingsPanel({ branchId }: { branchId: string }) {
  const query = trpc.pharmacySales.khataReminderSettings.useQuery({ branchId });
  const save = trpc.pharmacySales.saveKhataReminderSettings.useMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState<'cadenceDays' | 'minBalanceMinor' | null>(null);
  const loaded = query.data ? toDraft(query.data.settings) : null;
  const values = draft ?? loaded;
  const disabled = query.isLoading || query.isError || save.isPending || !values;
  function change(next: Partial<Draft>) {
    if (!values) return;
    setNotice('');
    setInvalid(null);
    setDraftRevision(draftRevision ?? query.data?.revision ?? null);
    setDraft({ ...values, ...next });
  }
  return (
    <SectionCard title="Khata collection reminders" eyebrow="Branch reminder schedule">
      <p className="mb-4 text-sm text-text-muted">
        Overdue khata payers who agreed to reminders get a WhatsApp or SMS note with the amount, the
        due date and this branch&apos;s Raast or wallet details. No reminder is sent between 10pm
        and 9am, and a STOP reply ends them. Payments are still recorded at the counter.
      </p>
      {query.isLoading ? <p role="status">Loading reminder schedule…</p> : null}
      {query.isError ? (
        <div role="alert" className="space-y-2">
          <p>
            The reminder schedule is unavailable. An authorized pharmacy administrator can manage
            this branch.
          </p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 md:grid-cols-3">
        <legend className="sr-only">Reminder schedule</legend>
        <Label className="flex min-h-11 items-center gap-2 md:col-span-3">
          <input
            type="checkbox"
            checked={values?.enabled ?? false}
            onChange={(event) => change({ enabled: event.target.checked })}
          />{' '}
          Send khata reminders from this branch
        </Label>
        <div className="space-y-2">
          <Label htmlFor={`khata-reminder-cadence-${branchId}`}>Days between reminders</Label>
          <Input
            id={`khata-reminder-cadence-${branchId}`}
            className="min-h-11"
            type="number"
            inputMode="numeric"
            min={KHATA_REMINDER_CADENCE_RANGE.min}
            max={KHATA_REMINDER_CADENCE_RANGE.max}
            step={1}
            aria-invalid={invalid === 'cadenceDays' || undefined}
            value={values?.cadenceDays ?? ''}
            onChange={(event) => change({ cadenceDays: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`khata-reminder-floor-${branchId}`}>Minimum balance to remind (Rs)</Label>
          <Input
            id={`khata-reminder-floor-${branchId}`}
            className="min-h-11"
            inputMode="decimal"
            aria-invalid={invalid === 'minBalanceMinor' || undefined}
            value={values?.minBalance ?? ''}
            onChange={(event) => change({ minBalance: event.target.value })}
          />
        </div>
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          className="min-h-11"
          disabled={disabled || draft === null}
          onClick={async () => {
            if (!draft || draftRevision === null) return;
            const parsed = khataReminderSettingsSchema.safeParse({
              enabled: draft.enabled,
              cadenceDays: /^\d+$/.test(draft.cadenceDays.trim()) ? Number(draft.cadenceDays) : NaN,
              minBalanceMinor: parseMajorToMinor(draft.minBalance),
            });
            if (!parsed.success) {
              const issue = parsed.error.issues[0];
              setInvalid(issue?.path[0] === 'cadenceDays' ? 'cadenceDays' : 'minBalanceMinor');
              setNotice(
                issue?.path[0] === 'cadenceDays'
                  ? `Enter whole days from ${KHATA_REMINDER_CADENCE_RANGE.min} to ${KHATA_REMINDER_CADENCE_RANGE.max}.`
                  : 'Enter a minimum balance of at least 1.00.'
              );
              return;
            }
            try {
              await save.mutateAsync({ branchId, revision: draftRevision, settings: parsed.data });
              const refreshed = await query.refetch();
              if (refreshed.error) {
                setNotice('Saved. Reload the reminder schedule before making further changes.');
                return;
              }
              setDraft(null);
              setDraftRevision(null);
              setNotice('Reminder schedule saved.');
            } catch {
              setNotice(
                'Could not save. Reload the reminder schedule to check access and concurrent changes.'
              );
            }
          }}
        >
          {save.isPending ? 'Saving…' : 'Save reminder schedule'}
        </Button>
        <Button
          variant="outline"
          disabled={query.isLoading || save.isPending}
          onClick={async () => {
            const refreshed = await query.refetch();
            if (refreshed.error) {
              setNotice('The reminder schedule could not be reloaded. Your draft is preserved.');
              return;
            }
            setDraft(null);
            setDraftRevision(null);
            setInvalid(null);
            setNotice('');
          }}
        >
          Reload reminder schedule
        </Button>
      </div>
      {notice ? (
        <p role="status" className="mt-3 text-sm text-text-body">
          {notice}
        </p>
      ) : null}
    </SectionCard>
  );
}
