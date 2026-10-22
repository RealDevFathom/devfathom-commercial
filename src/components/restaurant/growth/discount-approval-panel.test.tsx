import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduledDiscountDraft } from '@/lib/ai/shared/discount-scheduler.types';
import { DiscountApprovalPanel } from './discount-approval-panel';

const draft = (status: ScheduledDiscountDraft['status'] = 'SCHEDULED'): ScheduledDiscountDraft => ({
  id: 'draft-1',
  orgId: 'org-abbasi',
  name: 'Quiet lunch',
  percentage: 10,
  startsAt: new Date('2026-10-22T10:00:00Z'),
  endsAt: new Date('2026-10-22T14:00:00Z'),
  status,
  model: 'growth-model',
  tier: 'standard',
});

describe('DiscountApprovalPanel', () => {
  it('labels the surface DevFathom AI and wires the scheduled-draft review actions', () => {
    const onApprove = vi.fn();
    const onEdit = vi.fn();
    const onReject = vi.fn();
    const value = draft();

    render(
      <DiscountApprovalPanel
        drafts={[value]}
        onApprove={onApprove}
        onEdit={onEdit}
        onReject={onReject}
      />
    );

    expect(screen.getByRole('heading', { name: 'DevFathom AI' })).toBeInTheDocument();
    expect(screen.getByText('Quiet lunch')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onEdit).toHaveBeenCalledWith(value);
    expect(onReject).toHaveBeenCalledWith('draft-1');
    expect(onApprove).toHaveBeenCalledWith('draft-1');
  });

  it('does not offer money actions for a terminal draft', () => {
    render(
      <DiscountApprovalPanel
        drafts={[draft('REJECTED')]}
        onApprove={vi.fn()}
        onEdit={vi.fn()}
        onReject={vi.fn()}
      />
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the review-safe empty state', () => {
    render(
      <DiscountApprovalPanel drafts={[]} onApprove={vi.fn()} onEdit={vi.fn()} onReject={vi.fn()} />
    );
    expect(screen.getByText('No discount drafts await review.')).toBeInTheDocument();
  });
});
