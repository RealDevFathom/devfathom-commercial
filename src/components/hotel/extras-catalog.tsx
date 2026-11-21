'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

/**
 * PROP-05 — the extras and services catalog surface.
 *
 * Deliberately minimal: a list of what this property charges, and one form to
 * add or change an item. It follows the same three rules as the property
 * settings form:
 *
 * - **No raw identifiers.** Departments and recurrences are named choices, and
 *   money is shown in rupees even though it is stored in paisa (UX rule 1).
 * - **Errors land on fields.** The server publishes rejections as
 *   `data.validation[field]` — including the two rules the input types cannot
 *   express, a taken code and an offer price on a non-upsellable item — so each
 *   message appears under the input it belongs to (UX rule 11).
 * - **Nothing is a dead end.** An empty catalog says what to add first, and a
 *   retired item is still listed with a way to bring it back (UX rule 13).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { useSession } from 'next-auth/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type CatalogView = inferRouterOutputs<AppRouter>['hotelProperty']['extras']['list'];
type CatalogItem = CatalogView['extras'][number];

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

/** Paisa in, rupees out. The catalog stores minor units and shows major ones. */
function rupees(minor: number): string {
  return (minor / 100).toFixed(2);
}

function paisa(major: string): number {
  return Math.round(Number(major) * 100);
}

type CatalogSelection = { branchId: string; organizationId: string; userId: string };

export function HotelExtrasCatalog({
  initial,
  selection,
}: {
  initial: CatalogView;
  selection: CatalogSelection;
}) {
  const { data: session } = useSession();
  if (
    session?.user.id !== selection.userId ||
    session.user.organizationId !== selection.organizationId
  ) {
    return (
      <SectionCard title="Reload this catalog" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Your signed-in identity changed. Choose a property again to continue.
        </p>
        <a
          href="/hotel/settings/extras"
          className="mt-3 inline-flex min-h-11 items-center underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Choose a property
        </a>
      </SectionCard>
    );
  }
  return (
    <SelectedCatalog
      key={`${selection.organizationId}:${selection.userId}:${selection.branchId}`}
      initial={initial}
      branchId={selection.branchId}
    />
  );
}

