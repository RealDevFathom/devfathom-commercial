'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useId, useState } from 'react';

import { fieldClass, WorkspaceState } from '@/components/pharmacy/dispensing/field';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';

import {
  businessDay,
  errorCode,
  errorMessage,
  formatWhen,
  isNoStaffProfile,
  ROLE_LABEL,
  statusCopy,
  type SopAccess,
  type SopBoard,
  type SopBoardItem,
} from './sop-model';

export type SopBoardViewProps = {
  pharmacyBranchId: string;
  timezone: string | null;
  access: SopAccess;
  onOpen: (occurrenceId: string) => void;
  onSetup: () => void;
  onNotice: (notice: { tone: 'success' | 'danger'; text: string }) => void;
};

export function SopBoardView({
  pharmacyBranchId,
  timezone,
  access,
  onOpen,
  onSetup,
  onNotice,
}: SopBoardViewProps) {
  const utils = trpc.useUtils();
  const board = trpc.pharmacySop.board.useQuery({ pharmacyBranchId }, { retry: false });
  const [claimError, setClaimError] = useState<string | null>(null);
  const claim = trpc.pharmacySop.claim.useMutation({
    onSuccess: async () => {
      setClaimError(null);
      onNotice({ tone: 'success', text: 'Claimed. It is now in your work.' });
      await utils.pharmacySop.board.invalidate({ pharmacyBranchId });
    },
    onError: async (cause) => {
      setClaimError(errorMessage(cause, 'That procedure could not be claimed. Retry.'));
      // Someone else may have taken it; show the pool as it is now.
      if (errorCode(cause) === 'CONFLICT')
        await utils.pharmacySop.board.invalidate({ pharmacyBranchId });
    },
  });

  if (board.isLoading) {
    return <WorkspaceState title="Loading today's work">Reading this branch.</WorkspaceState>;
  }
  if (isNoStaffProfile(board.error)) {
    return <JoinSitePrompt pharmacyBranchId={pharmacyBranchId} />;
  }
  if (board.error || !board.data) {
    return (
      <WorkspaceState title="Today's work could not be loaded" tone="danger">
        <p>{errorMessage(board.error, 'Nothing was changed. Retry when you are ready.')}</p>
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="mt-3"
          onClick={() => void board.refetch()}
        >
          Retry
        </Button>
      </WorkspaceState>
    );
  }

  const data: SopBoard = board.data;
  const nothing = data.mine.length === 0 && data.pool.length === 0;
  // The review count only means something to someone who reviews here.
  const reviewer = access.canVerify && data.canReview;

  return (
    <div className="grid min-w-0 gap-6">
      <section
        aria-label="Today at this branch"
        className={`grid grid-cols-1 gap-4 rounded-lg border border-border-subtle bg-card p-5 ${
          reviewer ? 'min-[420px]:grid-cols-3' : 'min-[420px]:grid-cols-2'
        }`}
      >
        <Stat label="Overdue" value={data.counts.overdue} valueClassName="text-[1.75rem]" />
        <Stat label="Due today" value={data.counts.dueToday} valueClassName="text-[1.75rem]" />
        {reviewer ? (
          <Stat
            label="Awaiting review"
            value={data.counts.awaitingReview}
            valueClassName="text-[1.75rem]"
          />
        ) : null}
      </section>

      {claimError ? (
        <p className="text-sm text-destructive" role="alert">
          {claimError}
        </p>
      ) : null}

      {nothing ? (
        <SectionCard title="No work right now">
          <p className="text-sm text-text-muted" role="status">
            {access.canManage
              ? "Nothing is due at this branch. To add work from your schedules, use 'Create work from schedules now' in Setup; on-demand procedures can be started below."
              : 'Nothing is due for you at this branch. New work appears here when it is scheduled or given to your role.'}
          </p>
          {access.canManage ? (
            <Button type="button" variant="outline" size="touch" className="mt-3" onClick={onSetup}>
              Open setup
            </Button>
          ) : null}
        </SectionCard>
      ) : (
        <div className="grid min-w-0 gap-6 xl:grid-cols-2">
          <WorkList
            title="My work"
            empty="Nothing is assigned to you right now."
            items={data.mine}
            today={data.businessDate}
            timezone={timezone}
            action={(item) => (
              <Button
                id={`sop-open-${item.occurrenceId}`}
                type="button"
                variant="outline"
                size="touch"
                className={ROW_ACTION}
                aria-label={`Open ${item.templateName}`}
                onClick={() => onOpen(item.occurrenceId)}
              >
                Open
              </Button>
            )}
          />
          <WorkList
            title="Role pool"
            description="Anyone holding the role can take these. Claim one to make it yours."
            empty="Nothing is waiting in your role's pool."
            items={data.pool}
            today={data.businessDate}
            timezone={timezone}
            action={(item) =>
              access.canComplete && !item.claimed ? (
                <Button
                  type="button"
                  size="touch"
                  className={ROW_ACTION}
                  disabled={claim.isPending}
                  aria-label={`Claim ${item.templateName}`}
                  onClick={() =>
                    claim.mutate({ pharmacyBranchId, occurrenceId: item.occurrenceId })
                  }
                >
                  {claim.isPending && claim.variables?.occurrenceId === item.occurrenceId
                    ? 'Claiming…'
                    : 'Claim'}
                </Button>
              ) : null
            }
          />
        </div>
      )}

      {access.canComplete ? (
        <StartOnDemand pharmacyBranchId={pharmacyBranchId} onStarted={onOpen} onNotice={onNotice} />
      ) : null}
    </div>
  );
}

