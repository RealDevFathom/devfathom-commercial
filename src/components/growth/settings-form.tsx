import { SectionCard } from '@/components/ui/section-card';
import type { GrowthConnection, GrowthSettingsView } from '@/lib/growth/view';

import { ConnectionChip } from './growth-nav';
import { growthFieldClass, rupeesInput } from './format';
import { PendingButton } from './pending-button';

export function SettingsForm({
  settings,
  connection,
  save,
}: {
  settings: GrowthSettingsView;
  connection: GrowthConnection;
  save: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <div className="min-w-0 space-y-6">
      <SectionCard title="WhatsApp" titleLevel={2}>
        <ConnectionChip connection={connection} />
      </SectionCard>
      <SectionCard title="Budget and quiet hours" titleLevel={2}>
        <form action={save} className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm text-text-body">
            Monthly budget (PKR)
            <input
              className={growthFieldClass}
              name="monthlyBudget"
              inputMode="decimal"
              defaultValue={rupeesInput(settings.monthlyBudgetMinor)}
              required
            />
          </label>
          <label className="block text-sm text-text-body">
            Auto-approve under (PKR)
            <input
              className={growthFieldClass}
              name="autoApproveUnder"
              inputMode="decimal"
              defaultValue={rupeesInput(settings.autoApproveUnderMinor)}
              required
            />
          </label>
          <p className="text-xs text-text-muted sm:col-span-2">
            The budget is a hard cap for the calendar month. 0 on auto-approve means a person
            approves every discount.
          </p>
          <label className="block text-sm text-text-body" htmlFor="quiet-start">
            Quiet hours start
            <input
              id="quiet-start"
              className={growthFieldClass}
              name="quietHoursStart"
              type="number"
              min={0}
              max={23}
              defaultValue={settings.quietHoursStart}
              required
            />
          </label>
          <label className="block text-sm text-text-body" htmlFor="quiet-end">
            Quiet hours end
            <input
              id="quiet-end"
              className={growthFieldClass}
              name="quietHoursEnd"
              type="number"
              min={0}
              max={23}
              defaultValue={settings.quietHoursEnd}
              required
            />
          </label>
          <p className="text-xs text-text-muted sm:col-span-2">
            No WhatsApp from the start hour until the end hour, Asia/Karachi. 21 and 9 means 9pm
            until 9am.
          </p>
          <label className="block text-sm text-text-body">
            Max messages a day
            <input
              className={growthFieldClass}
              name="maxMsgsPerDay"
              type="number"
              min={1}
              max={200}
              defaultValue={settings.maxMsgsPerDay}
              required
            />
          </label>
          <label className="block text-sm text-text-body">
            Max discount %
            <input
              className={growthFieldClass}
              name="maxDiscountPct"
              type="number"
              min={0}
              max={25}
              defaultValue={settings.maxDiscountPct}
              required
            />
          </label>
          <label className="block text-sm text-text-body sm:col-span-2">
            Shop dates
            <textarea
              className={`${growthFieldClass} min-h-24 py-2`}
              name="customDates"
              defaultValue={settings.customDates.join('\n')}
              placeholder="2026-11-09"
            />
          </label>
          <p className="text-xs text-text-muted sm:col-span-2">
            One YYYY-MM-DD per line, for a founding day or a local mela. Keep a new number near 30
            messages a day for the first two weeks.
          </p>
          <label className="block text-sm text-text-body">
            Evolution instance
            <input
              className={growthFieldClass}
              name="waInstanceName"
              defaultValue={settings.waInstanceName ?? ''}
              maxLength={80}
            />
          </label>
          <label className="block text-sm text-text-body">
            Evolution URL
            <input
              className={growthFieldClass}
              name="waApiUrl"
              type="url"
              defaultValue={settings.waApiUrl ?? ''}
              placeholder="http://127.0.0.1:8080"
            />
          </label>
          <label className="block text-sm text-text-body sm:col-span-2">
            API key
            <input
              className={growthFieldClass}
              name="waApiKey"
              type="password"
              autoComplete="off"
              placeholder={
                settings.waApiKeyHint
                  ? `Saved key ${settings.waApiKeyHint}. Leave blank to keep it.`
                  : 'Paste the instance key'
              }
            />
          </label>
          <div className="sm:col-span-2">
            <PendingButton pendingLabel="Saving…" className="min-h-11">
              Save settings
            </PendingButton>
          </div>
        </form>
      </SectionCard>
    </div>
  );
}
