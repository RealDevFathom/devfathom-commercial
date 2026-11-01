'use client';

import { browserUuid } from '@/lib/browser-uuid';

import { useMemo, useRef, useState, type FormEvent } from 'react';
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
const formatDate = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeZone }).format(date);
const paymentCategories = ['CASH', 'CARD', 'OTHER'] as const;
type PaymentCategory = (typeof paymentCategories)[number];
type RateErrors = Partial<Record<PaymentCategory, string>>;
const rateLabels: Record<PaymentCategory, string> = {
  CASH: 'Cash tax rate (%)',
  CARD: 'Card tax rate (%)',
  OTHER: 'Other tax rate (%)',
};

function parsePercentage(value: string): { decimal?: string; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { error: 'Enter a tax rate percentage.' };
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
    if (/^-(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
      return { error: 'Tax rate percentage cannot be negative.' };
    }
    return { error: 'Enter a valid number.' };
  }

  const [rawWhole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > 2) {
    return { error: 'Tax rate percentage can have at most two decimal places.' };
  }
  const whole = (rawWhole || '0').replace(/^0+(?=\d)/, '');
  if (
    whole.length > 3 ||
    (whole.length === 3 && (whole > '100' || (whole === '100' && /[1-9]/.test(fraction))))
  ) {
    return { error: 'Tax rate percentage cannot exceed 100.' };
  }

  const decimalPlaces = fraction.length + 2;
  const coefficient = `${whole}${fraction}`.replace(/^0+/, '') || '0';
  const shifted = coefficient.padStart(decimalPlaces + 1, '0');
  const decimalFraction = shifted.slice(-decimalPlaces).replace(/0+$/, '');
  const decimalWhole = shifted.slice(0, -decimalPlaces);
  return { decimal: decimalFraction ? `${decimalWhole}.${decimalFraction}` : decimalWhole };
}

