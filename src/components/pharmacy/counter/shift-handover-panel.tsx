'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';

export function ShiftHandoverPanel({
  branchId,
  drawers,
}: {
  branchId: string;
  drawers: Array<{ id: string; label: string }>;
}) {
  const [selected, setSelected] = useState(drawers[0]?.id ?? '');
  const drawerId = drawers.some((drawer) => drawer.id === selected) ? selected : drawers[0]?.id;
  if (!drawerId) return null;
  return (
    <SectionCard
      title="Shift handover"
      titleLevel={2}
      actions={<StatusPill status="Draft" tone="neutral" />}
    >
      <div className="space-y-4">
        <label className="grid gap-2">
          Closed drawer
          <select
            className="min-h-11 w-full rounded-sm border border-border-default bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring"
            value={drawerId}
            onChange={(event) => setSelected(event.target.value)}
          >
            {drawers.map((drawer) => (
              <option key={drawer.id} value={drawer.id}>
                {drawer.label}
              </option>
            ))}
          </select>
        </label>
        <HandoverDraft
          key={`${branchId}:${drawerId}`}
          branchId={branchId}
          drawerSessionId={drawerId}
        />
      </div>
    </SectionCard>
  );
}

function HandoverDraft({
  branchId,
  drawerSessionId,
}: {
  branchId: string;
  drawerSessionId: string;
}) {
  const query = trpc.pharmacySales.shiftHandoverNote.useQuery(
    { branchId, drawerSessionId },
    {
      refetchOnWindowFocus: false,
      retry: (failures, error) => failures < 2 && error.data?.code !== 'FORBIDDEN',
    }
  );
  if (query.isLoading) return <p role="status">Preparing outstanding work and drawer cash…</p>;
  if (query.error?.data?.code === 'FORBIDDEN')
    return (
      <p role="status">
        You do not have permission to view this handover. Owner financial-report access is required.
      </p>
    );
  if (query.error || !query.data)
    return (
      <div role="alert">
        The handover could not be prepared.{' '}
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry handover
        </Button>
      </div>
    );
  return <ReviewedNote key={query.data.note} initialNote={query.data.note} />;
}

function ReviewedNote({ initialNote }: { initialNote: string }) {
  const [edited, setEdited] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [message, setMessage] = useState('');
  const [copying, setCopying] = useState(false);
  const note = edited ?? initialNote;
  return (
    <div className="space-y-4">
      <p className="text-sm text-text-muted">
        Internal draft. Outstanding work is current at preparation time; cash belongs to the
        selected drawer. Review prompts cover the branch and business day. Nothing is saved or sent.
      </p>
      <label className="grid gap-2">
        Handover note
        <Textarea
          rows={14}
          value={note}
          onChange={(event) => {
            setEdited(event.target.value);
            setReviewed(false);
            setMessage('');
          }}
        />
      </label>
      <label className="flex items-start gap-3">
        <input
          className="mt-1 size-5"
          type="checkbox"
          checked={reviewed}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        I have reviewed this draft for the next shift.
      </label>
      <div className="flex flex-wrap gap-3">
        <Button
          className="min-h-11"
          disabled={!reviewed || !note.trim() || copying}
          onClick={async () => {
            setCopying(true);
            try {
              await navigator.clipboard.writeText(note);
              setMessage('Reviewed note copied. Hand it to the next shift internally.');
            } catch {
              setMessage('Could not copy. Select the reviewed text and copy it manually.');
            } finally {
              setCopying(false);
            }
          }}
        >
          {copying ? 'Copying…' : 'Copy reviewed note'}
        </Button>
        <Button
          className="min-h-11"
          variant="outline"
          onClick={() => {
            setEdited(null);
            setReviewed(false);
            setMessage('');
          }}
        >
          Reset draft
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
