'use client';

import { Download, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import type { OwnerDataExportView } from '@/lib/pharmacy/owner-data-export-format';

const ENDPOINT = '/api/pharmacy/data-export';
const POLL_MS = 10_000;

const STATUS_LABEL: Record<
  string,
  { label: string; tone: 'info' | 'success' | 'danger' | 'neutral' }
> = {
  QUEUED: { label: 'Preparing', tone: 'info' },
  RUNNING: { label: 'Preparing', tone: 'info' },
  SUCCEEDED: { label: 'Ready', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

function when(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function totalRows(counts: Record<string, number> | null): string {
  if (!counts) return '—';
  return Object.values(counts)
    .reduce((sum, value) => sum + value, 0)
    .toLocaleString();
}

/** Request an export, watch it build, download it while its 24-hour link lasts. */
export function OwnerDataExportConsole({ initial }: { initial: OwnerDataExportView[] }) {
  const [exports, setExports] = useState(initial);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rangeInvalid = Boolean(from && to && from > to);
  const pending = exports.some((item) => item.status === 'QUEUED' || item.status === 'RUNNING');

  const refresh = useCallback(async () => {
    const response = await fetch(ENDPOINT, { cache: 'no-store' });
    if (!response.ok) return;
    const body = (await response.json()) as { exports: OwnerDataExportView[] };
    setExports(body.exports);
  }, []);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  async function requestExport(event: React.FormEvent) {
    event.preventDefault();
    if (rangeInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from || null, to: to || null }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? 'The export could not be requested. Try again.');
        return;
      }
      await refresh();
    } catch {
      setError('The export could not be requested. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={requestExport} className="space-y-4" noValidate>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm text-text-muted">
            Sales date range. Leave both empty to include every sale.
          </legend>
          <div className="space-y-1.5">
            <Label htmlFor="data-export-from">Sales from</Label>
            <Input
              id="data-export-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
              aria-invalid={rangeInvalid || undefined}
              aria-describedby={rangeInvalid ? 'data-export-range-error' : undefined}
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="data-export-to">Sales to</Label>
            <Input
              id="data-export-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
              aria-invalid={rangeInvalid || undefined}
              aria-describedby={rangeInvalid ? 'data-export-range-error' : undefined}
              className="h-11"
            />
          </div>
        </fieldset>
        {rangeInvalid ? (
          <p id="data-export-range-error" className="text-sm text-destructive">
            The start date must be on or before the end date.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="h-11 px-5" disabled={busy || pending || rangeInvalid}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
          {pending ? 'Export in progress' : 'Download my data'}
        </Button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left font-mono text-xs uppercase text-text-muted">
              <th scope="col" className="px-4 py-3 font-medium">
                Requested
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Rows
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Link expires
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {exports.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-text-muted">
                  No exports yet. Request one above; it is ready in a few minutes.
                </td>
              </tr>
            ) : (
              exports.map((item) => {
                const status = STATUS_LABEL[item.status] ?? {
                  label: item.status,
                  tone: 'neutral' as const,
                };
                const expired = item.status === 'SUCCEEDED' && !item.downloadable;
                return (
                  <tr
                    key={item.id}
                    className="border-b border-border last:border-0 hover:bg-muted/50"
                  >
                    <td className="px-4 py-3">{when(item.requestedAt)}</td>
                    <td className="px-4 py-3">
                      <StatusPill
                        status={expired ? 'expired' : item.status}
                        tone={expired ? 'neutral' : status.tone}
                        label={expired ? 'Expired' : status.label}
                      />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {totalRows(item.rowCounts)}
                    </td>
                    <td className="px-4 py-3">{when(item.expiresAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {item.downloadable ? (
                        <a
                          href={`${ENDPOINT}?job=${encodeURIComponent(item.id)}`}
                          className={buttonVariants({ variant: 'outline', size: 'sm' })}
                          download
                        >
                          Download ZIP
                        </a>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