export function RestaurantTaxConsole() {
  const utils = trpc.useUtils();
  const configuration = trpc.restaurantTax.configuration.useQuery();
  const [selectedId, setSelectedId] = useState('');
  const [customMode, setCustomMode] = useState<'EXCLUSIVE' | 'INCLUSIVE'>('EXCLUSIVE');
  const [previewAmount, setPreviewAmount] = useState('1000.00');
  const [previewRate, setPreviewRate] = useState('');
  const [rateErrors, setRateErrors] = useState<RateErrors>({});
  const idempotencyKey = useRef(browserUuid());
  const selected = useMemo(
    () => configuration.data?.profiles.find((profile) => profile.id === selectedId),
    [configuration.data, selectedId]
  );
  const unavailableProfiles = useMemo(
    () => configuration.data?.profiles.filter((profile) => !profile.enabled) ?? [],
    [configuration.data]
  );
  const activation = trpc.restaurantTax.activate.useMutation({
    onSuccess: () => {
      toast.success('Tax profile activated.');
      idempotencyKey.current = browserUuid();
      void utils.restaurantTax.configuration.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const customPublication = trpc.restaurantTax.publishCustom.useMutation({
    onSuccess: () => {
      toast.success('Customer-supplied tax profile published.');
      idempotencyKey.current = browserUuid();
      void utils.restaurantTax.configuration.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const submitCustom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsedRates = paymentCategories.map((paymentCategory) => ({
      paymentCategory,
      parsed: parsePercentage(String(data.get(`rate${paymentCategory}`) ?? '')),
    }));
    const nextRateErrors = Object.fromEntries(
      parsedRates
        .filter(({ parsed }) => parsed.error)
        .map(({ paymentCategory, parsed }) => [paymentCategory, parsed.error])
    ) as RateErrors;
    setRateErrors(nextRateErrors);
    if (Object.keys(nextRateErrors).length) return;
    if (data.get('accountantConfirmation') !== 'on') return;
    customPublication.mutate({
      branchId: String(data.get('customBranchId') ?? ''),
      profileName: String(data.get('profileName') ?? ''),
      jurisdictionCode: String(data.get('jurisdictionCode')) as
        'PK-PB' | 'PK-SD' | 'PK-KP' | 'PK-ICT' | 'PK-BA',
      effectiveFrom: String(data.get('customEffectiveFrom') ?? ''),
      effectiveTo: String(data.get('customEffectiveTo') ?? '') || undefined,
      priceMode: customMode,
      rates: parsedRates.map(({ paymentCategory, parsed }) => ({
        paymentCategory,
        rate: parsed.decimal!,
      })),
      approvalReference: String(data.get('customApprovalReference') ?? ''),
      accountantConfirmation: true,
      replaceOpenProfile: data.get('replaceOpenProfile') === 'on',
      idempotencyKey: idempotencyKey.current,
    });
  };

  const amount = Number(previewAmount) || 0;
  const parsedPreviewRate = parsePercentage(previewRate);
  const rate = parsedPreviewRate.decimal;
  const preview = trpc.restaurantTax.previewCustom.useQuery(
    { amount: previewAmount, rate: rate ?? '0', priceMode: customMode },
    { enabled: amount >= 0 && rate !== undefined }
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected?.enabled) return;
    const data = new FormData(event.currentTarget);
    activation.mutate({
      branchId: String(data.get('branchId') ?? ''),
      profileId: selected.id,
      effectiveFrom: String(data.get('effectiveFrom') ?? ''),
      approvalReference: String(data.get('approvalReference') ?? '').trim(),
      accountantConfirmation: data.get('accountantConfirmation') === 'on',
      eligibilityConfirmations: selected.eligibilityControls
        .filter((control) => data.get(control.id) === 'on')
        .map((control) => control.id),
      replaceOpenProfile: data.get('replaceOpenPresetProfile') === 'on',
      idempotencyKey: idempotencyKey.current,
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
          <SectionCard
            eyebrow="Fail-closed activation"
            title="Choose a verified profile"
            titleLevel={2}
          >
            <form className="space-y-5" onSubmit={submit}>
              <div className="grid gap-4 md:grid-cols-2">
                <label className={labelClass}>
                  Preset branch
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
                    aria-describedby="unavailable-tax-profiles"
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
                  {unavailableProfiles.length ? (
                    <span
                      id="unavailable-tax-profiles"
                      className="mt-2 block space-y-1 font-sans text-xs font-normal normal-case tracking-normal text-text-muted"
                    >
                      <span className="block font-medium text-text-strong">
                        Unavailable profiles
                      </span>
                      {unavailableProfiles.map((profile) => (
                        <span key={profile.id} className="block">
                          {profile.name}: {profile.disabledReason}
                        </span>
                      ))}
                    </span>
                  ) : null}
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
                  Preset accountant approval reference
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
                  {'tenderNotice' in selected ? (
                    <p className="mt-3 text-sm font-medium text-warning">{selected.tenderNotice}</p>
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
                  name="replaceOpenPresetProfile"
                />
                End the currently open tax profile when this profile starts.
              </label>
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

          <SectionCard
            eyebrow="Customer supplied · Not verified by DevFathom"
            title="Custom tax profile"
          >
            <p className="mb-5 text-sm text-text-muted">
              Enter rates supplied and reviewed by your accountant. DevFathom does not verify these
              rates and this configuration is not legal or tax advice.
            </p>
            <form className="space-y-5" onSubmit={submitCustom}>
              <div className="grid gap-4 md:grid-cols-2">
                <label className={labelClass}>
                  Profile name
                  <Input className="mt-1 min-h-11" name="profileName" required maxLength={120} />
                </label>
                <label className={labelClass}>
                  Branch
                  <select className={selectClass} name="customBranchId" required defaultValue="">
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
                  Pakistan jurisdiction
                  <select className={selectClass} name="jurisdictionCode" required defaultValue="">
                    <option value="" disabled>
                      Select jurisdiction
                    </option>
                    <option value="PK-PB">Punjab</option>
                    <option value="PK-SD">Sindh</option>
                    <option value="PK-KP">Khyber Pakhtunkhwa</option>
                    <option value="PK-ICT">Islamabad Capital Territory</option>
                    <option value="PK-BA">Balochistan</option>
                  </select>
                </label>
                <label className={labelClass}>
                  Price mode
                  <select
                    className={selectClass}
                    name="priceMode"
                    value={customMode}
                    onChange={(event) =>
                      setCustomMode(event.target.value as 'EXCLUSIVE' | 'INCLUSIVE')
                    }
                  >
                    <option value="EXCLUSIVE">Exclusive — add tax</option>
                    <option value="INCLUSIVE">Inclusive — extract tax</option>
                  </select>
                </label>
                <label className={labelClass}>
                  Effective date (branch local)
                  <Input
                    className="mt-1 min-h-11"
                    name="customEffectiveFrom"
                    type="date"
                    required
                  />
                </label>
                <label className={labelClass}>
                  Optional end date (branch local)
                  <Input className="mt-1 min-h-11" name="customEffectiveTo" type="date" />
                </label>
                {paymentCategories.map((category) => (
                  <div key={category}>
                    <label htmlFor={`rate-${category}`} className={labelClass}>
                      {rateLabels[category]}
                    </label>
                    <Input
                      id={`rate-${category}`}
                      className="mt-1 min-h-11"
                      name={`rate${category}`}
                      inputMode="decimal"
                      aria-required="true"
                      aria-invalid={Boolean(rateErrors[category])}
                      aria-describedby={rateErrors[category] ? `rate-${category}-error` : undefined}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (category === 'CASH') setPreviewRate(value);
                        if (rateErrors[category]) {
                          setRateErrors((current) => ({
                            ...current,
                            [category]: parsePercentage(value).error,
                          }));
                        }
                      }}
                      onBlur={(event) =>
                        setRateErrors((current) => ({
                          ...current,
                          [category]: parsePercentage(event.target.value).error,
                        }))
                      }
                      placeholder="15"
                    />
                    {rateErrors[category] ? (
                      <span
                        id={`rate-${category}-error`}
                        role="alert"
                        className="mt-2 block font-sans text-sm font-normal normal-case tracking-normal text-destructive"
                      >
                        {rateErrors[category]}
                      </span>
                    ) : null}
                  </div>
                ))}
                <label className={labelClass}>
                  Accountant approval reference
                  <Input
                    className="mt-1 min-h-11"
                    name="customApprovalReference"
                    required
                    maxLength={240}
                  />
                </label>
              </div>
              <div
                aria-live="polite"
                className="rounded-md border border-border-default bg-surface-sunken p-4 text-sm text-text-strong"
              >
                <p className="font-mono text-xs uppercase text-text-muted">
                  Live calculation preview · Cash
                </p>
                <label className={`${labelClass} mt-3`}>
                  Sample amount
                  <Input
                    className="mt-1 min-h-11"
                    value={previewAmount}
                    onChange={(event) => setPreviewAmount(event.target.value)}
                    inputMode="decimal"
                  />
                </label>
                <p className="mt-3 font-mono tabular-nums">
                  {rate !== undefined && preview.data
                    ? `Net ${preview.data.net} · Tax ${preview.data.tax} · Total ${preview.data.gross} · settled once`
                    : 'Enter a valid sample amount and Cash rate to preview settlement.'}
                </p>
              </div>
              <label className="flex items-start gap-3 text-sm text-text-strong">
                <input
                  className="mt-1 size-4"
                  type="checkbox"
                  name="accountantConfirmation"
                  required
                />
                I confirm these exact rates were supplied/reviewed by my accountant; DevFathom has
                not verified them.
              </label>
              <label className="flex items-start gap-3 text-sm text-text-strong">
                <input className="mt-1 size-4" type="checkbox" name="replaceOpenProfile" />
                Atomically close the current open profile at this profile’s start time and replace
                it.
              </label>
              <Button type="submit" disabled={customPublication.isPending}>
                {customPublication.isPending ? 'Publishing…' : 'Publish custom profile'}
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
                      Effective{' '}
                      {formatDate(new Date(profile.effectiveFrom), profile.branch.timezone)} ·{' '}
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
