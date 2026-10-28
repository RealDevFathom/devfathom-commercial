import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rotate = vi.hoisted(() => ({
  onSuccess: (() => undefined) as (result: { secret: string }) => void,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    growth: {
      whatsapp: {
        rotateWebhookSecret: {
          useMutation: (options: { onSuccess: (result: { secret: string }) => void }) => {
            rotate.onSuccess = options.onSuccess;
            return {
              mutate: () => rotate.onSuccess({ secret: 'shown-once-secret' }),
              isPending: false,
              error: null,
            };
          },
        },
      },
    },
  },
}));

import { WhatsAppWebhookSettings } from './whatsapp-webhook-settings';

afterEach(cleanup);

describe('WhatsApp webhook settings', () => {
  it('shows the rotated secret once and drops it when the panel is opened again', () => {
    const first = render(<WhatsAppWebhookSettings />);
    expect(screen.queryByText('shown-once-secret')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set webhook secret' }));
    expect(screen.getByText('shown-once-secret')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rotate secret' })).toBeInTheDocument();
    first.unmount();

    render(<WhatsAppWebhookSettings />);
    expect(screen.queryByText('shown-once-secret')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set webhook secret' })).toBeInTheDocument();
  });
});
