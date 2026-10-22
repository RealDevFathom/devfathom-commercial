'use client';

import { useState } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';

export function SupportAccessForm({ organizationId }: { organizationId: string }) {
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('30');
  const [pending, setPending] = useState(false);

  async function start() {
    // Pop-up blockers only allow a window to be opened synchronously from the
    // click gesture. Reserve it before the network request, sever the opener,
    // then navigate it once the one-use launch ticket is ready.
    const launchWindow = window.open('about:blank', '_blank');
    if (launchWindow) launchWindow.opener = null;
    setPending(true);
    try {
      const response = await fetch('/api/platform/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          reason,
          durationMinutes: Number(duration),
        }),
      });
      const body = (await response.json()) as { error?: string; launchUrl?: string };
      if (!response.ok || !body.launchUrl) {
        launchWindow?.close();
        toast.error(body.error ?? 'Support access could not be started.');
        return;
      }
      toast.success('Support access started');
      if (launchWindow && !launchWindow.closed) {
        launchWindow.location.replace(body.launchUrl);
      } else {
        window.location.assign(body.launchUrl);
      }
    } catch {
      launchWindow?.close();
      toast.error('Support access could not be started.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={3}
        minLength={10}
        maxLength={500}
        placeholder="Why support access is necessary (recorded in the audit ledger)"
        className="w-full rounded-lg border border-border-default bg-card px-3 py-2.5 text-sm outline-none focus:border-accent-brand"
      />
      <div className="flex items-end gap-3">
        <label className="grid gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-primary-foreground">
            Access duration
          </span>
          <select
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            className="h-11 w-full rounded-lg border border-border-default bg-card px-3 text-xs"
          >
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">60 minutes</option>
          </select>
        </label>
        <button
          type="button"
          onClick={start}
          disabled={pending || reason.trim().length < 10}
          className="inline-flex h-11 items-center gap-2 rounded-sm bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          {pending ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )}
          Start audited access
        </button>
      </div>
    </div>
  );
}
