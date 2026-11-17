import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resolveCounterKeymap } from '@/lib/pharmacy/counter-keymap';
import { CounterKeymapLegend } from './counter-keymap-legend';

describe('counter shortcut preference', () => {
  it('keeps the administrator preview warning in operator language', () => {
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({ preset: 'legacySpeed' })}
        allowUnconfirmed
        onPresetChange={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Unconfirmed');
    expect(screen.getByRole('status')).toHaveTextContent('Confirm them with your team');
    expect(document.body).not.toHaveTextContent(/Phase 0|D01|scorecard|Placeholder/);
  });

  it('only offers confirmed presets to staff and labels F8/F9 from the active map', () => {
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({ preset: 'devfathom' })}
        onPresetChange={vi.fn()}
      />
    );
    expect(screen.queryByRole('option', { name: 'Legacy Speed' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Placeholder|Phase 0/)).not.toBeInTheDocument();
    expect(
      within(screen.getByText('Resume held bill').parentElement!).getByText('F8')
    ).toBeInTheDocument();
    expect(
      within(screen.getByText('Open tender').parentElement!).getByText('F9')
    ).toBeInTheDocument();
  });

  it('does not expose a previously saved unconfirmed preset to staff', () => {
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({ preset: 'legacySpeed' })}
        onPresetChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Keymap')).toHaveValue('devfathom');
    expect(screen.queryByText(/Legacy Speed|Placeholder|Phase 0/)).not.toBeInTheDocument();
    expect(
      within(screen.getByText('Focus scan and search').parentElement!).getByText('F2')
    ).toBeInTheDocument();
  });

  it('keeps legend labels consistent with operator overrides', () => {
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({
          preset: 'devfathom',
          overrides: { resumeSale: { key: 'F9' }, openTender: { key: 'F8' } },
        })}
        onPresetChange={vi.fn()}
      />
    );
    expect(
      within(screen.getByText('Resume held bill').parentElement!).getByText('F9')
    ).toBeInTheDocument();
    expect(
      within(screen.getByText('Open tender').parentElement!).getByText('F8')
    ).toBeInTheDocument();
  });

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
