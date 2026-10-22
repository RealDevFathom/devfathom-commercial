'use client';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { ScheduledDiscountDraft } from '@/lib/ai/shared/discount-scheduler.types';
import {
  DISCOUNT_APPROVAL_DIRECTION,
  DISCOUNT_APPROVAL_MESSAGES,
  type DiscountApprovalLocale,
} from './discount-approval-messages';

export function DiscountApprovalPanel({
  drafts,
  onApprove,
  onEdit,
  onReject,
  locale = 'en',
}: {
  drafts: ScheduledDiscountDraft[];
  onApprove: (id: string) => void;
  onEdit: (draft: ScheduledDiscountDraft) => void;
  onReject: (id: string) => void;
  locale?: DiscountApprovalLocale;
}) {
  const messages = DISCOUNT_APPROVAL_MESSAGES[locale];
  const dateLocale = locale === 'ur' ? 'ur-PK' : 'en';

  return (
    <SectionCard title={messages.title} titleLevel={2}>
      <div lang={locale} dir={DISCOUNT_APPROVAL_DIRECTION[locale]}>
        <p className="mb-4 text-sm text-text-muted">{messages.description}</p>
        {drafts.length === 0 ? (
          <p>{messages.empty}</p>
        ) : (
          <div className="space-y-4">
            {drafts.map((draft) => (
              <article className="space-y-3 border-t border-border-subtle py-4" key={draft.id}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold">{draft.name}</h3>
                  <StatusPill status={draft.status} label={messages.statuses[draft.status]} />
                </div>
                <p className="text-sm text-text-muted">
                  <bdi>{draft.percentage}%</bdi> ·{' '}
                  <bdi>{draft.startsAt.toLocaleString(dateLocale)}</bdi>
                  {' – '}
                  <bdi>{draft.endsAt.toLocaleString(dateLocale)}</bdi>
                </p>
                {draft.status === 'SCHEDULED' && (
                  <div className="flex flex-wrap gap-3">
                    <Button variant="outline" onClick={() => onEdit(draft)}>
                      {messages.edit}
                    </Button>
                    <Button variant="destructive" onClick={() => onReject(draft.id)}>
                      {messages.reject}
                    </Button>
                    <Button onClick={() => onApprove(draft.id)}>{messages.approve}</Button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
