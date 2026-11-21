'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, LoaderCircle, Play, Save } from 'lucide-react';
import { toast } from 'sonner';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type CommandField = {
  name: string;
  label: string;
  type?:
    | 'text'
    | 'email'
    | 'password'
    | 'number'
    | 'date'
    | 'datetime-local'
    | 'url'
    | 'color'
    | 'textarea'
    | 'select'
    | 'searchable-select'
    | 'checkbox'
    | 'json'
    | 'hidden';
  required?: boolean;
  defaultValue?: string | number | boolean | null | Record<string, unknown> | unknown[];
  placeholder?: string;
  help?: string;
  checkboxText?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  filterBy?: string;
  defaultFrom?: { field: string; values: Record<string, number> };
  format?: 'time24';
  options?: Array<{ label: string; value: string; filterValue?: string }>;
};

function SearchableSelectField({
  field,
  id,
  value,
  onChange,
  fieldError,
  errorId,
}: {
  field: CommandField;
  id: string;
  value: string;
  onChange: (value: string) => void;
  fieldError?: string;
  errorId: string;
}) {
  const [open, setOpen] = useState(false);
  const options = field.options ?? [];
  const groups = Map.groupBy(options, (option) => option.value.split('/')[0] ?? 'Other');
  const selected = options.find((option) => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <input type="hidden" name={field.name} value={value} />
      <PopoverTrigger
        render={
          <button
            id={id}
            type="button"
            disabled={field.disabled}
            data-field-name={field.name}
            data-invalid={fieldError ? '' : undefined}
            aria-label={field.label}
            aria-describedby={fieldError ? errorId : undefined}
            className="flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-border-default bg-card px-3 text-left text-sm outline-none transition hover:bg-surface-sunken focus-visible:border-accent-brand focus-visible:ring-2 focus-visible:ring-accent-brand/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className={cn('truncate', !selected && 'text-text-muted')}>
              {selected?.label ?? 'Choose a timezone'}
            </span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
          </button>
        }
      />
      <PopoverContent align="start" className="w-(--anchor-width) min-w-72 p-0">
        <Command value={value}>
          <CommandInput
            placeholder="Search city or IANA timezone…"
            aria-invalid={Boolean(fieldError)}
            aria-describedby={fieldError ? errorId : undefined}
            autoFocus
          />
          <CommandList>
            <CommandEmpty>No matching timezone.</CommandEmpty>
            {[...groups.entries()].map(([region, regionOptions]) => (
              <CommandGroup key={region} heading={region === 'UTC' ? 'Universal' : region}>
                {regionOptions.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={`${option.label} ${option.value.replaceAll('_', ' ')}`}
                    data-checked={option.value === value}
                    onSelect={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    {option.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function optionsFor(field: CommandField, values: Record<string, string>) {
  return field.filterBy
    ? field.options?.filter((option) => option.filterValue === values[field.filterBy!])
    : field.options;
}

function initialSelectValues(fields: CommandField[]) {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.type !== 'select' && field.type !== 'searchable-select') continue;
    const options = optionsFor(field, values);
    const fallback = field.required ? (options?.[0]?.value ?? '') : '';
    const preferred = String(field.defaultValue ?? fallback);
    values[field.name] = options?.some((option) => option.value === preferred)
      ? preferred
      : fallback;
  }
  return values;
}

function payloadFromForm(form: HTMLFormElement, fields: CommandField[]) {
  const formData = new FormData(form);
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === 'checkbox') {
      payload[field.name] = formData.has(field.name);
      continue;
    }
    const raw = formData.get(field.name);
    // Optional empty controls are omitted rather than serialized as null. This
    // keeps "leave unchanged" distinct from commands that explicitly support
    // clearing a value.
    if (raw === null || raw === '') continue;
    if (field.type === 'number') {
      payload[field.name] = Number(raw);
      continue;
    }
    if (field.type === 'date' || field.type === 'datetime-local') {
      payload[field.name] = new Date(String(raw)).toISOString();
      continue;
    }
    if (field.type === 'json') {
      try {
        payload[field.name] = JSON.parse(String(raw));
      } catch {
        throw new Error(`${field.label} must be valid JSON.`);
      }
      continue;
    }
    payload[field.name] = String(raw);
  }
  return payload;
}

export function PlatformCommandForm({
  action,
  fields: configuredFields,
  submitLabel = 'Save changes',
  title,
  description,
  compact = false,
  onSuccessPath,
  revealResultKey,
  confirm,
}: {
  action: string;
  fields: CommandField[];
  submitLabel?: string;
  title?: string;
  description?: string;
  compact?: boolean;
  onSuccessPath?: string;
  revealResultKey?: string;
  confirm?: string;
}) {
  // Keep every sensitive form aligned with the server's mandatory reason contract.
  const fields = useMemo(() => {
    const requiresReason =
      [
        'organization.user.password',
        'organization.user.approvalauthenticator.reset',
        'organization.scim.token',
        'organization.scim.revoke',
        'organization.transition',
        'organization.identity',
      ].includes(action) ||
      action.startsWith('organization.identity.') ||
      (action === 'organization.update' &&
        configuredFields.some((field) => field.name === 'vertical'));
    if (!requiresReason) return configuredFields;
    const reason: CommandField = {
      name: 'reason',
      label: 'Operator reason',
      type: 'textarea',
      required: true,
      minLength: 10,
      maxLength: 500,
      help: 'Explain why this change is needed (at least 10 characters).',
    };
    return configuredFields.some((field) => field.name === 'reason')
      ? configuredFields.map((field) => (field.name === 'reason' ? { ...field, ...reason } : field))
      : [...configuredFields, reason];
  }, [action, configuredFields]);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState('');
  const fieldIdPrefix = useId();
  const [selectState, setSelectState] = useState(() => ({
    fields,
    values: initialSelectValues(fields),
  }));
  if (selectState.fields !== fields) {
    setSelectState({ fields, values: initialSelectValues(fields) });
  }
  const selectValues = selectState.values;

  function updateSelect(name: string, value: string) {
    setSelectState((current) => {
      const next = { ...current.values, [name]: value };
      for (const field of fields) {
        if (field.filterBy !== name) continue;
        const options = optionsFor(field, next);
        if (!options?.some((option) => option.value === next[field.name])) {
          next[field.name] = options?.[0]?.value ?? '';
        }
      }
      return { fields, values: next };
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError('');
    setFieldErrors({});
    setRevealed('');
    const clientFieldErrors: Record<string, string> = {};
    const formData = new FormData(form);
    for (const field of fields) {
      if (field.disabled || field.type === 'hidden') continue;
      const raw = String(formData.get(field.name) ?? '');
      // Empty optional controls are omitted by payloadFromForm. Length limits
      // must not turn "leave unchanged" passwords or profile fields into errors.
      if (!raw && !field.required) continue;
      const value =
        field.type === 'password' && ['password', 'adminPassword'].includes(field.name)
          ? raw
          : raw.trim();
      if (field.minLength && value.length < field.minLength) {
        clientFieldErrors[field.name] =
          `${field.label} must be at least ${field.minLength} characters.`;
      }
      if (field.maxLength && value.length > field.maxLength) {
        clientFieldErrors[field.name] =
          `${field.label} must be at most ${field.maxLength} characters.`;
      }
      const control = form.elements.namedItem(field.name);
      if (
        field.pattern &&
        control instanceof HTMLInputElement &&
        control.validity.patternMismatch
      ) {
        clientFieldErrors[field.name] = `${field.label} has an invalid format.`;
      }
      if (field.format !== 'time24') continue;
      if (value && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        clientFieldErrors[field.name] = 'Use 24-hour time, e.g. 09:30';
      }
    }
    if (Object.keys(clientFieldErrors).length) {
      setFieldErrors(clientFieldErrors);
      const count = Object.keys(clientFieldErrors).length;
      setError(`${count} ${count === 1 ? 'field needs' : 'fields need'} attention`);
      const firstInvalid = Object.keys(clientFieldErrors)[0]!;
      const invalidControl =
        (form.querySelector(`[data-field-name="${firstInvalid}"]`) as HTMLElement | null) ??
        (form.elements.namedItem(firstInvalid) as HTMLElement | null);
      invalidControl?.focus();
      return;
    }
    if (confirm && !window.confirm(confirm)) return;
    setPending(true);
    try {
      const payload = payloadFromForm(form, fields);
      const response = await fetch('/api/platform/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
      const body = (await response.json()) as {
        error?: string;
        data?: { id?: string; [key: string]: unknown };
        fieldErrors?: Record<string, string>;
      };
      if (!response.ok) {
        const mapped = Object.fromEntries(
          Object.entries(body.fieldErrors ?? {}).map(([path, message]) => [
            fields.find(
              (field) =>
                path === field.name ||
                path.startsWith(`${field.name}.`) ||
                path.endsWith(`.${field.name}`)
            )?.name ?? path,
            message,
          ])
        );
        const visibleErrors = Object.fromEntries(
          Object.entries(mapped).filter(([name]) => fields.some((field) => field.name === name))
        );
        if (Object.keys(visibleErrors).length) {
          setFieldErrors(visibleErrors);
          const count = Object.keys(visibleErrors).length;
          setError(`${count} ${count === 1 ? 'field needs' : 'fields need'} attention`);
          const firstInvalid = Object.keys(visibleErrors)[0]!;
          const invalidControl =
            (form.querySelector(`[data-field-name="${firstInvalid}"]`) as HTMLElement | null) ??
            (form.elements.namedItem(firstInvalid) as HTMLElement | null);
          invalidControl?.focus();
        } else {
          setError(body.error ?? 'The command failed.');
        }
        return;
      }
      toast.success(submitLabel.replace(/^Save /, '').replace(/^Create /, '') + ' saved');
      if (revealResultKey && typeof body.data?.[revealResultKey] === 'string') {
        setRevealed(String(body.data[revealResultKey]));
      }
      if (onSuccessPath) {
        router.push(body.data?.id ? onSuccessPath.replace('[id]', body.data.id) : onSuccessPath);
      } else {
        router.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The command could not be completed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className={cn(!compact && 'overflow-hidden rounded-lg border border-border-subtle bg-card')}
    >
      {title || description ? (
        <div className={cn('border-b border-border-subtle', compact ? 'pb-4' : 'px-5 py-4')}>
          {title ? (
            <h3 className="font-display text-lg font-semibold tracking-tight">{title}</h3>
          ) : null}
          {description ? (
            <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
          ) : null}
        </div>
      ) : null}
      <div className={cn('grid gap-4 sm:grid-cols-2', compact ? 'py-4' : 'p-5')}>
        {fields.map((field) => {
          if (field.type === 'hidden') {
            return (
              <input
                key={field.name}
                type="hidden"
                name={field.name}
                value={String(field.defaultValue ?? '')}
              />
            );
          }
          const wide = field.type === 'textarea' || field.type === 'json';
          const fieldError = fieldErrors[field.name];
          const fieldId = `${fieldIdPrefix}-${field.name}`;
          const errorId = `${fieldId}-error`;
          return (
            <div key={field.name} className={cn('block', wide && 'sm:col-span-2')}>
              <label
                htmlFor={fieldId}
                className="mb-1.5 block text-xs font-semibold text-text-strong"
              >
                {field.label}
              </label>
              {field.type === 'textarea' || field.type === 'json' ? (
                <textarea
                  id={fieldId}
                  name={field.name}
                  required={field.required}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  disabled={field.disabled}
                  defaultValue={
                    field.defaultValue !== null && typeof field.defaultValue === 'object'
                      ? JSON.stringify(field.defaultValue, null, 2)
                      : String(
                          field.defaultFrom?.values[selectValues[field.defaultFrom.field] ?? ''] ??
                            field.defaultValue ??
                            ''
                        )
                  }
                  placeholder={field.placeholder}
                  rows={field.type === 'json' ? 6 : 3}
                  aria-invalid={Boolean(fieldError)}
                  aria-describedby={fieldError ? errorId : undefined}
                  className="w-full rounded-lg border border-border-default bg-card px-3 py-2.5 font-sans text-sm outline-none transition focus:border-accent-brand focus:ring-2 focus:ring-accent-brand/15"
                />
              ) : field.type === 'searchable-select' ? (
                <SearchableSelectField
                  field={{ ...field, options: optionsFor(field, selectValues) }}
                  id={fieldId}
                  value={selectValues[field.name] ?? ''}
                  onChange={(value) => updateSelect(field.name, value)}
                  fieldError={fieldError}
                  errorId={errorId}
                />
              ) : field.type === 'select' ? (
                <StudioSelect
                  id={fieldId}
                  name={field.name}
                  required={field.required}
                  disabled={field.disabled}
                  value={selectValues[field.name] ?? ''}
                  onChange={(event) => updateSelect(field.name, event.target.value)}
                  aria-invalid={Boolean(fieldError)}
                  aria-describedby={fieldError ? errorId : undefined}
                  className="h-11 w-full rounded-lg border border-border-default bg-card px-3 text-sm outline-none transition focus:border-accent-brand focus:ring-2 focus:ring-accent-brand/15"
                >
                  {!field.required ? <option value="">Not set</option> : null}
                  {optionsFor(field, selectValues)?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </StudioSelect>
              ) : field.type === 'checkbox' ? (
                <span className="flex h-11 items-center gap-2 rounded-lg border border-border-default bg-card px-3 text-xs">
                  <input
                    id={fieldId}
                    name={field.name}
                    type="checkbox"
                    required={field.required}
                    disabled={field.disabled}
                    defaultChecked={Boolean(field.defaultValue)}
                    aria-invalid={Boolean(fieldError)}
                    aria-describedby={fieldError ? errorId : undefined}
                    className="h-4 w-4 accent-[var(--accent-brand)]"
                  />
                  {field.checkboxText ?? 'Enabled'}
                </span>
              ) : (
                <input
                  key={field.defaultFrom ? selectValues[field.defaultFrom.field] : field.name}
                  id={fieldId}
                  name={field.name}
                  type={field.type ?? 'text'}
                  required={field.required}
                  minLength={field.minLength}
                  disabled={field.disabled}
                  defaultValue={
                    typeof field.defaultValue === 'boolean'
                      ? undefined
                      : String(
                          field.defaultFrom?.values[selectValues[field.defaultFrom.field] ?? ''] ??
                            field.defaultValue ??
                            ''
                        )
                  }
                  placeholder={field.format === 'time24' ? 'HH:MM' : field.placeholder}
                  min={field.min}
                  max={
                    field.defaultFrom?.values[selectValues[field.defaultFrom.field] ?? ''] ??
                    field.max
                  }
                  step={field.step}
                  inputMode={field.format === 'time24' ? 'numeric' : undefined}
                  maxLength={field.format === 'time24' ? 5 : field.maxLength}
                  pattern={field.format === 'time24' ? '[0-2][0-9]:[0-5][0-9]' : field.pattern}
                  aria-invalid={Boolean(fieldError)}
                  aria-describedby={fieldError ? errorId : undefined}
                  onInput={
                    field.format === 'time24'
                      ? (event) => {
                          const input = event.currentTarget;
                          const digits = input.value.replace(/\D/g, '').slice(0, 4);
                          input.value =
                            digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
                        }
                      : undefined
                  }
                  className="h-11 w-full rounded-lg border border-border-default bg-card px-3 text-sm outline-none transition focus:border-accent-brand focus:ring-2 focus:ring-accent-brand/15"
                />
              )}
              {field.help ? (
                <span className="mt-1.5 block text-[10px] leading-4 text-text-muted">
                  {field.help}
                </span>
              ) : null}
              {fieldError ? (
                <span
                  id={errorId}
                  data-testid={`platform-field-error-${field.name}`}
                  className="mt-1.5 block text-xs text-destructive"
                >
                  {fieldError}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? (
        <p
          role="alert"
          className="mx-5 mb-4 rounded-control border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      {revealed ? (
        <div className="mx-5 mb-4 rounded-lg border border-warning/25 bg-warning/10 p-3 text-text-strong">
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em]">
            Copy now · shown once
          </p>
          <code className="mt-2 block break-all text-xs">{revealed}</code>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(revealed)}
            className="mt-3 min-h-9 rounded-control border border-warning/40 px-3 text-[10px] font-semibold transition hover:bg-warning/10"
          >
            Copy secret
          </button>
        </div>
      ) : null}
      <div
        className={cn(
          'flex justify-end border-t border-border-subtle',
          compact ? 'pt-4' : 'px-5 py-4'
        )}
      >
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center gap-2 rounded-control bg-primary px-4 text-xs font-semibold text-primary-foreground shadow-control-ink transition-all hover:-translate-y-px hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {pending ? 'Working…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function PlatformCommandButton({
  action,
  payload,
  label,
  confirm,
  tone = 'default',
  onSuccessPath,
}: {
  action: string;
  payload: Record<string, unknown>;
  label: string;
  confirm?: string;
  tone?: 'default' | 'danger' | 'quiet';
  onSuccessPath?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setPending(true);
    try {
      const response = await fetch('/api/platform/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        toast.error(body.error ?? 'The command failed.');
        return;
      }
      toast.success(`${label} completed`);
      if (onSuccessPath) router.push(onSuccessPath);
      router.refresh();
    } catch {
      toast.error('The command could not be completed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={pending}
      className={cn(
        'inline-flex min-h-10 items-center gap-2 rounded-control border px-3 text-xs font-semibold transition disabled:cursor-wait disabled:opacity-60',
        tone === 'danger' &&
          'border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/20',
        tone === 'quiet' && 'border-border-default bg-card text-text-body hover:bg-muted',
        tone === 'default' &&
          'border-primary bg-primary text-primary-foreground hover:bg-primary-hover'
      )}
    >
      {pending ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Play className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {pending ? 'Working…' : label}
    </button>
  );
}
