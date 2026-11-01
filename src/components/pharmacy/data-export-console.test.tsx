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
  it('requests the chosen sales range with the re-entered PIN, then forgets the PIN', () => {
    const onRequest = vi.fn();
    render(
      <DataExportPanel exports={[]} notice={null} pending={false} today="2026-10-31" onRequest={onRequest} onDownload={vi.fn()} />
    );
    expect(screen.getByText(/No export yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Sales from'), { target: { value: '2026-10-01' } });
    const pin = screen.getByLabelText('Your PIN') as HTMLInputElement;
    expect(pin.type).toBe('password');
    fireEvent.change(pin, { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));
    expect(onRequest).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-31', pin: '2468' });
    expect(pin.value).toBe('');
  });

  it('does not request an export without the PIN and says why', () => {
    const onRequest = vi.fn();
    render(
      <DataExportPanel exports={[]} notice={null} pending={false} today="2026-10-31" onRequest={onRequest} onDownload={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));
    expect(onRequest).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Your PIN').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter your PIN to continue.')).toBeTruthy();
  });

  it('blocks an inverted range with a visible explanation', () => {
    const onRequest = vi.fn();
    render(
      <DataExportPanel exports={[]} notice={null} pending={false} today="2026-10-31" onRequest={onRequest} onDownload={vi.fn()} />
    );
    fireEvent.change(screen.getByLabelText('Sales from'), { target: { value: '2026-10-31' } });
    fireEvent.change(screen.getByLabelText('Sales to'), { target: { value: '2026-10-01' } });
    const button = screen.getByRole('button', { name: 'Download my data' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByLabelText('Sales to').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Choose a start date on or before the end date/)).toBeTruthy();
  });

  it('downloads a ready archive only with the PIN and shows its row total', () => {
    const onDownload = vi.fn();
    render(
      <DataExportPanel exports={[ready]} notice={null} pending={false} today="2026-10-31" onRequest={vi.fn()} onDownload={onDownload} />
    );
    // No plain link: the archive cannot be fetched without re-entering the PIN.
    expect(screen.queryByRole('link', { name: 'Download ZIP' })).toBeNull();
    const button = screen.getByRole('button', { name: 'Download ZIP' });
    fireEvent.click(button);
    expect(onDownload).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '2468' } });
    fireEvent.click(button);
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({ id: 'exp-1', pin: '2468' });
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
  });

  it('disables a second request while one is preparing and shows no link for expired ones', () => {
    const onDownload = vi.fn();
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
        onDownload={onDownload}
      />
    );
    const button = screen.getByRole('button', { name: 'Export being prepared' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Download ZIP' })).toBeNull();
    expect(screen.getByText('Link expired')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Export requested.');
  });
});
