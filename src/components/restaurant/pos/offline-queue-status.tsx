import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

export type OfflineQueueView = {
  queued: number;
  replaying: boolean;
  needsReview: number;
  revoked: boolean;
  online: boolean;
};

export function OfflineQueueStatus({
  state,
  pending,
  onReplay,
  onDiscard,
}: {
  state: OfflineQueueView;
  pending: boolean;
  onReplay: () => void;
  onDiscard: () => void;
}) {
  const tone = state.revoked || state.needsReview ? 'danger' : state.online ? 'success' : 'warning';
  const label = state.revoked
    ? 'Device revoked'
    : state.needsReview
      ? `${state.needsReview} need review`
      : state.replaying
        ? 'Replaying'
        : state.online
          ? 'Connected'
          : 'Offline';
  return (
    <SectionCard
      eyebrow="Local queue"
      title="Sync status"
      actions={<StatusPill status={label} tone={tone} />}
    >
      <p className="text-sm text-text-muted" aria-live="polite">
        {state.revoked
          ? 'Queued device-bound work was discarded and no further requests will be sent.'
          : state.needsReview
            ? 'Catalog or availability changed. Review queued orders before replay.'
            : state.queued
              ? `${state.queued} order${state.queued === 1 ? '' : 's'} waiting on this terminal.`
              : 'No orders are waiting to sync.'}
      </p>
      {state.queued ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            className="h-11"
            disabled={pending || !state.online || state.revoked || state.needsReview > 0}
            onClick={onReplay}
          >
            Replay queued orders
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-11"
            disabled={pending || state.replaying}
            onClick={onDiscard}
          >
            Discard queued work
          </Button>
        </div>
      ) : null}
    </SectionCard>
  );
}
