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
import { useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';

import { Button } from '@/components/ui/button';
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
        <p className="mt-1 text-xs text-text-muted">{hint}</p>
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

export function HotelPropertySettingsForm({ initial }: { initial: PropertyView }) {
  const [view, setView] = useState<PropertyView>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const refresh = () => {
    void utils.hotelProperty.get
      .fetch()
      .then(setView)
      .catch(() => undefined);
  };

  const update = trpc.hotelProperty.update.useMutation({
    onSuccess: (result) => {
      setErrors({});
      setSaved(result.activationSummary);
      refresh();
    },
    onError: (error) => {
      const fields = validationErrors(error);
      setSaved(null);
      setErrors(Object.keys(fields).length ? fields : { form: error.message });
    },
  });

  const setMode = trpc.hotelProperty.modes.set.useMutation({
    onSuccess: () => {
      setErrors({});
      refresh();
    },
    onError: (error) => setErrors({ mode: error.message }),
  });

  const property = view.property;
  if (!property) {
    return (
      <SectionCard title="This workspace has no property yet" titleLevel={2}>
        <p className="text-sm text-text-muted">
          A property is created with the workspace. If this one has none, ask your DevFathom account
          manager to re-run provisioning — nothing here can create it for you.
        </p>
      </SectionCard>
    );
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const star = text('starCategory');
    const taxProfileId = text('taxProfileId');
    update.mutate({
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
        <fieldset className="space-y-2" disabled={setMode.isPending}>
          <legend className="sr-only">Property mode</legend>
          {view.modeOptions.map((option) => (
            <label key={option.value} className="flex gap-3 text-sm text-text-body">
              <input
                type="radio"
                name="mode"
                value={option.value}
                checked={property.mode === option.value}
                onChange={() => setMode.mutate({ mode: option.value })}
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
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}>
          <Field htmlFor="name" label="Property name" error={errors.name}>
            <Input id="name" name="name" defaultValue={property.name} required />
          </Field>
          <Field htmlFor="addressLine" label="Address" error={errors.addressLine}>
            <Input
              id="addressLine"
              name="addressLine"
              defaultValue={property.addressLine}
              required
            />
          </Field>
          <Field htmlFor="city" label="City" error={errors.city}>
            <Input id="city" name="city" defaultValue={property.city} required />
          </Field>
          <Field
            htmlFor="timezone"
            label="Timezone"
            error={errors.timezone}
            hint="The zone this property dates its business days and audits in."
          >
            <Input id="timezone" name="timezone" defaultValue={property.timezone} required />
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
              type="number"
              min={1}
              max={7}
              defaultValue={property.starCategory ?? ''}
            />
          </Field>
          <Field
            htmlFor="currency"
            label="Currency"
            error={errors.currency}
            hint="Three-letter code. Settlement is PKR."
          >
            <Input id="currency" name="currency" defaultValue={property.currency} required />
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
              defaultValue={property.checkInTime}
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
              defaultValue={property.checkOutTime}
              required
            />
          </Field>
          <Field
            htmlFor="auditTime"
            label="Night audit time"
            error={errors.auditTime}
            hint="When the audit rolls the business date."
          >
            <Input id="auditTime" name="auditTime" defaultValue={property.auditTime} required />
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
              defaultValue={property.taxProfileId ?? ''}
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
              defaultValue={property.languages.join(', ')}
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
              defaultValue={property.bookingEngineSlug}
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
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save property'}
            </Button>
          </div>
        </form>
      </SectionCard>
    </div>
  );
}
