'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, Play, Save } from 'lucide-react';
import { toast } from 'sonner';
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
    | 'checkbox'
    | 'json'
    | 'hidden';
  required?: boolean;
  defaultValue?: string | number | boolean | null | Record<string, unknown> | unknown[];
  placeholder?: string;
  help?: string;
  checkboxText?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  filterBy?: string;
  options?: Array<{ label: string; value: string; filterValue?: string }>;
};

function optionsFor(field: CommandField, values: Record<string, string>) {
  return field.filterBy
    ? field.options?.filter((option) => option.filterValue === values[field.filterBy!])
    : field.options;
}

function initialSelectValues(fields: CommandField[]) {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.type !== 'select') continue;
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
  fields,
  submitLabel = 'Save changes',
  title,
  description,
  compact = false,
  onSuccessPath,
  revealResultKey,
}: {
  action: string;
  fields: CommandField[];
  submitLabel?: string;
  title?: string;
  description?: string;
  compact?: boolean;
  onSuccessPath?: string;
  revealResultKey?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState('');
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
    setError('');
    setRevealed('');
    setPending(true);
    try {
      const payload = payloadFromForm(event.currentTarget, fields);
      const response = await fetch('/api/platform/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
      const body = (await response.json()) as {
        error?: string;
        data?: { id?: string; [key: string]: unknown };
        details?: Array<{ message?: string }>;
      };
      if (!response.ok) {
        const message = body.error ?? body.details?.[0]?.message ?? 'The command failed.';
        setError(message);
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
          return (
            <label key={field.name} className={cn('block', wide && 'sm:col-span-2')}>
              <span className="mb-1.5 block text-xs font-semibold text-text-strong">
                {field.label}
              </span>
              {field.type === 'textarea' || field.type === 'json' ? (
                <textarea
                  name={field.name}
                  required={field.required}
                  disabled={field.disabled}
                  defaultValue={
                    field.defaultValue !== null && typeof field.defaultValue === 'object'
                      ? JSON.stringify(field.defaultValue, null, 2)
                      : String(field.defaultValue ?? '')
                  }
                  placeholder={field.placeholder}
                  rows={field.type === 'json' ? 6 : 3}
                  className="w-full rounded-lg border border-border-default bg-card px-3 py-2.5 font-sans text-sm outline-none transition focus:border-accent-brand focus:ring-2 focus:ring-accent-brand/15"
                />
              ) : field.type === 'select' ? (
                <select
                  name={field.name}
                  required={field.required}
                  disabled={field.disabled}
                  value={selectValues[field.name] ?? ''}
                  onChange={(event) => updateSelect(field.name, event.target.value)}
                  className="h-11 w-full rounded-lg border border-border-default bg-card px-3 text-sm outline-none transition focus:border-accent-brand focus:ring-2 focus:ring-accent-brand/15"
                >
                  {!field.required ? <option value="">Not set</option> : null}
                  {optionsFor(field, selectValues)?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.type === 'checkbox' ? (
                <span className="flex h-11 items-center gap-2 rounded-lg border border-border-default bg-card px-3 text-xs">
                  <input
                    name={field.name}
                    type="checkbox"
                    required={field.required}
                    disabled={field.disabled}
                    defaultChecked={Boolean(field.defaultValue)}
                    className="h-4 w-4 accent-[var(--accent-brand)]"
                  />
                  {field.checkboxText ?? 'Enabled'}
                </span>
              ) : (
                <input
                  name={field.name}
                  type={field.type ?? 'text'}
                  required={field.required}
                  disabled={field.disabled}
                  defaultValue={
                    typeof field.defaultValue === 'boolean'
                      ? undefined
                      : String(field.defaultValue ?? '')
                  }
                  placeholder={field.placeholder}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  className="h-11 w-full rounded-lg border border-border-default bg-card px-3 text-sm outline-none transition focus:border-accent-brand focus:ring-2 focus:ring-accent-brand/15"
                />
              )}
              {field.help ? (
                <span className="mt-1.5 block text-[10px] leading-4 text-text-faint">
                  {field.help}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      {error ? (
        <p
          role="alert"
          className="mx-5 mb-4 rounded-[3px] border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
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
            className="mt-3 min-h-9 rounded-[3px] border border-warning/40 px-3 text-[10px] font-semibold transition hover:bg-warning/10"
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
          className="inline-flex h-10 items-center gap-2 rounded-[3px] bg-primary px-4 text-xs font-semibold text-primary-foreground shadow-[0_8px_18px_-13px_rgba(17,17,16,0.72)] transition-all hover:-translate-y-px hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60"
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
        'inline-flex min-h-10 items-center gap-2 rounded-[3px] border px-3 text-xs font-semibold transition disabled:cursor-wait disabled:opacity-60',
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
