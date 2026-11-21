'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

/**
 * MEAL-01 — the meal plans surface: the board bases a property sells (room
 * only, bed & breakfast, half board, full board, or its own), what each one
 * covers, and whether it is on sale.
 *
 * It follows the three rules of the other hotel settings surfaces:
 *
 * - **No raw identifiers.** Services are named, a plan is its code and its
 *   name, and "per person" / "per room" is said in words (UX rule 1).
 * - **Errors land on fields.** The server publishes rejections as
 *   `data.validation[field]` — a taken code, a malformed document — so each
 *   message appears under the input it belongs to (UX rule 11).
 * - **Nothing is a dead end.** An empty list says what to add first, a plan
 *   withdrawn from sale is still listed with a way to put it back, and a
 *   conflict keeps the operator's entries (UX rule 13).
 *
 * Every write names the property the page was opened for and the version of
 * the plan the editor saw; the server re-checks access inside the property lock
 * on every call. Editing a plan never touches a confirmed reservation — each
 * carries a frozen copy — which is why this surface may edit in place.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { useSession } from 'next-auth/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { HOTEL_MEALS, HOTEL_MEAL_LABELS, type HotelMeal } from '@/lib/hotel/meal-plans';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type HotelMealPlansView = RouterOutputs['hotelRates']['mealPlans']['list'];
type MealPlan = HotelMealPlansView['plans'][number];
type MealEntry = MealPlan['meals'][number];
type MealPlansSelection = { branchId: string; organizationId: string; userId: string };

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm focus-visible:outline-ring disabled:opacity-50 aria-invalid:border-destructive';

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

const errorCode = (error: unknown) => (error as { data?: { code?: string } } | null)?.data?.code;
const accessDenied = (error: unknown) =>
  ['FORBIDDEN', 'UNAUTHORIZED'].includes(errorCode(error) ?? '');

/** One covered service, as an operator reads it: "Breakfast — per person · by 10:30 · 2 outlets". */
export function describeMeal(entry: MealEntry): string {
  const parts = [entry.per_person ? 'per person' : 'per room'];
  if (entry.cutoff_time) parts.push(`by ${entry.cutoff_time}`);
  if (entry.outlets.length)
    parts.push(`${entry.outlets.length} ${entry.outlets.length === 1 ? 'outlet' : 'outlets'}`);
  return `${HOTEL_MEAL_LABELS[entry.meal]} — ${parts.join(' · ')}`;
}

/**
 * Keyboard contract for the inline editor: focus moves to its first control
 * when it opens, Escape closes it, and focus returns to the row action that
 * opened it when it closes for any reason (cancel, Escape, a saved change).
 */
function useOpeningFocus<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (enabled) ref.current?.focus();
  }, [enabled]);
  return ref;
}

