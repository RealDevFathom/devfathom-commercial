'use client';

/**
 * PROP-07 — the function spaces panel.
 *
 * Built from the same primitives as the property settings form and following the
 * same three rules:
 *
 * - **No raw identifiers.** A space is named, its layouts are named with their
 *   capacities, and its buffers are described in minutes (UX rule 1).
 * - **Errors land on fields.** The server publishes a rejection as
 *   `data.validation[field]`; every one of those names is a name in this form, so
 *   the message appears under the input and the input is marked `aria-invalid`
 *   (UX rule 11).
 * - **Nothing is a dead end.** A buffer change refused because it would collide
 *   existing bookings says so, in the sentence the router produced (UX rule 13).
 *
 * Deliberately minimal: no diary, no calendar. What is booked in a space is the
 * banquet lane's surface (H6); this one owns the space and its turnaround times.
 */
import {
  cloneElement,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactElement,
} from 'react';
import type { inferRouterOutputs } from '@trpc/server';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type SpacesView = inferRouterOutputs<AppRouter>['hotelProperty']['spaces']['list'];
type SpaceView = SpacesView['spaces'][number];

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';

function Field({
  children,
  error,
  hint,
  htmlFor,
  label,
}: {
  children: ReactElement<ComponentProps<typeof Input>>;
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
      {cloneElement(children, {
        'aria-invalid': Boolean(error),
        'aria-describedby': error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined,
        className: 'min-h-11',
      })}
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

/**
 * `Theatre 300, Banquet 220` — one line an operator can type and read back. The
 * pack's `[{layout, capacity}]` is the storage shape, not something to make anyone
 * write as JSON.
 */
export function parseLayouts(value: string): { layout: string; capacity: number }[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(.*?)[\s:]+(\d+)$/.exec(entry);
      return match
        ? { layout: match[1]!.trim(), capacity: Number(match[2]) }
        : { layout: entry, capacity: 0 };
    });
}

export function formatLayouts(layouts: SpaceView['layouts']): string {
  return layouts.map((entry) => `${entry.layout} ${entry.capacity}`).join(', ');
}

/** PKR minor units in, rupees out. Money is never a float on the way in. */
function rupees(minor: number | undefined): string {
  if (minor === undefined) return '—';
  return `PKR ${(minor / 100).toLocaleString('en-PK', { minimumFractionDigits: 2 })}`;
}

function optionalMinor(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Math.round(Number(trimmed) * 100);
}

