'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import {
  DEFAULT_RECEIPT_LAYOUT,
  ReceiptLayoutSchema,
  type ReceiptLayout,
} from '@/lib/receipts/configuration';
import { buildReceiptPreview, SAMPLE_RECEIPT } from '@/lib/receipts/preview';

type Branch = { id: string; name: string; revision: number; layout: ReceiptLayout };
const endpoint = '/api/restaurant/receipt-layout';
const control =
  'min-h-11 w-full rounded-sm border border-border-default bg-surface-card px-3 py-2 text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export function ReceiptDesigner() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState('');
  const [draft, setDraft] = useState<ReceiptLayout>({ ...DEFAULT_RECEIPT_LAYOUT });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load receipt settings.');
        if (controller.signal.aborted) return;
        const rows: Branch[] = body.branches;
        setBranches(rows);
        setBranchId(rows[0]?.id ?? '');
        setDraft(rows[0]?.layout ?? { ...DEFAULT_RECEIPT_LAYOUT });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Unable to load receipt settings.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  const parsed = ReceiptLayoutSchema.safeParse(draft);
  const branch = branches.find((row) => row.id === branchId);
  const disabled = loading || saving || !branch;
  const dirty = branch && JSON.stringify(branch.layout) !== JSON.stringify(draft);
  const fieldError = (field: keyof ReceiptLayout) =>
    parsed.success
      ? undefined
      : parsed.error.issues.find((issue) => issue.path[0] === field)?.message;

  async function save() {
    if (!branch || !parsed.success) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchId, revision: branch.revision, layout: parsed.data }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to save receipt settings.');
      setBranches((rows) => rows.map((row) => (row.id === branchId ? { ...row, ...body } : row)));
      setMessage('Receipt layout saved for this branch.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save receipt settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="RESTAURANT SETTINGS"
        heading="Receipt designer"
        description="Choose a branch layout, preview sample facts, and save your settings."
      />
      {loading && (
        <SectionCard>
          <p role="status">Loading receipt settings…</p>
        </SectionCard>
      )}
      {error && (
        <SectionCard>
          <p role="alert" className="text-destructive">
            {error}
          </p>
          <Button
            className="mt-3 min-h-11"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setLoading(true);
              setError('');
              setMessage('');
              setReload((value) => value + 1);
            }}
          >
            Reload saved settings (discard draft)
          </Button>
        </SectionCard>
      )}
      {!loading && !error && !branches.length && (
        <SectionCard>
          <p>No active branches. Configure a restaurant branch before designing its receipt.</p>
        </SectionCard>
      )}
      {!!branches.length && (
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          <SectionCard title="Layout settings" titleLevel={2}>
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label className="block space-y-2">
                Branch
                <StudioSelect
                  className={control}
                  value={branchId}
                  disabled={disabled || !!dirty}
                  onChange={(event) => {
                    const next = branches.find((row) => row.id === event.target.value)!;
                    setBranchId(next.id);
                    setDraft(next.layout);
                    setMessage('');
                    setError('');
                  }}
                >
                  {branches.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </StudioSelect>
              </label>
              {dirty && (
                <p className="text-sm text-text-muted">
                  Save or discard your draft before switching branches.
                </p>
              )}
              <label className="block space-y-2">
                Paper width
                <StudioSelect
                  className={control}
                  value={draft.paperWidth}
                  disabled={disabled}
                  onChange={(event) =>
                    setDraft({ ...draft, paperWidth: Number(event.target.value) as 58 | 80 })
                  }
                >
                  <option value={58}>58 mm · 32 columns</option>
                  <option value={80}>80 mm · 48 columns</option>
                </StudioSelect>
              </label>
              {(['businessText', 'headerText', 'footerText'] as const).map((field) => (
                <div key={field} className="space-y-2">
                  <label htmlFor={field}>
                    {field === 'businessText'
                      ? 'Additional business text'
                      : field === 'headerText'
                        ? 'Header text'
                        : 'Footer text'}{' '}
                    ({field === 'footerText' ? 500 : 240} characters)
                  </label>
                  <textarea
                    id={field}
                    className={control}
                    rows={3}
                    maxLength={field === 'footerText' ? 500 : 240}
                    value={draft[field]}
                    disabled={disabled}
                    aria-invalid={!!fieldError(field)}
                    aria-describedby={fieldError(field) ? `${field}-error` : 'receipt-text-help'}
                    onChange={(event) => {
                      setDraft({ ...draft, [field]: event.target.value });
                      setMessage('');
                    }}
                  />
                  {fieldError(field) && (
                    <p id={`${field}-error`} className="text-sm text-destructive">
                      {fieldError(field)}
                    </p>
                  )}
                </div>
              ))}
              <p id="receipt-text-help" className="text-sm text-text-muted">
                Plain printable English text and line breaks. No markup, printer commands, or
                uploaded logos.
              </p>
              {(['showOrderNumber', 'showChannel'] as const).map((field) => (
                <label key={field} className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={draft[field]}
                    disabled={disabled}
                    onChange={(event) => setDraft({ ...draft, [field]: event.target.checked })}
                  />
                  {field === 'showOrderNumber' ? 'Show order number' : 'Show sales channel'}
                </label>
              ))}
              <p className="text-sm text-text-muted">
                Invoice identity, items, taxes, totals, payments, and change always remain visible.
                Business text supplements the recorded business name.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  className="min-h-11"
                  disabled={disabled || !parsed.success || !dirty}
                >
                  {saving ? 'Saving…' : 'Save layout'}
                </Button>
                <Button
                  type="button"
                  className="min-h-11"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    setDraft({ ...DEFAULT_RECEIPT_LAYOUT });
                    setMessage('Defaults restored to draft. Save to apply.');
                  }}
                >
                  Reset to defaults
                </Button>
                {dirty && (
                  <Button
                    type="button"
                    className="min-h-11"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      setDraft(branch!.layout);
                      setMessage('Draft discarded.');
                    }}
                  >
                    Discard draft
                  </Button>
                )}
              </div>
              <p role="status" className="text-sm text-text-muted">
                {message}
              </p>
            </form>
          </SectionCard>
          <SectionCard title="Sample preview" titleLevel={2}>
            <p className="mb-4 text-sm text-text-muted">
              Sample amounts only. Layout preview does not confirm printer delivery. Printer font
              and printable width require device verification.
            </p>
            {parsed.success ? (
              <pre
                aria-label="Sample receipt"
                className="max-w-full whitespace-pre-wrap break-all rounded-sm border border-border-subtle bg-surface-page p-4 font-mono text-xs text-text-strong"
              >
                {buildReceiptPreview(parsed.data, SAMPLE_RECEIPT)}
              </pre>
            ) : (
              <p role="status">Fix the marked fields to update the preview.</p>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}
