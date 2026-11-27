'use client';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { encodeQr, qrSvgPath } from '@/lib/qr/qr-code';

type Design = {
  programDisplayName: string;
  backgroundColor: string;
  foregroundColor: string;
  enabled: boolean;
  logo: string | null;
};
type Branch = { id: string; name: string };
type Props = {
  design: Design;
  mode: 'TEST' | 'DEMO' | 'LIVE';
  branches: Branch[];
  onSave: (input: Design) => Promise<unknown>;
  onPoster: (branchId: string) => Promise<string>;
};

export function WalletEditor({ design, mode, branches, onSave, onPoster }: Props) {
  const [draft, setDraft] = useState(design),
    [saved, setSaved] = useState(design);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [poster, setPoster] = useState<{ branch: Branch; url: string } | null>(null);
  const matrix = poster ? encodeQr(poster.url) : null;
  function edit<K extends keyof Design>(key: K, value: Design[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setMessage('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await onSave(draft);
      setSaved(draft);
      setPoster(null);
      setMessage('Card design saved.');
    } catch {
      setError('Could not save the design. Check the programme name and PNG logo, then try again.');
    } finally {
      setBusy(false);
    }
  }
  async function showPoster(branch: Branch) {
    setBusy(true);
    setError('');
    try {
      const path = await onPoster(branch.id);
      setPoster({ branch, url: new URL(path, window.location.origin).toString() });
    } catch {
      setError('The branch poster could not be prepared.');
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    setError('');
    if (file.type !== 'image/png' || file.size > 256 * 1024) {
      setError('Choose a PNG no larger than 256 KB.');
      return;
    }
    setBusy(true);
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      edit('logo', result);
    } catch {
      setError('The image could not be read.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        heading="Wallet loyalty card"
        description="Design the card shoppers carry and print a joining poster for each branch."
        actions={<StatusPill status={mode} />}
      />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <SectionCard title="Card design">
          <form className="space-y-5" onSubmit={submit}>
            <fieldset disabled={busy} className="space-y-5">
              <label className="grid gap-2 text-sm font-medium">
                Programme name
                <Input
                  required
                  maxLength={64}
                  value={draft.programDisplayName}
                  onChange={(e) => edit('programDisplayName', e.target.value)}
                />
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Logo (PNG, up to 256 KB)
                <Input
                  type="file"
                  accept="image/png"
                  onChange={(e) => void upload(e.target.files?.[0])}
                />
              </label>
              {draft.logo && (
                <Button type="button" variant="outline" onClick={() => edit('logo', null)}>
                  Remove logo
                </Button>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {(['backgroundColor', 'foregroundColor'] as const).map((key) => (
                  <label key={key} className="grid gap-2 text-sm font-medium">
                    {key === 'backgroundColor' ? 'Background colour' : 'Text colour'}
                    <Input
                      type="color"
                      className="h-11"
                      value={draft[key]}
                      onChange={(e) => edit(key, e.target.value)}
                    />
                  </label>
                ))}
              </div>
              <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
                <input
                  className="size-5 accent-primary"
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => edit('enabled', e.target.checked)}
                />
                Enable card programme
              </label>
              <Button className="min-h-11" type="submit">
                {busy ? 'Please wait…' : 'Save design'}
              </Button>
            </fieldset>
          </form>
        </SectionCard>
        <SectionCard title="Live preview">
          <section
            aria-label="Card preview"
            className="space-y-6 rounded-lg border border-border-default p-6"
            style={{ backgroundColor: draft.backgroundColor, color: draft.foregroundColor }}
          >
            {draft.logo && (
              <img
                alt=""
                src={'data:image/png;base64,' + draft.logo}
                className="h-12 max-w-full object-contain"
              />
            )}
            <h3 className="break-words text-2xl font-semibold">{draft.programDisplayName}</h3>
            <div>
              <div className="text-sm">Points</div>
              <strong className="font-mono text-3xl">125</strong>
            </div>
          </section>
          <p className="mt-4 text-sm text-text-muted">
            {mode === 'TEST'
              ? 'TEST · Unsigned sample. Its QR works at the counter.'
              : mode === 'DEMO'
                ? 'DEMO · Google Wallet test accounts only.'
                : 'LIVE · Issuer-signed wallet cards.'}
          </p>
        </SectionCard>
      </div>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <SectionCard title="Branch posters">
        <div className="flex flex-wrap gap-3">
          {saved.enabled ? (
            branches.length ? (
              branches.map((branch) => (
                <Button
                  disabled={busy}
                  key={branch.id}
                  variant="outline"
                  onClick={() => void showPoster(branch)}
                >
                  {branch.name} poster
                </Button>
              ))
            ) : (
              <p>No active branches.</p>
            )
          ) : (
            <p>Enable and save the programme to prepare branch posters.</p>
          )}
        </div>
        {poster && matrix && (
          <>
            <section
              id="wallet-branch-poster"
              className="mt-6 space-y-4 border-t border-border-default pt-6 text-center"
            >
              <h3 className="text-2xl font-semibold">{saved.programDisplayName}</h3>
              <p>Scan to join at {poster.branch.name}</p>
              <svg
                className="mx-auto size-48 max-w-full bg-white"
                role="img"
                aria-label={poster.branch.name + ' enrollment QR'}
                viewBox={'0 0 ' + (matrix.length + 8) + ' ' + (matrix.length + 8)}
                shapeRendering="crispEdges"
              >
                <rect width="100%" height="100%" fill="white" />
                <path d={qrSvgPath(matrix)} fill="black" />
              </svg>
            </section>
            <Button className="mt-4" variant="outline" onClick={() => window.print()}>
              Print poster
            </Button>
            <style>
              {
                '@media print { body * { visibility: hidden; } #wallet-branch-poster, #wallet-branch-poster * { visibility: visible; } #wallet-branch-poster { position: absolute; inset: 0; margin: 0; padding: 2cm; border: 0; } }'
              }
            </style>
          </>
        )}
      </SectionCard>
    </div>
  );
}
