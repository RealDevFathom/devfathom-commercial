'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';

const TITLE = 'Shift handover note';

/**
 * DEV-695 — the handover note for the next shift, drawn up at drawer close. The
 * figures come from the server; the text is a local draft the owner edits and
 * copies. Nothing here saves, posts or sends anything.
 */
export function ShiftHandoverPanel({ branchId, date }: { branchId: string; date: string }) {
  const handover = trpc.pharmacySales.shiftHandoverNote.useQuery(
    { branchId, businessDate: new Date(`${date}T00:00:00.000Z`) },
    { refetchOnWindowFocus: false }
  );
  if (handover.isLoading)
    return (
      <SectionCard title={TITLE} titleLevel={2}>
        <p role="status">Drawing up the handover note…</p>
      </SectionCard>
    );
  if (handover.error?.data?.code === 'FORBIDDEN')
    return (
      <SectionCard title={TITLE} titleLevel={2}>
        <p role="status">
          You don&apos;t have permission to view the shift handover note. The close itself is
          unaffected.
        </p>
      </SectionCard>
    );
  if (handover.error || !handover.data)
    return (
      <SectionCard title={TITLE} titleLevel={2}>
        <p role="alert">
          The shift handover note is unavailable. The close itself is unaffected.{' '}
          <Button variant="outline" onClick={() => void handover.refetch()}>
            Retry handover note
          </Button>
        </p>
      </SectionCard>
    );
  // Keyed so a refreshed note replaces the draft instead of mixing with old edits.
  return <HandoverDraft key={handover.data.note} data={handover.data} />;
}

type HandoverData = {
  currency: string;
  note: string;
  pendingRx: { count: number };
  promised: { openOrders: number; overdueOrders: number; restockPromises: number };
  cash: { varianceMinor: number | null };
  flags: unknown[];
  policyVersion: string;
};

function HandoverDraft({ data }: { data: HandoverData }) {
  const [draft, setDraft] = useState(data.note);
  const [copyMessage, setCopyMessage] = useState('');
  const figures: Array<[string, string]> = [
    ['Pending Rx', String(data.pendingRx.count)],
    [
      'Open customer orders',
      data.promised.overdueOrders
        ? `${data.promised.openOrders} (${data.promised.overdueOrders} overdue)`
        : String(data.promised.openOrders),
    ],
    ['Restock promises', String(data.promised.restockPromises)],
    [
      `Cash variance · ${data.currency}`,
      data.cash.varianceMinor === null ? 'Awaiting count' : formatMinor(data.cash.varianceMinor),
    ],
  ];
  return (
    <SectionCard
      title={TITLE}
      titleLevel={2}
      actions={
        <StatusPill
          status={data.flags.length ? `Draft · ${data.flags.length} to review` : 'Draft'}
          tone={data.flags.length ? 'warning' : 'neutral'}
        />
      }
    >
      <div className="space-y-4">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {figures.map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-text-muted">{label}</dt>
              <dd className="font-mono text-xl tabular-nums" data-testid={`handover-${label}`}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <label className="grid gap-2">
          Handover note for the next shift
          <Textarea
            className="min-h-48 font-mono text-sm"
            value={draft}
            maxLength={4000}
            onChange={(e) => {
              setDraft(e.target.value);
              setCopyMessage('');
            }}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="min-h-11"
            variant="outline"
            disabled={!draft.trim()}
            onClick={() => {
              if (!navigator.clipboard) {
                setCopyMessage('Copy is not available in this browser. Select the text instead.');
                return;
              }
              navigator.clipboard.writeText(draft).then(
                () => setCopyMessage('Handover note copied.'),
                () => setCopyMessage('Could not copy. Select the text instead.')
              );
            }}
          >
            Copy note
          </Button>
          <Button
            className="min-h-11"
            variant="outline"
            disabled={draft === data.note}
            onClick={() => {
              setDraft(data.note);
              setCopyMessage('');
            }}
          >
            Reset draft
          </Button>
          <span className="text-sm text-text-muted" role="status">
            {copyMessage}
          </span>
        </div>
        <p className="text-sm text-text-muted">
          A draft from recorded figures. Review items come from the cash-close check (policy{' '}
          {data.policyVersion}). Nothing is saved, posted or sent until a person hands it over.
        </p>
      </div>
    </SectionCard>
  );
}