function SelectedCatalog({ initial, branchId }: { initial: CatalogView; branchId: string }) {
  const [view, setView] = useState<CatalogView>(initial);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [upsellable, setUpsellable] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  const errorCode = (error: unknown) => (error as { data?: { code?: string } } | null)?.data?.code;
  const accessDenied = (error: unknown) =>
    ['FORBIDDEN', 'UNAUTHORIZED'].includes(errorCode(error) ?? '');

  const utils = trpc.useUtils();
  const refresh = async (withInactive = includeInactive) => {
    if (!mounted.current) return;
    const request = ++generation.current;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const next = await utils.hotelProperty.extras.list.fetch(
        {
          branchId,
          includeInactive: withInactive,
          upsellableOnly: false,
        },
        { staleTime: 0 }
      );
      if (mounted.current && request === generation.current) setView(next);
    } catch (error) {
      if (!mounted.current || request !== generation.current) return;
      if (accessDenied(error) || errorCode(error) === 'NOT_FOUND') setUnavailable(true);
      else setRefreshFailed(true);
    } finally {
      if (mounted.current && request === generation.current) setRefreshing(false);
    }
  };

  const onError = (error: { message: string }) => {
    if (!mounted.current) return;
    if (accessDenied(error)) setUnavailable(true);
    const fields = validationErrors(error);
    setSaved(null);
    setErrors(
      errorCode(error) === 'CONFLICT'
        ? {
            form: 'This charge changed elsewhere. Your edits are kept. Cancel and reopen the refreshed charge to review the latest values.',
          }
        : errorCode(error) === 'NOT_FOUND'
          ? {
              form: 'This charge is no longer available. Refresh the catalog and choose a charge again.',
            }
          : Object.keys(fields).length
            ? fields
            : { form: error.message }
    );
  };

  const startEditing = (extra: CatalogItem | null) => {
    setFormVersion((version) => version + 1);
    setEditing(extra);
    setUpsellable(extra?.upsellable ?? false);
    setErrors({});
    setSaved(null);
  };

  const create = trpc.hotelProperty.extras.create.useMutation({
    onSuccess: (result) => {
      if (!mounted.current) return;
      setErrors({});
      startEditing(null);
      setSaved(`${result.extra.name} is now in the catalog.`);
      void refresh();
    },
    onError,
  });

  const update = trpc.hotelProperty.extras.update.useMutation({
    onSuccess: () => {
      if (!mounted.current) return;
      setErrors({});
      startEditing(null);
      setSaved('Saved.');
      void refresh();
    },
    onError,
  });

  const setActive = trpc.hotelProperty.extras.setActive.useMutation({
    onSuccess: (result) => {
      if (!mounted.current) return;
      setErrors({});
      setSaved(result.active ? 'Back in the catalog.' : 'Retired. Past charges keep their name.');
      void refresh();
    },
    onError,
  });

  const pending = create.isPending || update.isPending || setActive.isPending;
  const busy = pending || refreshing;
  const fieldProps = (name: string, hasHint = true) => ({
    'aria-invalid': Boolean(errors[name]),
    'aria-describedby': errors[name] ? `${name}-error` : hasHint ? `${name}-hint` : undefined,
    disabled: busy,
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setSaved(null);
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const offer = text('upsellPriceMinor');
    const fields = {
      branchId,
      code: text('code'),
      name: text('name'),
      nameUr: text('nameUr') || null,
      priceMinor: paisa(text('priceMinor') || '0'),
      taxClass: text('taxClass'),
      department: text('department') as CatalogItem['department'],
      upsellable,
      upsellPriceMinor: offer ? paisa(offer) : null,
      recurring: text('recurring') as CatalogItem['recurring'],
      active: editing?.active ?? true,
    };
    if (editing) update.mutate({ ...fields, id: editing.id, expectedUpdatedAt: editing.updatedAt });
    else create.mutate(fields);
  };

  if (unavailable)
    return (
      <SectionCard title="Choose a property again" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Your property access changed. Choose a property you can manage to continue.
        </p>
        <a
          href="/hotel/settings/extras"
          className="mt-3 inline-flex min-h-11 items-center underline"
        >
          Choose a property
        </a>
      </SectionCard>
    );

  return (
    <div className="space-y-6">
      <SectionCard
        title={`What this property charges (${view.extras.length})`}
        titleLevel={2}
        actions={
          <label className="flex min-h-11 items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={includeInactive}
              disabled={busy}
              onChange={(event) => {
                setIncludeInactive(event.target.checked);
                void refresh(event.target.checked);
              }}
            />
            Show retired items
          </label>
        }
      >
        <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>
          Refresh catalog
        </Button>
        {refreshing ? (
          <p className="mb-3 text-sm text-text-muted" role="status">
            Refreshing catalog…
          </p>
        ) : null}
        {refreshFailed ? (
          <div className="mb-3 space-y-2">
            <p className="text-sm text-destructive" role="alert">
              Could not refresh the catalog. Showing the last loaded list. Any confirmed save is
              still saved.
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Retry refresh
            </Button>
          </div>
        ) : null}
        {view.extras.length === 0 ? (
          <p className="text-sm text-text-muted">
            Nothing is in the catalog yet. Every folio charge names an item from this list, so start
            with what the property already sells — laundry, airport transfer, extra bed, breakfast.
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {view.extras.map((extra) => (
              <li key={extra.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
                <span className="font-mono text-xs text-text-muted">{extra.code}</span>
                <span className="text-sm font-semibold text-text-strong">{extra.name}</span>
                {extra.nameUr ? (
                  <span className="text-sm text-text-muted" lang="ur">
                    {extra.nameUr}
                  </span>
                ) : null}
                <span className="text-sm text-text-body">PKR {rupees(extra.priceMinor)}</span>
                <span className="text-xs text-text-muted">
                  {
                    view.departmentOptions.find((option) => option.value === extra.department)
                      ?.label
                  }
                  {' · '}
                  {view.recurrenceOptions.find((option) => option.value === extra.recurring)?.label}
                  {' · '}
                  {extra.taxClass}
                </span>
                {extra.upsellable ? (
                  <>
                    <StatusPill status="Offered before arrival" tone="info" />
                    <span className="text-xs text-text-muted">
                      offered at PKR {rupees(extra.upsellPriceMinor ?? extra.priceMinor)}
                    </span>
                  </>
                ) : null}
                {extra.active ? null : <StatusPill status="Retired" tone="neutral" />}
                <span className="ml-auto flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() => startEditing(extra)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() =>
                      setActive.mutate({
                        branchId,
                        id: extra.id,
                        active: !extra.active,
                        expectedUpdatedAt: extra.updatedAt,
                      })
                    }
                  >
                    {extra.active ? 'Retire' : 'Restore'}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title={editing ? `Edit ${editing.name}` : 'Add a charge'}
        titleLevel={2}
        actions={
          editing ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              onClick={() => startEditing(null)}
            >
              Cancel
            </Button>
          ) : undefined
        }
      >
        <form
          className="grid gap-4 sm:grid-cols-2"
          key={`${editing?.id ?? 'new'}-${formVersion}`}
          onSubmit={onSubmit}
          aria-busy={pending}
          aria-label={editing ? 'Edit charge' : 'Add a charge'}
        >
          <Field
            htmlFor="code"
            label="Code"
            error={errors.code}
            hint="Appears on the folio line and in the accounts export. Capitals, numbers and hyphens."
          >
            <Input
              id="code"
              name="code"
              className="min-h-11"
              {...fieldProps('code')}
              defaultValue={editing?.code ?? ''}
              required
            />
          </Field>
          <Field htmlFor="name" label="Name" error={errors.name}>
            <Input
              id="name"
              name="name"
              className="min-h-11"
              {...fieldProps('name', false)}
              defaultValue={editing?.name ?? ''}
              required
            />
          </Field>
          <Field
            htmlFor="nameUr"
            label="Name in Urdu"
            error={errors.nameUr}
            hint="Optional. Shown to guests who read the property in Urdu."
          >
            <Input
              id="nameUr"
              name="nameUr"
              className="min-h-11"
              {...fieldProps('nameUr')}
              lang="ur"
              defaultValue={editing?.nameUr ?? ''}
            />
          </Field>
          <Field
            htmlFor="priceMinor"
            label="Price (PKR)"
            error={errors.priceMinor}
            hint="What a guest is charged, before tax."
          >
            <Input
              id="priceMinor"
              name="priceMinor"
              className="min-h-11"
              {...fieldProps('priceMinor')}
              type="number"
              min={0}
              max={21_474_836.47}
              step="0.01"
              defaultValue={editing ? rupees(editing.priceMinor) : ''}
              required
            />
          </Field>
          <Field
            htmlFor="department"
            label="Posting department"
            error={errors.department}
            hint="Where this charge appears in revenue by department."
          >
            <StudioSelect
              id="department"
              name="department"
              {...fieldProps('department')}
              defaultValue={editing?.department ?? 'MISCELLANEOUS'}
              className="mt-1 min-h-11 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm focus-visible:outline-ring disabled:opacity-50 aria-invalid:border-destructive"
            >
              {view.departmentOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </StudioSelect>
          </Field>
          <Field
            htmlFor="taxClass"
            label="Tax class"
            error={errors.taxClass}
            hint="The class from this property’s tax profile, e.g. HOTEL or SERVICES."
          >
            <Input
              id="taxClass"
              name="taxClass"
              className="min-h-11"
              {...fieldProps('taxClass')}
              defaultValue={editing?.taxClass ?? ''}
              required
            />
          </Field>
          <Field
            htmlFor="recurring"
            label="How often it is charged"
            error={errors.recurring}
            hint={
              view.recurrenceOptions.find(
                (option) => option.value === (editing?.recurring ?? 'NONE')
              )?.description
            }
          >
            <StudioSelect
              id="recurring"
              name="recurring"
              {...fieldProps('recurring')}
              defaultValue={editing?.recurring ?? 'NONE'}
              className="mt-1 min-h-11 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm focus-visible:outline-ring disabled:opacity-50 aria-invalid:border-destructive"
            >
              {view.recurrenceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </StudioSelect>
          </Field>
          <div className="min-w-0">
            <label
              className="flex min-h-11 items-center gap-2 text-sm text-text-body"
              htmlFor="upsellable"
            >
              <input
                id="upsellable"
                name="upsellable"
                type="checkbox"
                {...fieldProps('upsellable')}
                checked={upsellable}
                onChange={(event) => setUpsellable(event.target.checked)}
              />
              Offer this before arrival
            </label>
            {errors.upsellable ? (
              <p id="upsellable-error" className="mt-1 text-sm text-destructive" role="alert">
                {errors.upsellable}
              </p>
            ) : null}
            <p id="upsellable-hint" className="mt-1 text-xs text-text-muted">
              Pre-arrival offers quote the offer price below, or the price above when there is none.
            </p>
          </div>
          <Field
            htmlFor="upsellPriceMinor"
            label="Offer price (PKR)"
            error={errors.upsellPriceMinor}
            hint="Leave empty to offer it at the price above."
          >
            <Input
              id="upsellPriceMinor"
              name="upsellPriceMinor"
              className="min-h-11"
              {...fieldProps('upsellPriceMinor')}
              type="number"
              min={0}
              max={21_474_836.47}
              step="0.01"
              disabled={busy || !upsellable}
              defaultValue={
                editing?.upsellPriceMinor === null || editing?.upsellPriceMinor === undefined
                  ? ''
                  : rupees(editing.upsellPriceMinor)
              }
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
            <Button type="submit" className="min-h-11" disabled={busy}>
              {pending ? 'Saving…' : editing ? 'Save charge' : 'Add to catalog'}
            </Button>
          </div>
        </form>
      </SectionCard>
    </div>
  );
}
