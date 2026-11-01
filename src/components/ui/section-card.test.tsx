import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SectionCard } from './section-card';

describe('SectionCard heading level', () => {
  it('defaults the title to h2 so it does not skip under the page h1 (#72)', () => {
    render(<SectionCard title="Delivery capability">body</SectionCard>);
    const heading = screen.getByRole('heading', { name: 'Delivery capability' });
    expect(heading.tagName).toBe('H2');
  });

  it('still renders h3 when a nested card opts in', () => {
    render(
      <SectionCard title="Nested" titleLevel={3}>
        body
      </SectionCard>
    );
    expect(screen.getByRole('heading', { name: 'Nested' }).tagName).toBe('H3');
  });

  it('renders no heading element when there is no title', () => {
    render(<SectionCard>body</SectionCard>);
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
