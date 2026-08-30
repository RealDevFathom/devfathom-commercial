import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const nextLink = vi.hoisted(() => vi.fn());

vi.mock('next/link', () => ({ default: nextLink }));

import { ExportLink } from './export-link';

describe('Restaurant reports CSV downloads', () => {
  it('renders exact native download links without invoking Next Link prefetch navigation', () => {
    const sections = ['overview', 'payments', 'inventory', 'purchasing', 'workforce', 'sop'] as const;

    render(
      <>
        {sections.map((section) => (
          <ExportLink
            key={section}
            section={section}
            branch="branch-1"
            from="2026-08-01"
            to="2026-08-30"
          />
        ))}
      </>
    );

    expect(nextLink).not.toHaveBeenCalled();
    const links = screen.getAllByRole('link', { name: 'Export CSV' });
    expect(links).toHaveLength(sections.length);
    sections.forEach((section, index) => {
      expect(links[index]).toHaveAttribute('download');
      expect(links[index]).toHaveAttribute(
        'href',
        `/api/restaurant/reports/export?section=${section}&branch=branch-1&from=2026-08-01&to=2026-08-30`
      );
    });
  });
});
