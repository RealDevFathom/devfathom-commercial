import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OfflineQueueStatus } from './offline-queue-status';

describe('OfflineQueueStatus', () => {
  it('renders review and discard controls deterministically', () => {
    const replay = vi.fn();
    const discard = vi.fn();
    render(
      <OfflineQueueStatus
        state={{ queued: 2, replaying: false, needsReview: 1, revoked: false, online: true }}
        pending={false}
        onReplay={replay}
        onDiscard={discard}
      />
    );
    expect(screen.getByRole('button', { name: 'Replay queued orders' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard queued work' }));
    expect(discard).toHaveBeenCalledOnce();
    expect(replay).not.toHaveBeenCalled();
  });
});
