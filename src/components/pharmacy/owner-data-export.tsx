'use client';

import { Download, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PinAwareMessage } from '@/components/pharmacy/pin-aware-message';
import { StatusPill } from '@/components/ui/status-pill';
import type { OwnerDataExportView } from '@/lib/pharmacy/owner-data-export-format';
import { formatWorkspaceDateTime, workspaceZoneLabel } from '@/lib/timezone';

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

function when(value: string | null, timeZone: string | null | undefined): string {
  if (!value) return '—';
  return formatWorkspaceDateTime(value, timeZone);
}

function totalRows(counts: Record<string, number> | null): string {
  if (!counts) return '—';
  return Object.values(counts)
    .reduce((sum, value) => sum + value, 0)
    .toLocaleString();
}

function attachmentName(response: Response): string {
  const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
  return match?.[1] ?? 'devfathom-data-export.zip';
}

/**
 * Request an export, watch it build, download it while its 24-hour link lasts.
 * Both the request and every download send the owner's PIN in a POST body; the
 * field is cleared after each attempt so it is typed again every time.
 */
export function OwnerDataExportConsole({
  initial,
  timeZone,
}: {
  initial: OwnerDataExportView[];
  /** The organization's zone: times and the picked dates are read on its clock. */
  timeZone?: string | null;
}) {
  const [exports, setExports] = useState(initial);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinMissing, setPinMissing] = useState(false);
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

  function takePin(): string | null {
    if (!pin) {
      setPinMissing(true);
      setError('Enter your PIN to continue.');
      return null;
    }
    setPinMissing(false);
    setError(null);
    setPin('');
    return pin;
  }

  async function requestExport(event: React.FormEvent) {
    event.preventDefault();
    if (rangeInvalid) return;
    const typed = takePin();
    if (typed === null) return;
    setBusy(true);
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from || null, to: to || null, pin: typed }),
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

  async function downloadExport(id: string) {
    const typed = takePin();
    if (typed === null) return;
    setDownloading(id);
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'download', job: id, pin: typed }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'The export could not be downloaded. Try again.');
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = attachmentName(response);
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setError('The export could not be downloaded. Check your connection and try again.');
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={requestExport} className="space-y-4" noValidate>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm text-text-muted">
            Sales date range, read in your workspace timezone ({workspaceZoneLabel(timeZone)}).
            Leave both empty to include every sale.
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
        <div className="space-y-1.5 sm:max-w-xs">
          <Label htmlFor="data-export-pin">Your PIN</Label>
          <Input
            id="data-export-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(event) => {
              setPin(event.target.value);
              setPinMissing(false);
            }}
            aria-invalid={pinMissing || undefined}
            aria-describedby="data-export-pin-help"
            className="h-11"
          />
          <p id="data-export-pin-help" className="text-sm text-text-muted">
            Asked again for every request and every download.
          </p>
        </div>
        {rangeInvalid ? (
          <p id="data-export-range-error" className="text-sm text-destructive">
            The start date must be on or before the end date.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            <PinAwareMessage message={error} />
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
                    <td className="px-4 py-3">{when(item.requestedAt, timeZone)}</td>
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
                    <td className="px-4 py-3">{when(item.expiresAt, timeZone)}</td>
                    <td className="px-4 py-3 text-right">
                      {item.downloadable ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={downloading !== null}
                          onClick={() => void downloadExport(item.id)}
                        >
                          {downloading === item.id ? (
                            <Loader2 className="animate-spin" aria-hidden />
                          ) : null}
                          Download ZIP
                        </Button>
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
