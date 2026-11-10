import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resolveCounterKeymap } from '@/lib/pharmacy/counter-keymap';
import { CounterKeymapLegend } from './counter-keymap-legend';

describe('counter shortcut preference', () => {
  it('shows a failed save and allows another preset after saving finishes', () => {
    const onPresetChange = vi.fn();
    const props = {
      keymap: resolveCounterKeymap({ preset: 'legacySpeed' }),
      onPresetChange,
    };
    const view = render(<CounterKeymapLegend {...props} saving />);
    const select = screen.getByLabelText('Keymap');
    expect(select).toBeDisabled();
    expect(screen.getByText('Saving keymap…')).toHaveAttribute('role', 'status');

    view.rerender(<CounterKeymapLegend {...props} error="Could not save shortcuts." />);
    expect(select).toBeEnabled();
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Could not save shortcuts.');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save shortcuts.');
    expect(screen.queryByText('Saving keymap…')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'devfathom' } });
    expect(onPresetChange).toHaveBeenCalledExactlyOnceWith('devfathom');
  });

  it('preserves the payment lock when there is also a save error', () => {
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({ preset: 'devfathom' })}
        disabled
        error="Could not save shortcuts."
        onPresetChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Keymap')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save shortcuts.');
  });
});