function closeOnEscape(onCancel: () => void) {
  return (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
}

export function HotelMealPlansPanel({
  initial,
  selection,
}: {
  initial: HotelMealPlansView;
  selection: MealPlansSelection;
}) {
  const { data: session } = useSession();
  if (
    session?.user.id !== selection.userId ||
    session.user.organizationId !== selection.organizationId
  ) {
    return (
      <SectionCard title="Reload the meal plans" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Your signed-in identity changed. Choose a property again to continue.
        </p>
        <a
          href="/hotel/settings/meal-plans"
          className="mt-3 inline-flex min-h-11 items-center underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Choose a property
        </a>
      </SectionCard>
    );
  }
  return (
    <SelectedMealPlans
      key={`${selection.organizationId}:${selection.userId}:${selection.branchId}`}
      initial={initial}
      branchId={selection.branchId}
    />
  );
}

function SelectedMealPlans({
  initial,
  branchId,
}: {
  initial: HotelMealPlansView;
  branchId: string;
}) {
  const [view, setView] = useState<HotelMealPlansView>(initial);
  const [errors, setErrors] = useState<Record<string, Record<string, string>>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
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

  const utils = trpc.useUtils();
  const refresh = async () => {
    if (!mounted.current) return;
    const request = ++generation.current;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      // A saved change must be reflected at once, past the provider's query cache.
      const next = await utils.hotelRates.mealPlans.list.fetch({ branchId }, { staleTime: 0 });
      if (mounted.current && request === generation.current) setView(next);
    } catch (error) {
      if (!mounted.current || request !== generation.current) return;
      if (accessDenied(error) || errorCode(error) === 'NOT_FOUND') setUnavailable(true);
      else setRefreshFailed(true);
    } finally {
      if (mounted.current && request === generation.current) setRefreshing(false);
    }
  };

  const failure = (scope: string) => (error: { message: string }) => {
    if (!mounted.current) return;
    if (accessDenied(error)) setUnavailable(true);
    const fields = validationErrors(error);
    setSaved(null);
    setErrors((current) => ({
      ...current,
      [scope]: Object.keys(fields).length
        ? fields
        : errorCode(error) === 'CONFLICT'
          ? {
              form: 'This plan changed elsewhere. Your entries are kept; cancel and reopen the refreshed plan to review the latest values.',
            }
          : { form: error.message },
    }));
  };
  const success = (scope: string, message: string, resetForm: boolean) => {
    if (!mounted.current) return;
    setErrors((current) => ({ ...current, [scope]: {} }));
    if (resetForm) setFormVersion((version) => version + 1);
    setEditing(null);
    setSaved(message);
    void refresh();
  };

  const create = trpc.hotelRates.mealPlans.create.useMutation({
    onSuccess: (result) =>
      success(
        'new',
        result.plan.active
          ? `${result.plan.code} · ${result.plan.name} is on sale.`
          : `${result.plan.code} · ${result.plan.name} is set up and not yet on sale.`,
        true
      ),
    onError: failure('new'),
  });
  const update = trpc.hotelRates.mealPlans.update.useMutation();
  const setActive = trpc.hotelRates.mealPlans.setActive.useMutation();

  const pending = create.isPending || update.isPending || setActive.isPending;
  const busy = pending || refreshing;

  if (unavailable)
    return (
      <SectionCard title="Choose a property again" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Your property access changed. Choose a property whose rates you manage to continue.
        </p>
        <a
          href="/hotel/settings/meal-plans"
          className="mt-3 inline-flex min-h-11 items-center underline"
        >
          Choose a property
        </a>
      </SectionCard>
    );

  const onSale = view.plans.filter((plan) => plan.active).length;

  return (
    <div className="space-y-6">
      {saved ? (
        <p className="text-sm text-text-muted" role="status">
          {saved}
        </p>
      ) : null}
      {refreshing ? (
        <p className="text-sm text-text-muted" role="status">
          Refreshing meal plans…
        </p>
      ) : null}
      {refreshFailed ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">
            Could not refresh the meal plans. Showing the last loaded list. Any confirmed save is
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

      <SectionCard
        title={`Meal plans (${view.plans.length})`}
        titleLevel={2}
        actions={
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Refresh plans
          </Button>
        }
      >
        <p className="mb-4 font-mono text-xs tabular-nums text-text-muted">
          {onSale} of {view.plans.length} on sale. A rate plan sells rooms under one of these; a
          confirmed stay keeps the plan it was sold with, so editing here changes future sales only.
        </p>
        {view.plans.length === 0 ? (
          <p className="text-sm text-text-muted">
            No meal plans yet. A property normally opens with room only, bed &amp; breakfast, half
            board and full board; add the first plan below, or ask your DevFathom account manager to
            re-run provisioning if the standard four are missing.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left font-mono text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  <th className="py-2 pr-3 font-semibold">Code</th>
                  <th className="py-2 pr-3 font-semibold">Plan</th>
                  <th className="py-2 pr-3 font-semibold">Covers</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 text-right font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {view.plans.map((plan) => (
                  <PlanRow
                    key={plan.id}
                    plan={plan}
                    mealOptions={view.mealOptions}
                    open={editing === plan.id}
                    rowErrors={errors[`row:${plan.id}`] ?? {}}
                    busy={busy}
                    saving={update.isPending}
                    toggling={setActive.isPending}
                    onOpen={() => {
                      setEditing((current) => (current === plan.id ? null : plan.id));
                      setErrors((current) => ({ ...current, [`row:${plan.id}`]: {} }));
                      setSaved(null);
                    }}
                    onCancel={() => {
                      setEditing(null);
                      setErrors((current) => ({ ...current, [`row:${plan.id}`]: {} }));
                    }}
                    onSave={(fields) =>
                      update.mutate(
                        {
                          branchId,
                          id: plan.id,
                          expectedUpdatedAt: plan.updatedAt,
                          active: plan.active,
                          ...fields,
                        },
                        {
                          onSuccess: () => success(`row:${plan.id}`, 'Saved.', false),
                          onError: failure(`row:${plan.id}`),
                        }
                      )
                    }
                    onToggle={() =>
                      setActive.mutate(
                        {
                          branchId,
                          id: plan.id,
                          active: !plan.active,
                          expectedUpdatedAt: plan.updatedAt,
                        },
                        {
                          onSuccess: (result) =>
                            success(
                              `row:${plan.id}`,
                              result.active
                                ? `${plan.code} is on sale.`
                                : `${plan.code} is withdrawn from sale. Confirmed stays keep their plan.`,
                              false
                            ),
                          onError: failure(`row:${plan.id}`),
                        }
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Add a meal plan" titleLevel={2}>
        <MealPlanForm
          key={`new-${formVersion}`}
          idPrefix="new"
          plan={null}
          mealOptions={view.mealOptions}
          standardCodes={view.standardCodes}
          errors={errors.new ?? {}}
          busy={busy || editing !== null}
          pending={create.isPending}
          onSubmit={(fields) => {
            if (fields.mode !== 'new') return;
            create.mutate({
              branchId,
              code: fields.code,
              active: fields.active,
              name: fields.name,
              nameUr: fields.nameUr,
              meals: fields.meals,
            });
          }}
        />
      </SectionCard>
    </div>
  );
}

function PlanRow({
  plan,
  mealOptions,
  open,
  rowErrors,
  busy,
  saving,
  toggling,
  onOpen,
  onCancel,
  onSave,
  onToggle,
}: {
  plan: MealPlan;
  mealOptions: HotelMealPlansView['mealOptions'];
  open: boolean;
  rowErrors: Record<string, string>;
  busy: boolean;
  saving: boolean;
  toggling: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onSave: (fields: PlanDocument) => void;
  onToggle: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    // The editor closed and took the focused control with it: hand focus back
    // to the action that opened it rather than letting it fall to the body.
    // Only on that transition — a row mounting with its editor closed must not
    // take focus from the page.
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed || typeof document === 'undefined') return;
    if (document.activeElement && document.activeElement !== document.body) return;
    trigger.current?.focus();
  }, [open]);
  return (
    <>
      <tr className="hover:bg-surface-sunken">
        <td className="py-3 pr-3 align-top font-mono text-xs text-text-muted">
          {plan.code}
          {plan.standard ? (
            <span className="block text-[0.625rem] uppercase tracking-wide text-text-faint">
              Industry code
            </span>
          ) : null}
        </td>
        <td className="py-3 pr-3 align-top">
          <span className="font-semibold text-text-strong">{plan.name}</span>
          {plan.nameUr ? (
            <span className="ml-2 text-text-muted" lang="ur">
              {plan.nameUr}
            </span>
          ) : null}
        </td>
        <td className="py-3 pr-3 align-top text-text-body">
          {plan.meals.length === 0 ? (
            <span className="text-text-muted">Room only — no meals</span>
          ) : (
            <ul className="space-y-0.5">
              {plan.meals.map((entry) => (
                <li key={entry.meal}>{describeMeal(entry)}</li>
              ))}
            </ul>
          )}
        </td>
        <td className="py-3 pr-3 align-top">
          <StatusPill
            status={plan.active ? 'On sale' : 'Not sold'}
            tone={plan.active ? 'success' : 'neutral'}
          />
        </td>
        <td className="py-3 align-top">
          <span className="flex flex-wrap justify-end gap-2">
            <Button
              ref={trigger}
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy && !open}
              aria-expanded={open}
              aria-label={`${open ? 'Close' : 'Edit'} ${plan.code}`}
              onClick={onOpen}
            >
              {open ? 'Close' : 'Edit'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy || open}
              aria-label={`${plan.active ? 'Withdraw' : 'Put on sale'} ${plan.code}`}
              onClick={onToggle}
            >
              {toggling ? 'Saving…' : plan.active ? 'Withdraw' : 'Put on sale'}
            </Button>
          </span>
          {!open && rowErrors.form ? (
            <p className="mt-2 text-right text-sm text-destructive" role="alert">
              {rowErrors.form}
            </p>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={5} className="bg-surface-sunken px-3 py-4">
            <MealPlanForm
              idPrefix={`plan-${plan.id}`}
              plan={plan}
              mealOptions={mealOptions}
              standardCodes={[]}
              errors={rowErrors}
              busy={busy}
              pending={saving}
              onSubmit={(fields) => {
                if (fields.mode !== 'edit') return;
                onSave({ name: fields.name, nameUr: fields.nameUr, meals: fields.meals });
              }}
              onCancel={onCancel}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

type PlanDocument = {
  name: string;
  nameUr: string | null;
  meals: { meal: HotelMeal; outlets: string[]; cutoff_time: string | null; per_person: boolean }[];
};
/** What the form hands back: a new plan carries its code and sale state, an edit does not. */
type PlanSubmission = PlanDocument &
  ({ mode: 'new'; code: string; active: boolean } | { mode: 'edit' });

/** `Terrace, Rooftop grill` in; a list of outlet references out. */
function parseOutlets(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * One form for a new plan and for an existing one. Each service is a row — on
 * or off, per person or per room, an optional cut-off and the outlets it is
 * served at — so an operator never writes the stored document by hand.
 */
function MealPlanForm({
  idPrefix,
  plan,
  mealOptions,
  standardCodes,
  errors,
  busy,
  pending,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  plan: MealPlan | null;
  mealOptions: HotelMealPlansView['mealOptions'];
  standardCodes: readonly string[];
  errors: Record<string, string>;
  busy: boolean;
  pending: boolean;
  onSubmit: (fields: PlanSubmission) => void;
  onCancel?: () => void;
}) {
  // Only the inline editor takes focus when it appears; the always-present
  // add form must not steal it from the page.
  const firstControl = useOpeningFocus<HTMLInputElement>(plan !== null);
  const [covered, setCovered] = useState<Record<HotelMeal, boolean>>(
    () =>
      Object.fromEntries(
        HOTEL_MEALS.map((meal) => [meal, plan?.meals.some((entry) => entry.meal === meal) ?? false])
      ) as Record<HotelMeal, boolean>
  );
  const id = (name: string) => `${idPrefix}-${name}`;
  const fieldProps = (name: string, hasHint = true) => ({
    'aria-invalid': Boolean(errors[name]),
    'aria-describedby': errors[name]
      ? `${id(name)}-error`
      : hasHint
        ? `${id(name)}-hint`
        : undefined,
    disabled: busy,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const meals = HOTEL_MEALS.filter((meal) => covered[meal]).map((meal) => ({
      meal,
      per_person: text(`basis-${meal}`) !== 'per_room',
      cutoff_time: text(`cutoff-${meal}`) || null,
      outlets: parseOutlets(text(`outlets-${meal}`)),
    }));
    const document = { name: text('name'), nameUr: text('nameUr') || null, meals };
    onSubmit(
      plan
        ? { mode: 'edit', ...document }
        : { mode: 'new', code: text('code'), active: form.get('active') === 'on', ...document }
    );
  };
  const entryFor = (meal: HotelMeal) => plan?.meals.find((entry) => entry.meal === meal);
  const mealsErrorId = `${id('meals')}-error`;
  return (
    <form
      className="space-y-4"
      onSubmit={submit}
      onKeyDown={onCancel ? closeOnEscape(onCancel) : undefined}
      aria-busy={pending}
      aria-label={plan ? `Edit ${plan.code}` : 'Add a meal plan'}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {plan ? (
          <div className="min-w-0">
            <span className={labelClass}>Code</span>
            <p className="mt-1 min-h-11 py-2 font-mono text-sm text-text-body">
              {plan.code}
              <span className="ml-2 text-xs text-text-muted">
                Fixed: it is the plan’s identity on rates, vouchers and channel pushes.
              </span>
            </p>
          </div>
        ) : (
          <Field
            htmlFor={id('code')}
            label="Code"
            error={errors.code}
            hint={`Short and uppercase, e.g. ${standardCodes.join(', ')} or your own such as HB-TERRACE. Capitals, numbers, hyphens.`}
          >
            <Input
              id={id('code')}
              name="code"
              className="min-h-11"
              {...fieldProps('code')}
              required
            />
          </Field>
        )}
        <Field htmlFor={id('name')} label="Name" error={errors.name}>
          <Input
            ref={plan ? firstControl : undefined}
            id={id('name')}
            name="name"
            className="min-h-11"
            defaultValue={plan?.name ?? ''}
            {...fieldProps('name', false)}
            required
          />
        </Field>
        <Field
          htmlFor={id('nameUr')}
          label="Name in Urdu"
          error={errors.nameUr}
          hint="Optional. Shown to guests who read the property in Urdu."
        >
          <Input
            id={id('nameUr')}
            name="nameUr"
            className="min-h-11"
            lang="ur"
            dir="rtl"
            defaultValue={plan?.nameUr ?? ''}
            {...fieldProps('nameUr')}
          />
        </Field>
        {plan ? null : (
          <div className="min-w-0">
            <span className={labelClass}>Sale</span>
            <label className="mt-1 flex min-h-11 items-center gap-2 text-sm text-text-body">
              <input
                type="checkbox"
                name="active"
                defaultChecked
                disabled={busy}
                className="h-4 w-4"
              />
              Put on sale now
            </label>
            <p className="mt-1 text-xs text-text-muted">
              Leave unticked to set the plan up first and sell it later.
            </p>
          </div>
        )}
      </div>

      <fieldset
        className="min-w-0 space-y-3"
        aria-describedby={errors.meals ? mealsErrorId : `${id('meals')}-hint`}
        disabled={busy}
      >
        <legend className={labelClass}>What the plan covers</legend>
        <p className="text-xs text-text-muted" id={`${id('meals')}-hint`}>
          Tick each service the plan includes. Leave every service unticked for a room-only plan.
          Outlets are optional and comma-separated; empty means any outlet of this property.
        </p>
        <div className="space-y-3">
          {mealOptions.map((option) => {
            const meal = option.value;
            const entry = entryFor(meal);
            const on = covered[meal];
            return (
              <div
                key={meal}
                className="grid gap-3 rounded-md border border-border-subtle p-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)]"
              >
                <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-text-strong">
                  <input
                    type="checkbox"
                    name={`covers-${meal}`}
                    className="h-4 w-4"
                    checked={on}
                    disabled={busy}
                    onChange={(event) =>
                      setCovered((current) => ({ ...current, [meal]: event.target.checked }))
                    }
                  />
                  {option.label}
                </label>
                <Field htmlFor={id(`basis-${meal}`)} label="Basis">
                  <StudioSelect
                    id={id(`basis-${meal}`)}
                    name={`basis-${meal}`}
                    className={selectClass}
                    defaultValue={entry && !entry.per_person ? 'per_room' : 'per_person'}
                    disabled={busy || !on}
                  >
                    <option value="per_person">Per person</option>
                    <option value="per_room">Per room</option>
                  </StudioSelect>
                </Field>
                <Field htmlFor={id(`cutoff-${meal}`)} label="Cut-off">
                  <Input
                    id={id(`cutoff-${meal}`)}
                    name={`cutoff-${meal}`}
                    className="mt-1 min-h-11"
                    type="time"
                    defaultValue={entry?.cutoff_time ?? ''}
                    disabled={busy || !on}
                  />
                </Field>
                <Field htmlFor={id(`outlets-${meal}`)} label="Outlets">
                  <Input
                    id={id(`outlets-${meal}`)}
                    name={`outlets-${meal}`}
                    className="mt-1 min-h-11"
                    placeholder="Any outlet"
                    defaultValue={entry?.outlets.join(', ') ?? ''}
                    disabled={busy || !on}
                  />
                </Field>
              </div>
            );
          })}
        </div>
        {errors.meals ? (
          <p className="text-sm text-destructive" id={mealsErrorId} role="alert">
            {errors.meals}
          </p>
        ) : null}
      </fieldset>

      {errors.form ? (
        <p className="text-sm text-destructive" role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11" disabled={busy}>
          {pending ? 'Saving…' : plan ? 'Save plan' : 'Add meal plan'}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
