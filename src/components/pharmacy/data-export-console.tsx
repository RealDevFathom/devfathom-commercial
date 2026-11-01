'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { formatKarachiDateTime } from '@/lib/pharmacy/karachi-time';
import { trpc } from '@/lib/trpc';

const controlClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-body outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive';

export type DataExportItem = {
  id: string;
  status: 'QUEUED' | 'READY' | 'FAILED' | 'EXPIRED';
  salesFrom: string;
  salesTo: string;
  requestedAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
  sizeBytes: number | null;
  rowCounts: Record<string, number> | null;
  downloadCount: number;
  downloadable: boolean;
  error: string | null;
};

const STATUS: Record<DataExportItem['status'], { label: string; tone: StatusTone }> = {
  QUEUED: { label: 'Preparing', tone: 'warning' },
  READY: { label: 'Ready', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  EXPIRED: { label: 'Link expired', tone: 'neutral' },
};

function karachiToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function totalRows(counts: Record<string, number> | null): number | null {
  if (!counts) return null;
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

export function DataExportPanel({
  exports,
  pending,
  notice,
  today,
  downloading = null,
  onRequest,
  onDownload,
}: {
  exports: readonly DataExportItem[];
  pending: boolean;
  notice: string | null;
  today: string;
  /** The export id whose archive is being fetched, if any. */
  downloading?: string | null;
  onRequest: (input: { from: string; to: string; pin: string }) => void;
  onDownload: (input: { id: string; pin: string }) => void;
}) {
  const [from, setFrom] = useState(daysBefore(today, 365));
  const [to, setTo] = useState(today);
  const [pin, setPin] = useState('');
  const [pinMissing, setPinMissing] = useState(false);
  const invalid = !from || !to || from > to || to > today;
  const preparing = exports.some((item) => item.status === 'QUEUED');

  // The PIN is re-entered for every request and every download, never kept.
  function takePin(): string | null {
    if (!pin) {
      setPinMissing(true);
      return null;
    }
    const entered = pin;
    setPin('');
    setPinMissing(false);
    return entered;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid || pending) return;
    const entered = takePin();
    if (entered) onRequest({ from, to, pin: entered });
  }

  function download(id: string) {
    if (downloading) return;
    const entered = takePin();
    if (entered) onDownload({ id, pin: entered });
  }

  return (
    <div className="space-y-6">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit} noValidate>
        <div>
          <Label htmlFor="pharmacy-export-from">Sales from</Label>
          <input
            className={controlClass}
            id="pharmacy-export-from"
            type="date"
            value={from}
            max={to || today}
            aria-invalid={invalid}
            aria-describedby="pharmacy-export-range-help"
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="pharmacy-export-to">Sales to</Label>
          <input
            className={controlClass}
            id="pharmacy-export-to"
            type="date"
            value={to}
            max={today}
            aria-invalid={invalid}
            aria-describedby="pharmacy-export-range-help"
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        <p className="text-sm text-text-muted sm:col-span-2" id="pharmacy-export-range-help">
          {invalid
            ? 'Choose a start date on or before the end date, ending today or earlier.'
            : 'The range applies to sales; medicines, stock, customers, suppliers, purchases and the controlled register are always exported in full. Up to 366 days per export.'}
        </p>
        <div className="sm:col-span-2 sm:max-w-xs">
          <Label htmlFor="pharmacy-export-pin">Your PIN</Label>
          <input
            className={controlClass}
            id="pharmacy-export-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            aria-invalid={pinMissing}
            aria-describedby="pharmacy-export-pin-help"
            onChange={(event) => {
              setPin(event.target.value);
              if (event.target.value) setPinMissing(false);
            }}
          />
          <p className="mt-1 text-sm text-text-muted" id="pharmacy-export-pin-help">
            {pinMissing
              ? 'Enter your PIN to continue.'
              : 'The export contains patient records, so your PIN is needed to request and to download it.'}
          </p>
        </div>
        <div className="sm:col-span-2">
          <Button className="min-h-11" type="submit" disabled={invalid || pending || preparing}>
            {pending ? 'Requesting…' : preparing ? 'Export being prepared' : 'Download my data'}
          </Button>
        </div>
      </form>
      {notice ? (
        <p className="text-sm text-text-body" role="status">
          {notice}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle">
              {['Requested', 'Sales range', 'Status', 'Rows', 'Size', 'Link'].map((label) => (
                <th
                  className={`px-2 py-2 font-mono text-[0.625rem] font-semibold tracking-wide text-text-muted uppercase ${
                    label === 'Rows' || label === 'Size' || label === 'Link' ? 'text-right' : ''
                  }`}
                  key={label}
                  scope="col"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {exports.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-text-body" colSpan={6}>
                  No export yet. Choose a sales range and select Download my data; the archive is
                  ready here within a few minutes.
                </td>
              </tr>
            ) : (
              exports.map((item) => {
                const status = STATUS[item.status];
                const rows = totalRows(item.rowCounts);
                return (
                  <tr className="border-b border-border-subtle hover:bg-surface-sunken" key={item.id}>
                    <td className="px-2 py-3 text-text-body">
                      {formatKarachiDateTime(new Date(item.requestedAt))}
                    </td>
                    <td className="px-2 py-3 font-mono text-text-body tabular-nums">
                      {item.salesFrom} – {item.salesTo}
                    </td>
                    <td className="px-2 py-3">
                      <StatusPill status={item.status} tone={status.tone} label={status.label} />
                      {item.error ? (
                        <span className="mt-1 block text-xs text-text-muted">{item.error}</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-3 text-right font-mono text-text-body tabular-nums">
                      {rows === null ? '—' : rows.toLocaleString('en-PK')}
                    </td>
                    <td className="px-2 py-3 text-right font-mono text-text-body tabular-nums">
                      {formatSize(item.sizeBytes)}
                    </td>
                    <td className="px-2 py-3 text-right">
                      {item.downloadable ? (
                        <span className="inline-flex flex-col items-end gap-1">
                          <Button
                            className="min-h-11"
                            type="button"
                            variant="outline"
                            disabled={downloading !== null}
                            onClick={() => download(item.id)}
                          >
                            {downloading === item.id ? 'Downloading…' : 'Download ZIP'}
                          </Button>
                          {item.expiresAt ? (
                            <span className="text-xs text-text-muted">
                              Until {formatKarachiDateTime(new Date(item.expiresAt))}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
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

/**
 * POST the PIN with the export id (never in a URL) and save the attachment.
 * Returns the server's refusal text, or null once the file has been saved.
 */
export async function downloadExportArchive(input: { id: string; pin: string }): Promise<string | null> {
  const response = await fetch('/api/pharmacy/data-export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) return (await response.text()) || 'Export unavailable.';
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'devfathom-pharmacy-export.zip';
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return null;
}

export function DataExportConsole({ initial }: { initial: DataExportItem[] }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [today] = useState(() => karachiToday(new Date()));
  const list = trpc.pharmacyDataExport.list.useQuery(undefined, {
    initialData: initial,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === 'QUEUED') ? 10_000 : false,
  });
  const request = trpc.pharmacyDataExport.request.useMutation({
    onSuccess: async (result) => {
      setNotice(
        result.created
          ? 'Export requested. It appears below with a download link when ready; the link works for 24 hours.'
          : 'An export is already being prepared. It appears below when ready.'
      );
      await list.refetch();
    },
    onError: (error) => setNotice(error.message),
  });
  return (
    <DataExportPanel
      exports={list.data ?? initial}
      notice={notice}
      pending={request.isPending}
      today={today}
      downloading={downloading}
      onRequest={(input) => request.mutate(input)}
      onDownload={(input) => {
        setDownloading(input.id);
        setNotice(null);
        void downloadExportArchive(input)
          .then((refusal) => {
            if (refusal) setNotice(refusal);
          })
          .catch(() => setNotice('Export unavailable. Try again shortly.'))
          .finally(async () => {
            setDownloading(null);
            await list.refetch();
          });
      }}
    />
  );
}
