import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OwnerDataExportConsole } from './owner-data-export';

const READY = {
  id: 'job-1',
  status: 'SUCCEEDED',
  requestedAt: '2026-11-15T09:00:00.000Z',
  finishedAt: '2026-11-15T09:05:00.000Z',
  expiresAt: '2026-11-16T09:05:00.000Z',
  downloadable: true,
  rowCounts: { 'customers.csv': 3 },
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:export');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const body = (call: number) => JSON.parse(fetchMock.mock.calls[call]![1].body as string);

describe('OwnerDataExportConsole PIN (DEV-783)', () => {
  it('asks for the PIN before requesting and sends nothing without it', async () => {
    render(<OwnerDataExportConsole initial={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /download my data/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your PIN');
    expect(screen.getByLabelText('Your PIN')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the PIN in the request body and clears it afterwards', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ export: READY }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ exports: [] }));
    render(<OwnerDataExportConsole initial={[]} />);
    const pin = screen.getByLabelText('Your PIN');
    expect(pin).toHaveAttribute('type', 'password');
    fireEvent.change(pin, { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: /download my data/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]![1].method).toBe('POST');
    expect(body(0)).toEqual({ from: null, to: null, pin: '2468' });
    expect(pin).toHaveValue('');
  });

  it('downloads by POST with the PIN, never through a link that carries it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('PK-archive', {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="devfathom-data-export-2026-11-15.zip"',
        },
      })
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<OwnerDataExportConsole initial={[READY]} />);
    expect(document.querySelector('a[href*="job="]')).toBeNull();
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: /download zip/i }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pharmacy/data-export');
    expect(body(0)).toEqual({ action: 'download', job: 'job-1', pin: '2468' });
    click.mockRestore();
  });

  it('shows a wrong-PIN refusal from the server', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: 'That PIN is not correct.' }, { status: 401 })
    );
    render(<OwnerDataExportConsole initial={[READY]} />);
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: /download zip/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That PIN is not correct.');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('OwnerDataExportConsole time zone (DEV-802)', () => {
  it('shows request times and the picked-date zone in the organization time zone', () => {
    render(
      <OwnerDataExportConsole
        timeZone="Asia/Karachi"
        initial={[{ ...READY, status: 'QUEUED', requestedAt: '2026-11-03T13:24:00.000Z' } as never]}
      />
    );
    expect(screen.getByText('3 Nov 2026, 6:24 PM PKT')).toBeTruthy();
    expect(screen.getByText(/read in your workspace timezone \(PKT\)/)).toBeTruthy();
  });
});
