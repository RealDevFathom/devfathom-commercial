import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openPrintWindow, sendToPrintWindow } from '@/lib/browser-print/print-window';
import { installFakePrintWindows } from '@/lib/testing/print-window';

import { PrintWindowNotice } from './print-window-notice';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DEV-973 print window notice', () => {
  it('shows one line while a print window is open, brings it forward, and clears when it closes', () => {
    const windows = installFakePrintWindows();
    render(<PrintWindowNotice />);
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      sendToPrintWindow(openPrintWindow('popup')!, '<!doctype html><title>R</title>');
    });
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent('Print window is open. Finish or cancel it there.');

    fireEvent.click(screen.getByRole('button', { name: 'Show print window' }));
    expect(windows.last().messages).toContainEqual({ type: 'focus' });

    act(() => windows.last().closeByOperator());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays hidden when the browser blocks the window', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<PrintWindowNotice />);
    act(() => {
      openPrintWindow('popup');
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
