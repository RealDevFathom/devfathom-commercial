'use client';
import { useActionState, useState, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SelectField } from '@/components/ui/select-field';
import type { UniversityField } from '@/lib/university/office-types';
import { performOfficeAction, type OfficeResult } from '../actions';

export function OperationForm({
  officeKey,
  actionKey,
  label,
  fields,
  confirmation,
}: {
  officeKey: string;
  actionKey: string;
  label: string;
  fields: readonly UniversityField[];
  confirmation?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, submit, pending] = useActionState(
    async (previous: OfficeResult, form: FormData) => {
      const result = await performOfficeAction(officeKey, actionKey, previous, form);
      if (result.ok) setValues({});
      return result;
    },
    { ok: true, message: '' }
  );
  function changeField(
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) {
    const { name, value } = event.currentTarget;
    setValues((previous) => ({ ...previous, [name]: value }));
  }
  return (
    <details className="rounded-md border border-border-subtle bg-card p-4">
      <summary className="cursor-pointer font-medium text-text-strong">{label}</summary>
      <form action={submit} className="mt-4 grid max-w-3xl gap-4">
        {fields.map((field) => {
          const id = `${actionKey}-${field.name}`;
          const common = {
            id,
            name: field.name,
            required: !!field.required,
            value: values[field.name] ?? '',
            onChange: changeField,
            disabled: pending,
          };
          return (
            <div key={field.name} className="grid gap-1">
              <label htmlFor={id} className="text-sm font-medium">
                {field.label}
              </label>
              {field.options ? (
                <SelectField {...common}>
                  <option value="">Choose an option</option>
                  {field.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </SelectField>
              ) : field.type === 'textarea' ? (
                <Textarea {...common} rows={4} />
              ) : (
                <Input
                  {...common}
                  type={field.type ?? 'text'}
                  step={field.type === 'number' ? 'any' : undefined}
                />
              )}
            </div>
          );
        })}
        {confirmation && (
          <label className="flex items-start gap-2 text-sm">
            <input
              name="confirmed"
              type="checkbox"
              value="yes"
              required
              disabled={pending}
              className="mt-1"
            />
            {confirmation}
          </label>
        )}
        <Button
          type="submit"
          variant={confirmation ? 'destructive' : 'default'}
          disabled={pending}
          className="w-fit"
        >
          {pending ? 'Processing…' : label}
        </Button>
        {state.message && <p role={state.ok ? 'status' : 'alert'}>{state.message}</p>}
        {state.download && (
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            onClick={() => {
              const file = state.download;
              if (!file) return;
              const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
              const link = document.createElement('a');
              link.href = url;
              link.download = file.name;
              link.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Download {state.download.name}
          </Button>
        )}
        {state.result && (
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-sunken p-3 text-sm">
            {state.result}
          </pre>
        )}
      </form>
    </details>
  );
}
