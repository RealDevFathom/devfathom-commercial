import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusPill } from './status-pill';

describe('StatusPill', () => {
  it('neutral tone uses text-text-strong for AA contrast (not text-text-muted)', () => {
    const { container } = render(<StatusPill status="unknownthing" />);
    const pill = container.querySelector('[data-slot="status-pill"]');

    expect(pill).not.toBeNull();
    expect(pill?.getAttribute('data-tone')).toBe('neutral');
    expect(pill?.className).toContain('text-text-strong');
    expect(pill?.className).not.toContain('text-text-muted');
  });

  it('maps known statuses to their tone (paid → success)', () => {
    const { container } = render(<StatusPill status="paid" />);
    const pill = container.querySelector('[data-slot="status-pill"]');

    expect(pill).not.toBeNull();
    expect(pill?.getAttribute('data-tone')).toBe('success');
    expect(pill?.className).toContain('text-success');
  });
});
