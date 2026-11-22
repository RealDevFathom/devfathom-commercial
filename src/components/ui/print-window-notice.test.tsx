import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PRINT_WINDOW_READY_TIMEOUT_MS,
  openPrintWindow,
  sendToPrintWindow,
} from '@/lib/browser-print/print-window';
import { installFakePrintWindows } from '@/lib/testing/print-window';

import { PrintWindowNotice } from './print-window-notice';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DEV-973 print window notice', () => {
  it('shows one line while a print window is open, brings it forward, and clears when it closes', async () => {
    const windows = installFakePrintWindows();
    render(<PrintWindowNotice />);
    // The live region is there from the start, empty, so the line is announced.
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();

    await act(async () => {
      await sendToPrintWindow(openPrintWindow('popup'), '<!doctype html><title>R</title>');
    });
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent(
      'Finish or cancel printing in the print window. It may be behind this window.'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show print window' }));
    expect(windows.last().messages).toContainEqual({ type: 'focus' });

    // The print window closes itself once its dialog closes.
    act(() => windows.last().closeByOperator());
    expect(region).toBeEmptyDOMElement();
  });

  it('waits for the popup to confirm that it opened before displaying the notice', () => {
    const windows = installFakePrintWindows({ ready: false });
    render(<PrintWindowNotice />);
    act(() => {
      openPrintWindow('popup');
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    act(() => windows.last().ready());
    expect(screen.getByRole('status')).toHaveTextContent('Finish or cancel printing');
    act(() => windows.closeAll());
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('stays empty while a blocked window waits for the readiness timeout', async () => {
    vi.useFakeTimers();
    installFakePrintWindows({ blocked: true });
    render(<PrintWindowNotice />);
    act(() => {
      openPrintWindow('popup');
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await act(() => vi.advanceTimersByTimeAsync(PRINT_WINDOW_READY_TIMEOUT_MS));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    vi.useRealTimers();
  });
});