function DueState({ item }: { item: SopBoardItem }) {
  const status = statusCopy(item.status);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {item.overdue ? <StatusPill status="overdue" tone="danger" label="Overdue" /> : null}
      {item.escalated ? (
        <StatusPill status="escalated" tone="warning" label="Manager notified" />
      ) : null}
      {!item.overdue && item.missedRisk ? (
        <StatusPill status="due-soon" tone="warning" label="Closing soon" />
      ) : null}
      <StatusPill status={item.status} tone={status.tone} label={status.label} />
    </span>
  );
}

/**
 * Row and form actions share one width rule: full width on a phone, their own
 * width from `sm` up, so Open, Claim and Start line up at 375px.
 */
const ROW_ACTION = 'w-full sm:w-auto';

/**
 * Board items arrive ordered by due time over a window that reaches into
 * tomorrow, so tomorrow's work is grouped under its own label instead of
 * reading as due today.
 */
function WorkList({
  title,
  description,
  empty,
  items,
  today,
  timezone,
  action,
}: {
  title: string;
  description?: string;
  empty: string;
  items: SopBoardItem[];
  /** The branch business date (YYYY-MM-DD) the board was read for. */
  today: string;
  timezone: string | null;
  action: (item: SopBoardItem) => React.ReactNode;
}) {
  const later = items.filter((item) => businessDay(item.businessDate) > today);
  const current = items.filter((item) => businessDay(item.businessDate) <= today);
  const row = (item: SopBoardItem) => (
    <li
      key={item.occurrenceId}
      className={`grid gap-3 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${
        item.overdue ? 'border-destructive/40' : 'border-border-subtle'
      }`}
    >
      <div className="min-w-0">
        <p className="font-medium break-words text-text-strong">{item.templateName}</p>
        <p className="mt-1 text-xs text-text-muted">
          Due {formatWhen(item.dueAt, timezone)} · {item.stepsCompleted} of {item.stepsTotal} steps
          done
          {item.poolRoleKey ? ` · ${ROLE_LABEL[item.poolRoleKey]}` : ''}
        </p>
        <div className="mt-2">
          <DueState item={item} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">{action(item)}</div>
    </li>
  );
  return (
    <SectionCard
      className="min-w-0"
      title={title}
      actions={
        <span className="font-mono text-xs text-text-muted tabular-nums">{items.length}</span>
      }
    >
      {description ? <p className="-mt-2 mb-4 text-sm text-text-muted">{description}</p> : null}
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">{empty}</p>
      ) : (
        <div className="grid gap-4">
          {current.length ? (
            <ul className="grid gap-2" aria-label={title}>
              {current.map(row)}
            </ul>
          ) : null}
          {later.length ? (
            <div className="grid gap-2">
              <p className="eyebrow" aria-hidden>
                Tomorrow
              </p>
              <ul className="grid gap-2" aria-label={`${title}, tomorrow`}>
                {later.map(row)}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

function StartOnDemand({
  pharmacyBranchId,
  onStarted,
  onNotice,
}: {
  pharmacyBranchId: string;
  onStarted: (occurrenceId: string) => void;
  onNotice: SopBoardViewProps['onNotice'];
}) {
  const id = useId();
  const utils = trpc.useUtils();
  const [templateId, setTemplateId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const templates = trpc.pharmacySop.onDemandTemplates.useQuery(
    { pharmacyBranchId },
    { retry: false }
  );
  const startOnDemand = trpc.pharmacySop.startOnDemand.useMutation({
    onSuccess: async (result) => {
      setError(null);
      setTemplateId('');
      await utils.pharmacySop.board.invalidate({ pharmacyBranchId });
      if (!result.created) {
        onNotice({
          tone: 'success',
          text: 'You already have this procedure open. Carry on below.',
        });
      }
      onStarted(result.occurrenceId);
    },
    onError: (cause) => setError(errorMessage(cause, 'The procedure could not be started. Retry.')),
  });
  const onDemand = templates.data ?? [];
  if (!templates.data || onDemand.length === 0) return null;

  return (
    <SectionCard title="Start a procedure now">
      <p className="-mt-2 mb-4 text-sm text-text-muted">
        For things that happen without a schedule, such as a delivery or an incident.
      </p>
      <form
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (!templateId) {
            setError('Choose which procedure to start.');
            return;
          }
          startOnDemand.mutate({ pharmacyBranchId, templateId });
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium text-text-strong" htmlFor={id}>
          <span>Procedure</span>
          <StudioSelect
            id={id}
            className={fieldClass}
            value={templateId}
            aria-invalid={error ? true : undefined}
            disabled={startOnDemand.isPending}
            onChange={(event) => setTemplateId(event.target.value)}
          >
            <option value="">Select…</option>
            {onDemand.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </StudioSelect>
        </label>
        <Button
          type="submit"
          size="touch"
          className={ROW_ACTION}
          disabled={startOnDemand.isPending}
        >
          {startOnDemand.isPending ? 'Starting…' : 'Start'}
        </Button>
      </form>
      {error ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </SectionCard>
  );
}

/**
 * Shown when the board refuses because this person has no procedures profile
 * at the branch yet. Setting it up is explicit and idempotent (joinSite); it
 * gives no role — a manager still decides those in Setup.
 */
export function JoinSitePrompt({ pharmacyBranchId }: { pharmacyBranchId: string }) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const join = trpc.pharmacySop.joinSite.useMutation({
    onSuccess: async () => {
      setError(null);
      await Promise.all([
        utils.pharmacySop.board.invalidate({ pharmacyBranchId }),
        utils.pharmacySop.roleHoldings.invalidate({ pharmacyBranchId }),
      ]);
    },
    onError: (cause) =>
      setError(errorMessage(cause, 'Your procedures profile could not be set up. Retry.')),
  });
  return (
    <SectionCard title="Set up your procedures profile">
      <div className="grid gap-3">
        <p className="max-w-2xl text-sm text-text-body">
          You are assigned to this branch but do not have a procedures profile here yet. Set it up
          to see your work and anything waiting for your review. It gives you no new roles — your
          pharmacy manager still decides those.
        </p>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          size="touch"
          className={ROW_ACTION}
          disabled={join.isPending}
          onClick={() => join.mutate({ pharmacyBranchId })}
        >
          {join.isPending ? 'Setting up…' : 'Set up my procedures profile'}
        </Button>
      </div>
    </SectionCard>
  );
}
