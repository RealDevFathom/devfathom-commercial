import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DataExportPanel, type DataExportItem } from './data-export-console';

const ready: DataExportItem = {
  id: 'exp-1',
  status: 'READY',
  salesFrom: '2025-10-31',
  salesTo: '2026-10-31',
  requestedAt: new Date('2026-10-31T06:00:00.000Z'),
  completedAt: new Date('2026-10-31T06:05:00.000Z'),
  expiresAt: new Date('2026-11-01T06:05:00.000Z'),
  sizeBytes: 2_048,
  rowCounts: { medicines: 3, sales: 7 },
  downloadCount: 0,
  downloadable: true,
  error: null,
};

describe('owner data export panel', () => {
  it('requests the chosen sales range', () => {
    const onRequest = vi.fn();
    render(
      <DataExportPanel exports={[]} notice={null} pending={false} today="2026-10-31" onRequest={onRequest} />
    );
    expect(screen.getByText(/No export yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Sales from'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));
    expect(onRequest).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('blocks an inverted range with a visible explanation', () => {
    const onRequest = vi.fn();
    render(
      <DataExportPanel exports={[]} notice={null} pending={false} today="2026-10-31" onRequest={onRequest} />
    );
    fireEvent.change(screen.getByLabelText('Sales from'), { target: { value: '2026-10-31' } });
    fireEvent.change(screen.getByLabelText('Sales to'), { target: { value: '2026-10-01' } });
    const button = screen.getByRole('button', { name: 'Download my data' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByLabelText('Sales to').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Choose a start date on or before the end date/)).toBeTruthy();
  });

  it('links a ready archive to the owner download route with its row total', () => {
    render(
      <DataExportPanel exports={[ready]} notice={null} pending={false} today="2026-10-31" onRequest={vi.fn()} />
    );
    const link = screen.getByRole('link', { name: 'Download ZIP' });
    expect(link.getAttribute('href')).toBe('/api/pharmacy/data-export?id=exp-1');
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
  });

  it('disables a second request while one is preparing and shows no link for expired ones', () => {
    render(
      <DataExportPanel
        exports={[
          { ...ready, id: 'q', status: 'QUEUED', downloadable: false, sizeBytes: null, rowCounts: null },
          { ...ready, id: 'x', status: 'EXPIRED', downloadable: false },
        ]}
        notice="Export requested."
        pending={false}
        today="2026-10-31"
        onRequest={vi.fn()}
      />
    );
    const button = screen.getByRole('button', { name: 'Export being prepared' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole('link', { name: 'Download ZIP' })).toBeNull();
    expect(screen.getByText('Link expired')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Export requested.');
  });
});
