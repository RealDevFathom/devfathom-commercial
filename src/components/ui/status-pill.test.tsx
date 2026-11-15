import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusPill } from './status-pill';

describe('StatusPill info tone', () => {
  it('uses fixed semantic tokens, not tenant-controlled primary colors', () => {
    render(<StatusPill status="Primary" tone="info" />);
    const pill = screen.getByText('Primary').closest('[data-slot="status-pill"]');
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute('data-tone')).toBe('info');
    expect(pill?.className).toContain('bg-muted');
    expect(pill?.className).toContain('text-foreground');
    expect(pill?.className).not.toMatch(/(^|\s)(bg|text)-primary/);
  });
});