export function HotelFunctionSpacesPanel({ initial }: { initial: SpacesView }) {
  const [view, setView] = useState<SpacesView>(initial);
  const [formErrors, setErrors] = useState<Record<string, string>>({});
  const [errorTarget, setErrorTarget] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const createForm = useRef<HTMLFormElement>(null);

  const utils = trpc.useUtils();
  const refresh = async () => {
    setRefreshing(true);
    try {
      // A successful mutation must be reflected immediately, even while the
      // provider's 60-second query cache would otherwise count as fresh.
      setView(await utils.hotelProperty.spaces.list.fetch(undefined, { staleTime: 0 }));
      setRefreshError(false);
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  };

  const onError = (error: { message: string }, target: string) => {
    const fields = validationErrors(error);
    setErrorTarget(target);
    setErrors(Object.keys(fields).length ? fields : { form: error.message });
  };
  const onSuccess = () => {
    setErrors({});
    setErrorTarget(null);
    setEditing(null);
    setRetiring(null);
    return refresh();
  };

  const create = trpc.hotelProperty.spaces.create.useMutation({
    onSuccess: () => {
      createForm.current?.reset();
      return onSuccess();
    },
    onError: (error) => onError(error, 'new'),
  });
  const update = trpc.hotelProperty.spaces.update.useMutation({
    onSuccess,
    onError: (error, variables) => onError(error, variables.id),
  });
  const deactivate = trpc.hotelProperty.spaces.deactivate.useMutation({
    onSuccess,
    onError: (error, variables) => onError(error, variables.spaceId),
  });

  const submit = (event: FormEvent<HTMLFormElement>, space: SpaceView | null) => {
    event.preventDefault();
    if (pending) return;
    setErrors({});
    setErrorTarget(null);
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const payload = {
      name: text('name'),
      nameUr: text('nameUr') || null,
      layouts: parseLayouts(text('layouts')),
      pricing: {
        hourlyMinor: optionalMinor(text('hourly')),
        dailyMinor: optionalMinor(text('daily')),
        perFunctionMinor: optionalMinor(text('perFunction')),
        minimumSpendMinor: optionalMinor(text('minimumSpend')),
      },
      setupMinutes: Number(text('setupMinutes') || 0),
      teardownMinutes: Number(text('teardownMinutes') || 0),
      active: space?.active ?? true,
    };
    if (space) update.mutate({ ...payload, id: space.id });
    else create.mutate(payload);
  };

  const pending =
    create.isPending || update.isPending || deactivate.isPending || refreshing || refreshError;

  const fields = (space: SpaceView | null) => {
    const errors = errorTarget === (space?.id ?? 'new') ? formErrors : {};
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field htmlFor={`name-${space?.id ?? 'new'}`} label="Space name" error={errors.name}>
          <Input
            id={`name-${space?.id ?? 'new'}`}
            name="name"
            defaultValue={space?.name ?? ''}
            required
          />
        </Field>
        <Field
          htmlFor={`nameUr-${space?.id ?? 'new'}`}
          label="Name (Urdu)"
          error={errors.nameUr}
          hint="Optional. Shown wherever the property publishes in Urdu."
        >
          <Input
            id={`nameUr-${space?.id ?? 'new'}`}
            name="nameUr"
            defaultValue={space?.nameUr ?? ''}
            dir="rtl"
          />
        </Field>
        <Field
          htmlFor={`layouts-${space?.id ?? 'new'}`}
          label="Layouts and capacities"
          error={errors.layouts}
          hint="One per comma, e.g. Theatre 300, Banquet 220, U-shape 60."
        >
          <Input
            id={`layouts-${space?.id ?? 'new'}`}
            name="layouts"
            defaultValue={space ? formatLayouts(space.layouts) : ''}
            required
          />
        </Field>
        <Field
          htmlFor={`setupMinutes-${space?.id ?? 'new'}`}
          label="Setup minutes"
          error={errors.setupMinutes}
          hint="Held before every booking. Nothing else can use the space then."
        >
          <Input
            id={`setupMinutes-${space?.id ?? 'new'}`}
            name="setupMinutes"
            type="number"
            min={0}
            max={1440}
            defaultValue={space?.setupMinutes ?? 0}
          />
        </Field>
        <Field
          htmlFor={`teardownMinutes-${space?.id ?? 'new'}`}
          label="Teardown minutes"
          error={errors.teardownMinutes}
          hint="Held after every booking, for clearing and cleaning."
        >
          <Input
            id={`teardownMinutes-${space?.id ?? 'new'}`}
            name="teardownMinutes"
            type="number"
            min={0}
            max={1440}
            defaultValue={space?.teardownMinutes ?? 0}
          />
        </Field>
        <Field
          htmlFor={`hourly-${space?.id ?? 'new'}`}
          label="Hourly rate (PKR)"
          error={errors.pricing}
        >
          <Input
            id={`hourly-${space?.id ?? 'new'}`}
            name="hourly"
            type="number"
            min={0}
            step="0.01"
            defaultValue={
              space?.pricing.hourlyMinor === undefined ? '' : space.pricing.hourlyMinor / 100
            }
          />
        </Field>
        <Field
          htmlFor={`daily-${space?.id ?? 'new'}`}
          label="Daily rate (PKR)"
          error={errors.pricing}
        >
          <Input
            id={`daily-${space?.id ?? 'new'}`}
            name="daily"
            type="number"
            min={0}
            step="0.01"
            defaultValue={
              space?.pricing.dailyMinor === undefined ? '' : space.pricing.dailyMinor / 100
            }
          />
        </Field>
        <Field
          htmlFor={`perFunction-${space?.id ?? 'new'}`}
          label="Per function (PKR)"
          error={errors.pricing}
        >
          <Input
            id={`perFunction-${space?.id ?? 'new'}`}
            name="perFunction"
            type="number"
            min={0}
            step="0.01"
            defaultValue={
              space?.pricing.perFunctionMinor === undefined
                ? ''
                : space.pricing.perFunctionMinor / 100
            }
          />
        </Field>
        <Field
          htmlFor={`minimumSpend-${space?.id ?? 'new'}`}
          label="Minimum spend (PKR)"
          error={errors.pricing}
          hint="What an event must reach before the space is released at this price."
        >
          <Input
            id={`minimumSpend-${space?.id ?? 'new'}`}
            name="minimumSpend"
            type="number"
            min={0}
            step="0.01"
            defaultValue={
              space?.pricing.minimumSpendMinor === undefined
                ? ''
                : space.pricing.minimumSpendMinor / 100
            }
          />
        </Field>
      </div>
    );
  };

  const formError = (target: string) =>
    errorTarget === target && formErrors.form ? (
      <p className="text-sm text-destructive" role="alert">
        {formErrors.form}
      </p>
    ) : null;

  return (
    <div className="space-y-6">
      <SectionCard title="Spaces" titleLevel={2}>
        {refreshing ? (
          <p className="mb-3 text-sm text-text-muted" role="status">
            Refreshing spaces…
          </p>
        ) : null}
        {refreshError ? (
          <div className="mb-4 space-y-2">
            <p className="text-sm text-destructive" role="alert">
              Your change was saved, but the list could not be refreshed. Refresh the list before
              making another change.
            </p>
            <Button
              type="button"
              className="min-h-11"
              variant="outline"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              Retry refresh
            </Button>
          </div>
        ) : null}
        {view.spaces.length === 0 ? (
          <p className="text-sm text-text-muted">
            This property has no function spaces yet. Add the first one below — a space needs at
            least one layout and its capacity before it can be sold.
          </p>
        ) : (
          <ul className="space-y-3">
            {view.spaces.map((space) =>
              editing === space.id ? (
                <li key={space.id} className="border-l-2 border-border-strong pl-3">
                  <form
                    aria-label={`Edit ${space.name}`}
                    onSubmit={(event) => submit(event, space)}
                    aria-busy={update.isPending}
                  >
                    <fieldset className="min-w-0 space-y-4" disabled={pending}>
                      {fields(space)}
                      {formError(space.id)}
                      <div className="flex flex-wrap gap-2">
                        <Button className="min-h-11" type="submit" disabled={pending}>
                          {update.isPending ? 'Saving…' : 'Save space'}
                        </Button>
                        <Button
                          className="min-h-11"
                          type="button"
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            setEditing(null);
                            setErrors({});
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </fieldset>
                  </form>
                </li>
              ) : (
                <li
                  key={space.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 border-border-strong pl-3"
                >
                  <StatusPill status={space.active ? 'Active' : 'Retired'} />
                  <span className="text-sm font-semibold text-text-strong">{space.name}</span>
                  <span className="text-xs text-text-muted">
                    {space.layouts
                      .map((layout) => `${layout.layout} ${layout.capacity}`)
                      .join(' · ')}
                  </span>
                  <span className="w-full text-xs text-text-muted">
                    Turnaround {space.setupMinutes} min before, {space.teardownMinutes} min after ·
                    hourly {rupees(space.pricing.hourlyMinor)} · per function{' '}
                    {rupees(space.pricing.perFunctionMinor)}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Button
                      className="min-h-11"
                      type="button"
                      variant="outline"
                      disabled={pending || retiring !== null}
                      onClick={() => {
                        setEditing(space.id);
                        setErrors({});
                      }}
                    >
                      Edit
                    </Button>
                    {space.active && retiring !== space.id ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={pending || retiring !== null}
                        onClick={() => {
                          setRetiring(space.id);
                          setErrors({});
                        }}
                      >
                        Retire
                      </Button>
                    ) : null}
                  </span>
                  {retiring === space.id ? (
                    <div
                      className="w-full space-y-2 pt-2"
                      role="group"
                      aria-label={`Retire ${space.name}`}
                      aria-describedby={`retire-${space.id}`}
                      aria-busy={deactivate.isPending}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && !pending) {
                          setRetiring(null);
                          setErrors({});
                        }
                      }}
                    >
                      <p id={`retire-${space.id}`} className="text-sm text-text-body">
                        Retire {space.name}? Its status will change to Retired. Existing bookings
                        are kept.
                      </p>
                      {formError(space.id)}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          className="min-h-11"
                          type="button"
                          variant="destructive"
                          disabled={pending}
                          onClick={() => {
                            setErrors({});
                            deactivate.mutate({ spaceId: space.id });
                          }}
                        >
                          {deactivate.isPending ? 'Retiring…' : 'Confirm retirement'}
                        </Button>
                        <Button
                          className="min-h-11"
                          type="button"
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            setRetiring(null);
                            setErrors({});
                          }}
                        >
                          Keep space active
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            )}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Add a function space" titleLevel={2}>
        <form
          ref={createForm}
          aria-label="Add a function space"
          onSubmit={(event) => submit(event, null)}
          aria-busy={create.isPending}
        >
          <fieldset
            className="min-w-0 space-y-4"
            disabled={pending || editing !== null || retiring !== null}
          >
            {fields(null)}
            <div>
              {formError('new')}
              <Button
                className="min-h-11"
                type="submit"
                disabled={pending || editing !== null || retiring !== null}
              >
                {create.isPending ? 'Adding…' : 'Add space'}
              </Button>
            </div>
          </fieldset>
        </form>
      </SectionCard>
    </div>
  );
}
