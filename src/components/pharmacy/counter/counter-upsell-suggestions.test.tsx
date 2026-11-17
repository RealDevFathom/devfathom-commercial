import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', () => ({ trpc: {} }));

import { CounterUpsellList } from './counter-upsell-suggestions';

const suggestion = {
  medicineId: 'spacer',
  presentationId: 'presentation-spacer',
  displayName: 'Spacer Device',
  presentation: 'Each',
  availableCanonicalUnits: 3,
  packMrpMinor: 45_000,
  ruleId: 'inhaler-spacer',
  reason: 'Often bought with inhalers',
};

describe('#730 counter upsell suggestions', () => {
  it('labels suggestions as optional and shows the rule reason', () => {
    render(
      <CounterUpsellList
        suggestions={[suggestion]}
        state="ready"
        disabled={false}
        onChoose={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText(/suggestion only/i)).toBeInTheDocument();
    expect(screen.getByText(/over-the-counter and front-shop items only/i)).toBeInTheDocument();
    expect(screen.getByText('Often bought with inhalers')).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Complementary item suggestions' })
    ).toBeInTheDocument();
  });

  it('choosing a suggestion hands it back without touching the bill', () => {
    const onChoose = vi.fn();
    render(
      <CounterUpsellList
        suggestions={[suggestion]}
        state="ready"
        disabled={false}
        onChoose={onChoose}
        onRetry={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Find item' }));
    expect(onChoose).toHaveBeenCalledWith(suggestion);
  });

  it('disables the action while the counter is busy', () => {
    render(
      <CounterUpsellList
        suggestions={[suggestion]}
        state="ready"
        disabled
        onChoose={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Find item' })).toBeDisabled();
  });

  it('renders loading, empty and retryable error states', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <CounterUpsellList
        suggestions={[]}
        state="loading"
        disabled={false}
        onChoose={vi.fn()}
        onRetry={onRetry}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(/checking complementary items/i);
    rerender(
      <CounterUpsellList
        suggestions={[]}
        state="ready"
        disabled={false}
        onChoose={vi.fn()}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText(/no complementary over-the-counter item/i)).toBeInTheDocument();
    rerender(
      <CounterUpsellList
        suggestions={[]}
        state="error"
        error="Unavailable"
        disabled={false}
        onChoose={vi.fn()}
        onRetry={onRetry}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('DEV-41 remaining disabled explanations for branch suggestions', () => {
  it('explains the branch gate and clears the reason once available', () => {
    const onChoose = vi.fn();
    const props = {
      suggestions: [suggestion],
      state: 'ready' as const,
      onChoose,
      onRetry: vi.fn(),
    };
    const view = render(
      <CounterUpsellList
        {...props}
        disabled
        disabledReason="Select a branch you can access before continuing."
      />
    );
    const button = screen.getByRole('button', { name: 'Find item' });
    expect(button).toHaveAccessibleDescription('Select a branch you can access before continuing.');
    fireEvent.click(button);
    expect(onChoose).not.toHaveBeenCalled();
    view.rerender(<CounterUpsellList {...props} disabled={false} />);
    expect(button).toBeEnabled();
    expect(button).not.toHaveAccessibleDescription();
    fireEvent.click(button);
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(suggestion);
  });
});
