import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const nextLink = vi.hoisted(() => vi.fn());

vi.mock('next/link', () => ({ default: nextLink }));

import { ExportLink } from './export-link';
import { InventoryReportTabs } from './inventory-report-tabs';

describe('Restaurant reports CSV downloads', () => {
  it('renders exact native download links without invoking Next Link prefetch navigation', () => {
    const sections = [
      'overview',
      'payments',
      'inventory',
      'wastage',
      'stock-movements',
      'purchasing',
      'workforce',
      'sop',
    ] as const;

    render(
      <>
        {sections.map((section) => (
          <ExportLink
            key={section}
            section={section}
            branch="branch-1"
            stockLocation={
              section === 'wastage' || section === 'stock-movements' ? 'location-1' : undefined
            }
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
        `/api/restaurant/reports/export?section=${section}&branch=branch-1&from=2026-08-01&to=2026-08-30${
          section === 'wastage' || section === 'stock-movements' ? '&stockLocation=location-1' : ''
        }`
      );
    });
  });

  it('exposes labelled keyboard tabs for wastage and stock movement', () => {
    render(
      <InventoryReportTabs
        wastage={<h2>Wastage report</h2>}
        stockMovements={<h2>Stock-movement report</h2>}
      />
    );

    expect(screen.getByRole('tablist', { name: 'Inventory movement reports' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Wastage' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Stock movement' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Wastage report' })).toBeVisible();
  });
});
