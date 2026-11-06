import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resolveCounterKeymap } from '@/lib/pharmacy/counter-keymap';
import { CounterKeymapLegend } from './counter-keymap-legend';

describe('counter shortcut preference', () => {
  it('allows choosing a preset while a preference save is pending', () => {
    const onPresetChange = vi.fn();
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({ preset: 'devfathom' })}
        saving
        onPresetChange={onPresetChange}
      />
    );
    const select = screen.getByLabelText('Keymap');
    expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: 'legacySpeed' } });
    expect(onPresetChange).toHaveBeenCalledWith('legacySpeed');
  });

  it('explains the payment lock and unlocks with an amber save error', () => {
    const props = {
      keymap: resolveCounterKeymap({ preset: 'devfathom' }),
      onPresetChange: vi.fn(),
    };
    const view = render(<CounterKeymapLegend {...props} disabled />);
    expect(screen.getByLabelText('Keymap')).toBeDisabled();
    expect(screen.getByLabelText('Keymap')).toHaveAttribute('title', 'Finish the payment first');
    view.rerender(<CounterKeymapLegend {...props} error="Could not save shortcuts. Try again." />);
    expect(screen.getByLabelText('Keymap')).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveClass('text-warning');
    expect(screen.getByLabelText('Keymap')).not.toHaveAttribute('title');
  });

  it('rejects a duplicate and saves a distinct function key', () => {
    const onBindingsChange = vi.fn();
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({ preset: 'devfathom' })}
        onPresetChange={vi.fn()}
        onBindingsChange={onBindingsChange}
      />
    );
    const change = screen.getByRole('button', { name: 'Change Focus scan and search' });
    fireEvent.click(change);
    fireEvent.keyDown(change, { key: 'F3' });
    expect(screen.getByRole('alert')).toHaveTextContent('already used');
    expect(onBindingsChange).not.toHaveBeenCalled();
    fireEvent.keyDown(change, { key: 'F5', shiftKey: true });
    expect(onBindingsChange).toHaveBeenCalledWith({ focusSearch: { key: 'F5', shift: true } });
  });

  it('lets Tab leave key capture and clears the pending prompt and error', () => {
    const onBindingsChange = vi.fn();
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({ preset: 'devfathom' })}
        onPresetChange={vi.fn()}
        onBindingsChange={onBindingsChange}
      />
    );
    const change = screen.getByRole('button', { name: 'Change Focus scan and search' });
    fireEvent.click(change);
    fireEvent.keyDown(change, { key: 'F3' });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(fireEvent.keyDown(change, { key: 'Tab', cancelable: true })).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(change).toHaveAccessibleName('Change Focus scan and search');
    expect(onBindingsChange).not.toHaveBeenCalled();
  });
});
