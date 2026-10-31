'use client';

/**
 * PROP-01 — the property settings form.
 *
 * Built from the same primitives as the pharmacy settings surfaces
 * (`SectionCard`, `Input`, `Button`) and following the same three rules:
 *
 * - **No raw identifiers.** The mode is a named choice with a sentence of
 *   explanation, never a bare enum value (UX rule 1).
 * - **Errors land on fields.** The server publishes a rejection as
 *   `data.validation[field]`; every one of those names is a name in this form,
 *   so the message appears under the input and the input is marked
 *   `aria-invalid` (UX rule 11).
 * - **Nothing is a dead end.** The outstanding onboarding steps are listed with
 *   the reason each is outstanding, rather than one sentence saying "not ready"
 *   (UX rule 13).
 *
 * The mode is saved by its own mutation, because MODE-01 makes it a decision
 * about how the property operates rather than one field of a settings save.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { useSession } from 'next-auth/react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type PropertyView = inferRouterOutputs<AppRouter>['hotelProperty']['get'];

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';

function Field({
  children,
  error,
  hint,
  htmlFor,
  label,
}: {
  children: React.ReactNode;
  error?: string;
  hint?: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="min-w-0">
      <label className={labelClass} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-sm text-destructive" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-text-muted" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function validationErrors(error: unknown): Record<string, string> {
  const validation = (error as { data?: { validation?: unknown } } | null)?.data?.validation;
  if (!validation || typeof validation !== 'object') return {};
  return Object.fromEntries(
    Object.entries(validation as Record<string, unknown>).map(([field, message]) => [
      field,
      Array.isArray(message) ? String(message[0]) : String(message),
    ])
  );
}

type PropertySelection = { branchId: string; organizationId: string; userId: string };

function ReloadPropertySettings() {
  return (
    <SectionCard title="Choose a property again" titleLevel={2}>
      <p className="text-sm text-text-muted">
        Your session or property access changed. Choose a property you can manage to continue.
      </p>
      <a
        href="/hotel/settings/property"
        className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
      >
        Choose a property
      </a>
    </SectionCard>
  );
}

function matchesSelection(view: PropertyView, selection: PropertySelection) {
  return (
    view.property?.branchId === selection.branchId &&
    view.property.organizationId === selection.organizationId
  );
}

export function HotelPropertySettingsForm({
  initial,
  selection,
}: {
  initial: PropertyView;
  selection: PropertySelection;
}) {
  const { data: session } = useSession();
  if (
    session?.user.id !== selection.userId ||
    session.user.organizationId !== selection.organizationId ||
    !matchesSelection(initial, selection)
  ) {
    return <ReloadPropertySettings />;
  }
  return (
    <SelectedPropertySettings
      key={JSON.stringify([selection.organizationId, selection.userId, selection.branchId])}
      initial={initial}
      selection={selection}
    />
  );
}

function SelectedPropertySettings({
  initial,
  selection,
}: {
  initial: PropertyView;
  selection: PropertySelection;
}) {
  const { branchId } = selection;
  const [view, setView] = useState<PropertyView>(initial);
  // Values and revision advance together only after our save or explicit discard.
  // Mode/background refreshes must never rebase a still-visible facts draft.
  const [factsSnapshot, setFactsSnapshot] = useState(initial.property);
  const [factsVersion, setFactsVersion] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const mounted = useRef(false);
  const refreshGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
    };
  }, []);

  const accessDenied = (error: unknown) => {
    const code = (error as { data?: { code?: string } } | null)?.data?.code;
    return code === 'FORBIDDEN' || code === 'UNAUTHORIZED' || code === 'NOT_FOUND';
  };

  const utils = trpc.useUtils();
  const refresh = async (discardFacts = false) => {
    if (!mounted.current) return;
    const generation = ++refreshGeneration.current;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const next = await utils.hotelProperty.get.fetch({ branchId }, { staleTime: 0 });
      if (!mounted.current || generation !== refreshGeneration.current) return;
      if (!matchesSelection(next, selection)) {
        setUnavailable(true);
        return;
      }
      setView(next);
      if (discardFacts) {
        setFactsSnapshot(next.property);
        setFactsVersion((version) => version + 1);
        setErrors({});
      }
    } catch (error) {
      if (!mounted.current || generation !== refreshGeneration.current) return;
      if (accessDenied(error)) setUnavailable(true);
      else setRefreshFailed(true);
      setSaved(null);
    } finally {
      if (mounted.current && generation === refreshGeneration.current) setRefreshing(false);
    }
  };

  const onError = (error: unknown, field: 'form' | 'mode') => {
    if (!mounted.current) return;
    if (accessDenied(error)) setUnavailable(true);
    if ((error as { data?: { code?: string } } | null)?.data?.code === 'CONFLICT') {
      setSaved(null);
      setErrors({
        [field]:
          'These settings changed elsewhere. Your edits are kept. Reload and review the latest values before saving again.',
      });
      return;
    }
    const fields = validationErrors(error);
    setSaved(null);
    setErrors(
      Object.keys(fields).length
        ? fields
        : { [field]: 'Could not save this change. Review your values and try again.' }
    );
  };

  const update = trpc.hotelProperty.update.useMutation({
    onSuccess: (result) => {
      if (!mounted.current) return;
      setErrors({});
      setSaved(result.activationSummary);
      void refresh(true);
    },
    onError: (error) => onError(error, 'form'),
  });

  const setMode = trpc.hotelProperty.modes.set.useMutation({
    onSuccess: () => {
      if (!mounted.current) return;
      setErrors({});
      setSaved(null);
      void refresh();
    },
    onError: (error) => onError(error, 'mode'),
  });

  const busy = update.isPending || setMode.isPending || refreshing;
  if (unavailable) return <ReloadPropertySettings />;
  const property = view.property;
  if (!property || !factsSnapshot) {
    return <ReloadPropertySettings />;
  }

  const fieldProps = (name: string, hint = false) => ({
    'aria-invalid': Boolean(errors[name]),
    'aria-describedby': errors[name] ? `${name}-error` : hint ? `${name}-hint` : undefined,
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const star = text('starCategory');
    const taxProfileId = text('taxProfileId');
    update.mutate({
      branchId,
      expectedUpdatedAt: factsSnapshot.updatedAt,
      name: text('name'),
      addressLine: text('addressLine'),
      city: text('city'),
      timezone: text('timezone'),
      starCategory: star ? Number(star) : null,
      checkInTime: text('checkInTime'),
      checkOutTime: text('checkOutTime'),
      auditTime: text('auditTime'),
      currency: text('currency'),
      taxProfileId: taxProfileId || null,
      languages: text('languages')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      bookingEngineSlug: text('bookingEngineSlug'),
    });
  };

  return (
    <div className="space-y-6">
      <SectionCard title={property.name} titleLevel={2}>
        <a
          href="/hotel/settings/property"
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
        >
          Change property
        </a>
        <Button
          variant="outline"
          className="ml-2 min-h-11"
          onClick={() => void refresh(true)}
          disabled={busy}
        >
          Reload and discard edits
        </Button>
        {refreshing ? (
          <p className="mt-3 text-sm text-text-muted" role="status">
            Refreshing property settings…
          </p>
        ) : refreshFailed ? (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-destructive" role="alert">
              Could not refresh property settings. Retry to confirm the latest saved values.
            </p>
            <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
              Refresh property settings
            </Button>
          </div>
        ) : null}
      </SectionCard>
      <SectionCard title="Setup steps" titleLevel={2}>
        <p className="text-sm text-text-body">{view.activationSummary}</p>
        <ul className="mt-3 space-y-2">
          {view.checklist.items.map((item) => (
            <li
              key={item.key}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 border-border-strong pl-3"
            >
              <StatusPill status={item.state === 'DONE' ? 'Done' : 'Needs you'} />
              <span className="text-sm font-semibold text-text-strong">{item.label}</span>
              <span className="w-full text-xs text-text-muted">{item.why}</span>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="How this property operates" titleLevel={2}>
        <fieldset className="space-y-2" disabled={busy}>
          <legend className="sr-only">Property mode</legend>
          {view.modeOptions.map((option) => (
            <label key={option.value} className="flex gap-3 text-sm text-text-body">
              <input
                type="radio"
                name="mode"
                value={option.value}
                checked={property.mode === option.value}
                onChange={() => {
                  if (!busy)
                    setMode.mutate({
                      branchId,
                      mode: option.value,
                      expectedUpdatedAt: property.updatedAt,
                    });
                }}
                className="mt-1"
              />
              <span>
                <span className="font-semibold text-text-strong">{option.label}</span>
                <span className="block text-xs text-text-muted">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {errors.mode ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {errors.mode}
          </p>
        ) : (
          <p className="mt-2 text-xs text-text-muted">
            The mode selects this property&rsquo;s defaults. Any mode can still enable any feature
            your package includes.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Property facts" titleLevel={2}>
        <form key={factsVersion} onSubmit={onSubmit} aria-label="Property facts">
          <fieldset className="grid gap-4 sm:grid-cols-2" disabled={busy}>
            <legend className="sr-only">Property facts</legend>
            <Field htmlFor="name" label="Property name" error={errors.name}>
              <Input
                id="name"
                name="name"
                {...fieldProps('name')}
                defaultValue={factsSnapshot.name}
                required
              />
            </Field>
            <Field htmlFor="addressLine" label="Address" error={errors.addressLine}>
              <Input
                id="addressLine"
                name="addressLine"
                {...fieldProps('addressLine')}
                defaultValue={factsSnapshot.addressLine}
                required
              />
            </Field>
            <Field htmlFor="city" label="City" error={errors.city}>
              <Input
                id="city"
                name="city"
                {...fieldProps('city')}
                defaultValue={factsSnapshot.city}
                required
              />
            </Field>
            <Field
              htmlFor="timezone"
              label="Timezone"
              error={errors.timezone}
              hint="The zone this property dates its business days and audits in."
            >
              <Input
                id="timezone"
                name="timezone"
                {...fieldProps('timezone', true)}
                defaultValue={factsSnapshot.timezone}
                required
              />
            </Field>
            <Field
              htmlFor="starCategory"
              label="Star category"
              error={errors.starCategory}
              hint="Leave empty while the property is unrated."
            >
              <Input
                id="starCategory"
                name="starCategory"
                {...fieldProps('starCategory', true)}
                type="number"
                min={1}
                max={7}
                defaultValue={factsSnapshot.starCategory ?? ''}
              />
            </Field>
            <Field
              htmlFor="currency"
              label="Currency"
              error={errors.currency}
              hint="Three-letter code. Settlement is PKR."
            >
              <Input
                id="currency"
                name="currency"
                {...fieldProps('currency', true)}
                defaultValue={factsSnapshot.currency}
                required
              />
            </Field>
            <Field
              htmlFor="checkInTime"
              label="Check-in time"
              error={errors.checkInTime}
              hint="Use 24-hour time, e.g. 14:00."
            >
              <Input
                id="checkInTime"
                name="checkInTime"
                {...fieldProps('checkInTime', true)}
                defaultValue={factsSnapshot.checkInTime}
                required
              />
            </Field>
            <Field
              htmlFor="checkOutTime"
              label="Check-out time"
              error={errors.checkOutTime}
              hint="Use 24-hour time, e.g. 12:00."
            >
              <Input
                id="checkOutTime"
                name="checkOutTime"
                {...fieldProps('checkOutTime', true)}
                defaultValue={factsSnapshot.checkOutTime}
                required
              />
            </Field>
            <Field
              htmlFor="auditTime"
              label="Night audit time"
              error={errors.auditTime}
              hint="When the audit rolls the business date."
            >
              <Input
                id="auditTime"
                name="auditTime"
                {...fieldProps('auditTime', true)}
                defaultValue={factsSnapshot.auditTime}
                required
              />
            </Field>
            <Field
              htmlFor="taxProfileId"
              label="Tax profile"
              error={errors.taxProfileId}
              hint="Every folio charge is taxed from this profile. No property goes live without one."
            >
              <Input
                id="taxProfileId"
                name="taxProfileId"
                {...fieldProps('taxProfileId', true)}
                defaultValue={factsSnapshot.taxProfileId ?? ''}
              />
            </Field>
            <Field
              htmlFor="languages"
              label="Languages"
              error={errors.languages}
              hint="Comma separated, e.g. en, ur."
            >
              <Input
                id="languages"
                name="languages"
                {...fieldProps('languages', true)}
                defaultValue={factsSnapshot.languages.join(', ')}
                required
              />
            </Field>
            <Field
              htmlFor="bookingEngineSlug"
              label="Booking page address"
              error={errors.bookingEngineSlug}
              hint="Lowercase letters, numbers and hyphens. Guests see this in the direct booking link."
            >
              <Input
                id="bookingEngineSlug"
                name="bookingEngineSlug"
                {...fieldProps('bookingEngineSlug', true)}
                defaultValue={factsSnapshot.bookingEngineSlug}
                required
              />
            </Field>
            <div className="sm:col-span-2">
              {errors.form ? (
                <p className="mb-2 text-sm text-destructive" role="alert">
                  {errors.form}
                </p>
              ) : saved ? (
                <p className="mb-2 text-sm text-text-muted" role="status">
                  {saved}
                </p>
              ) : null}
              <Button type="submit" disabled={busy}>
                {update.isPending ? 'Saving…' : 'Save property'}
              </Button>
            </div>
          </fieldset>
        </form>
      </SectionCard>
    </div>
  );
}
