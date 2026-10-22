'use client';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { ScheduledDiscountDraft } from '@/lib/ai/shared/discount-scheduler.types';

export function DiscountApprovalPanel({
  drafts,
  onApprove,
  onEdit,
  onReject,
}: {
  drafts: ScheduledDiscountDraft[];
  onApprove: (id: string) => void;
  onEdit: (draft: ScheduledDiscountDraft) => void;
  onReject: (id: string) => void;
}) {
  return (
    <SectionCard title="DevFathom AI" titleLevel={2}>
      <p className="mb-4 text-sm text-text-muted">
        Review scheduled discount drafts. Approval does not activate a discount before its window.
      </p>
      {drafts.length === 0 ? (
        <p>No discount drafts await review.</p>
      ) : (
        <div className="space-y-4">
          {drafts.map((draft) => (
            <article className="space-y-3 border-t border-border-subtle py-4" key={draft.id}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold">{draft.name}</h3>
                <StatusPill status={draft.status} />
              </div>
              <p className="text-sm text-text-muted">
                {draft.percentage}% · {draft.startsAt.toLocaleString()}–
                {draft.endsAt.toLocaleString()}
              </p>
              {draft.status === 'SCHEDULED' && (
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => onEdit(draft)}>
                    Edit
                  </Button>
                  <Button variant="destructive" onClick={() => onReject(draft.id)}>
                    Reject
                  </Button>
                  <Button onClick={() => onApprove(draft.id)}>Approve</Button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
