import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { COUNTER_ACTIONS, resolveCounterKeymap } from '@/lib/pharmacy/counter-keymap';

import { CounterKeymapLegend } from './counter-keymap-legend';

describe('CounterKeymapLegend layout', () => {
  it('lists every binding in columns sized by the card, not the viewport', () => {
    render(
      <CounterKeymapLegend
        keymap={resolveCounterKeymap({ preset: 'devfathom' })}
        onPresetChange={vi.fn()}
      />
    );
    const bindings = screen.getByTestId('counter-keymap-bindings');
    const tokens = bindings.className.split(/\s+/);
    expect(tokens).toContain('grid-cols-[repeat(auto-fill,minmax(min(14rem,100%),1fr))]');
    // A viewport breakpoint squeezed two columns into a narrow counter column.
    expect(tokens.some((token) => token.startsWith('sm:grid-cols'))).toBe(false);
    expect(bindings.querySelectorAll('dt')).toHaveLength(COUNTER_ACTIONS.length);
    // The legend itself never owns a scroll or height cap that could clip it.
    expect(bindings.closest('[class*="overflow"]')).toBeNull();
    expect(screen.getByLabelText('Keymap')).toBeInTheDocument();
  });
});
