import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Switch } from './switch';

describe('Switch dark-theme tracks', () => {
  it('paints "on" and "off" from different theme-owned tokens in dark', () => {
    render(
      <>
        <Switch aria-label="Tasks in-app" checked onCheckedChange={() => {}} />
        <Switch aria-label="Tasks email" checked={false} onCheckedChange={() => {}} />
      </>
    );

    const on = screen.getByRole('switch', { name: 'Tasks in-app' });
    const off = screen.getByRole('switch', { name: 'Tasks email' });

    // Same class list on both; the data-checked / data-unchecked state picks
    // the dark track. A tenant brand repaints --primary, so neither dark track
    // may depend on it.
    for (const control of [on, off]) {
      expect(control).toHaveClass('dark:data-checked:bg-foreground');
      expect(control).toHaveClass('dark:data-unchecked:bg-surface-sunken');
      expect(control).toHaveClass('dark:data-unchecked:border-input');
      expect(control.className).not.toContain('dark:data-unchecked:bg-input/80');
    }
    expect(on).toHaveAttribute('data-checked');
    expect(off).toHaveAttribute('data-unchecked');

    const thumb = on.querySelector('[data-slot="switch-thumb"]');
    expect(thumb).toHaveClass('dark:data-checked:bg-background');
    expect(thumb).toHaveClass('dark:data-unchecked:bg-text-muted');
    expect(thumb?.className).not.toContain('dark:data-checked:bg-primary-foreground');
  });
});
