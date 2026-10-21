'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import type { GrowthTemplate } from '@/lib/growth/view';
import { renderTemplate, SAMPLE_TEMPLATE_VARS, templateIssues } from '@/lib/growth/template-text';

import { growthFieldClass, TEMPLATE_LABEL } from './format';

export function TemplateEditor({
  templates,
  save,
}: {
  templates: GrowthTemplate[];
  save: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const [id, setId] = useState(templates[0]?.id ?? '');
  const selected = templates.find((template) => template.id === id) ?? templates[0];
  const [body, setBody] = useState(selected?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const issue = templateIssues(body);
  const preview = issue ? null : renderTemplate(body, SAMPLE_TEMPLATE_VARS);

  if (!selected) {
    return <p className="text-sm text-text-muted">No templates are seeded for this shop yet.</p>;
  }

  function choose(nextId: string) {
    const next = templates.find((template) => template.id === nextId);
    setId(nextId);
    setBody(next?.body ?? '');
    setError(null);
    setSaved(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = templateIssues(body);
    if (problem) {
      setError(problem);
      setSaved(false);
      return;
    }
    const form = new FormData();
    form.set('templateId', selected.id);
    form.set('body', body);
    const result = await save(form);
    if (!result.ok) {
      setError(result.error);
      setSaved(false);
      return;
    }
    setError(null);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <label className="block text-sm text-text-body" htmlFor="template-key">
          Template
          <select
            id="template-key"
            className={growthFieldClass}
            value={selected.id}
            onChange={(event) => choose(event.target.value)}
          >
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {TEMPLATE_LABEL[template.key] ?? template.key}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-text-body" htmlFor="template-body">
          Body
          <textarea
            id="template-body"
            className={`${growthFieldClass} min-h-36 py-2`}
            value={body}
            maxLength={1000}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'template-error' : 'template-help'}
            onChange={(event) => {
              setBody(event.target.value);
              setSaved(false);
              setError(null);
            }}
          />
        </label>
        <p id="template-help" className="text-xs text-text-muted">
          Variables: name, business, discount, code, expires, product, reviewUrl, referralCode. Keep
          STOP in the message so a customer can reply band karo.
        </p>
        {error ? (
          <p id="template-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-sm text-success">
            Template saved.
          </p>
        ) : null}
        <Button type="submit" className="min-h-11">
          Save template
        </Button>
      </div>
      <div className="rounded-md border border-border-subtle bg-surface-sunken p-4">
        <p className="eyebrow">Preview</p>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-body">
          {preview ?? 'Fix the template to see it filled in for Ayesha.'}
        </p>
      </div>
    </form>
  );
}
