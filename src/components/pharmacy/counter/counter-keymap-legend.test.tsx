import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { resolveCounterKeymap } from '@/lib/pharmacy/counter-keymap';

import { CounterKeymapLegend } from './counter-keymap-legend';

describe('CounterKeymapLegend preset picker', () => {
  it('offers managers the keymap picker, including Legacy Speed', () => {
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({ preset: 'devfathom' })}
        onPresetChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Keymap')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Legacy Speed' })).toBeInTheDocument();
  });

  it('shows a cashier the chords in force without the picker or Legacy Speed', () => {
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({ preset: 'legacySpeed' })}
        canChoosePreset={false}
        onPresetChange={vi.fn()}
      />
    );
    expect(screen.queryByLabelText('Keymap')).not.toBeInTheDocument();
    expect(screen.queryByText(/Legacy Speed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Phase 0/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('term').length).toBeGreaterThan(0);
  });
});
