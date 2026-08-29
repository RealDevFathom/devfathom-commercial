'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';
const formatDate = new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium' });

export function RestaurantTaxConsole() {
  const utils = trpc.useUtils();
  const configuration = trpc.restaurantTax.configuration.useQuery();
  const [selectedId, setSelectedId] = useState('');
  const selected = useMemo(
    () => configuration.data?.profiles.find((profile) => profile.id === selectedId),
    [configuration.data, selectedId]
  );
  const activation = trpc.restaurantTax.activate.useMutation({
    onSuccess: () => {
      toast.success('Tax profile activated.');
      void utils.restaurantTax.configuration.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    activation.mutate({
      branchId: String(data.get('branchId') ?? ''),
      profileId: selected.id,
      effectiveFrom: new Date(`${String(data.get('effectiveFrom'))}T00:00:00.000Z`).toISOString(),
      approvalReference: String(data.get('approvalReference') ?? '').trim(),
      accountantConfirmation: data.get('accountantConfirmation') === 'on',
      eligibilityConfirmations: selected.eligibilityControls
        .filter((control) => data.get(control.id) === 'on')
        .map((control) => control.id),
    });
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant administration"
        heading="Tax configuration"
        description="Explicitly activate an effective-dated jurisdiction profile for one branch. Configuration requires accountant confirmation and is not tax advice."
      />

      {configuration.isLoading ? (
        <SectionCard title="Loading tax configuration…">
          <div role="status" className="space-y-3">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        </SectionCard>
      ) : configuration.error ? (
        <SectionCard title="Tax configuration unavailable">
          <div role="alert" className="space-y-3 text-sm text-destructive">
            <p>{configuration.error.message}</p>
            <Button variant="outline" onClick={() => void configuration.refetch()}>
              Try again
            </Button>
          </div>
        </SectionCard>
      ) : (
        <>
          <SectionCard eyebrow="Fail-closed activation" title="Choose a verified profile">
            <form className="space-y-5" onSubmit={submit}>
              <div className="grid gap-4 md:grid-cols-2">
                <label className={labelClass}>
                  Branch
                  <select className={selectClass} name="branchId" required defaultValue="">
                    <option value="" disabled>
                      Select a branch
                    </option>
                    {configuration.data?.branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClass}>
                  Jurisdiction and profile
                  <select
                    aria-label="Jurisdiction and profile"
                    className={selectClass}
                    name="profileId"
                    required
                    value={selectedId}
                    onChange={(event) => setSelectedId(event.target.value)}
                  >
                    <option value="" disabled>
                      Select a profile
                    </option>
                    {configuration.data?.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id} disabled={!profile.enabled}>
                        {profile.jurisdiction} — {profile.name}
                        {profile.enabled ? '' : ' (unavailable)'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClass}>
                  Effective date
                  <Input
                    className="mt-1 min-h-11"
                    name="effectiveFrom"
                    type="date"
                    min={selected?.effectiveFrom ?? undefined}
                    required
                  />
                </label>
                <label className={labelClass}>
                  Accountant approval reference
                  <Input
                    className="mt-1 min-h-11"
                    name="approvalReference"
                    maxLength={240}
                    required
                    placeholder="Engagement, memo, or approval ID"
                  />
                </label>
              </div>

              {selected ? (
                <div className="rounded-md border border-border-default bg-surface-sunken p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill
                      status={selected.enabled ? 'Available' : 'Unavailable'}
                      tone={selected.enabled ? 'success' : 'warning'}
                    />
                    <span className="font-medium text-text-strong">{selected.name}</span>
                  </div>
                  {'disabledReason' in selected ? (
                    <p className="mt-3 text-warning">{selected.disabledReason}</p>
                  ) : null}
                  <p className="mt-3 text-text-muted">
                    Effective from: {selected.effectiveFrom ?? 'Blocked pending official rate'}
                  </p>
                  <a
                    className="mt-1 inline-block text-sm text-primary underline underline-offset-4"
                    href={selected.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {selected.sourceTitle}
                  </a>
                  {selected.rules.length ? (
                    <ul className="mt-3 grid gap-1 font-mono text-xs text-text-muted">
                      {selected.rules.map((rule) => (
                        <li key={rule.ruleCode}>
                          {rule.paymentCategory}: {(Number(rule.rate) * 100).toFixed(0)}%
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {selected.eligibilityControls.map((control) => (
                    <label
                      key={control.id}
                      className="mt-3 flex items-start gap-3 text-text-strong"
                    >
                      <input className="mt-1 size-4" type="checkbox" name={control.id} required />
                      {control.label}
                    </label>
                  ))}
                </div>
              ) : null}

              <label className="flex items-start gap-3 text-sm text-text-strong">
                <input
                  className="mt-1 size-4"
                  type="checkbox"
                  name="accountantConfirmation"
                  required
                />
                I confirm an accountant reviewed this exact branch, profile, effective date, and
                eligibility evidence.
              </label>
              <Button type="submit" disabled={!selected?.enabled || activation.isPending}>
                {activation.isPending ? 'Activating…' : 'Activate tax profile'}
              </Button>
            </form>
          </SectionCard>

          <SectionCard eyebrow="Published evidence" title="Active and scheduled profiles">
            {configuration.data?.activeProfiles.length ? (
              <div className="space-y-3">
                {configuration.data.activeProfiles.map((profile) => (
                  <div key={profile.id} className="rounded-md border border-border-default p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-text-strong">{profile.branch.name}</span>
                      <StatusPill status="Published" tone="success" />
                    </div>
                    <p className="mt-2 text-sm text-text-muted">
                      Effective {formatDate.format(new Date(profile.effectiveFrom))} ·{' '}
                      {profile.approvalReference}
                    </p>
                    <p className="mt-1 font-mono text-xs text-text-faint">
                      {profile.rules
                        .map((rule) => `${rule.paymentCategory} ${Number(rule.rate) * 100}%`)
                        .join(' · ')}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
                <p className="font-medium text-text-strong">No tax profile configured.</p>
                <p className="mt-1 text-sm text-text-muted">
                  Checkout remains fail-closed until an administrator explicitly activates one.
                </p>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
