/**
 * DEV-973: the page that asks for a print never calls print() itself and is
 * never paused by the print dialog. It opens the isolated print page from the
 * click, hands it the document once it has loaded, and counts it as open (for
 * the "Print window is open" line) until the operator closes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import nextConfig from '../../../next.config';
import { FakeBroadcastChannel, installFakePrintWindows } from '@/lib/testing/print-window';

import {
  PRINT_WINDOW_READY_TIMEOUT_MS,
  closePrintWindow,
  focusPrintWindows,
  getOpenPrintWindowCount,
  isPrintWindowOpen,
  openPrintWindow,
  printContentOverflows,
  printInWindow,
  sendToPrintWindow,
  subscribePrintWindows,
} from './print-window';

const html =
  '<!doctype html><html><head><title>Receipt 12</title></head><body><pre>R</pre></body></html>';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DEV-973 isolated print window', () => {
  it('opens the static print page from the click with only a random channel id in the URL', () => {
    const windows = installFakePrintWindows();
    const first = openPrintWindow('popup,width=480,height=720')!;
    const second = openPrintWindow('popup,width=480,height=720')!;
    expect(windows.open).toHaveBeenNthCalledWith(
      1,
      `/print-window.html#${first.id}`,
      '_blank',
      'popup,width=480,height=720'
    );
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second.id).not.toBe(first.id);
    expect(windows.windows[0]!.proxy.opener).toBeNull();
    windows.closeAll();
  });

  it('reports a blocked pop-up at once and counts nothing as open', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const before = getOpenPrintWindowCount();
    expect(openPrintWindow('popup')).toBeNull();
    expect(getOpenPrintWindowCount()).toBe(before);
    expect(() =>
      printInWindow(html, {
        features: 'popup',
        blockedMessage: 'Allow pop-ups',
        failedMessage: 'x',
      })
    ).toThrow('Allow pop-ups');
  });

  it('never calls print() on the window or this page; the window prints itself once loaded', () => {
    const windows = installFakePrintWindows({ ready: false });
    const pagePrint = vi.spyOn(window, 'print').mockImplementation(() => {});
    const handle = openPrintWindow('popup')!;
    const popup = windows.last();
    sendToPrintWindow(handle, html);
    expect(popup.printRequests()).toBe(0);
    popup.ready();
    expect(popup.messages).toEqual([{ type: 'print', html }]);
    // A second send cannot print twice.
    expect(() => sendToPrintWindow(handle, html)).toThrow('closed');
    expect(popup.printRequests()).toBe(1);
    expect(popup.proxy.print).not.toHaveBeenCalled();
    expect(popup.proxy.focus).not.toHaveBeenCalled();
    expect(pagePrint).not.toHaveBeenCalled();
    windows.closeAll();
  });

  it('counts the window as open, for the notice, until the operator closes it', () => {
    const windows = installFakePrintWindows();
    const before = getOpenPrintWindowCount();
    const listener = vi.fn();
    const unsubscribe = subscribePrintWindows(listener);
    const handle = openPrintWindow('popup')!;
    expect(getOpenPrintWindowCount()).toBe(before + 1);
    expect(isPrintWindowOpen(handle)).toBe(true);
    expect(listener).toHaveBeenCalled();
    sendToPrintWindow(handle, html);
    // Printing does not close it: the receipt stays on screen until the operator closes it.
    expect(getOpenPrintWindowCount()).toBe(before + 1);
    listener.mockClear();
    windows.last().closeByOperator();
    expect(getOpenPrintWindowCount()).toBe(before);
    expect(isPrintWindowOpen(handle)).toBe(false);
    expect(listener).toHaveBeenCalled();
    expect(() => sendToPrintWindow(handle, html)).toThrow('closed');
    unsubscribe();
  });

  it('asks each open window to come to the front', () => {
    const windows = installFakePrintWindows();
    openPrintWindow('popup');
    openPrintWindow('popup');
    focusPrintWindows();
    for (const popup of windows.windows) {
      expect(popup.messages).toContainEqual({ type: 'focus' });
      expect(popup.proxy.focus).toHaveBeenCalledOnce();
    }
    windows.closeAll();
  });

  it('closes a cancelled window, even one still loading', () => {
    const windows = installFakePrintWindows({ ready: false });
    const before = getOpenPrintWindowCount();
    const loading = openPrintWindow('popup')!;
    sendToPrintWindow(loading, html);
    closePrintWindow(loading);
    expect(getOpenPrintWindowCount()).toBe(before);
    expect(windows.last().proxy.close).toHaveBeenCalledOnce();
    windows.last().ready();
    // It loaded after all: told to close, and never given the document.
    expect(windows.last().messages).toEqual([{ type: 'close' }]);
  });

  it('forgets a window whose print page never loaded', () => {
    vi.useFakeTimers();
    installFakePrintWindows({ ready: false });
    const before = getOpenPrintWindowCount();
    const handle = openPrintWindow('popup')!;
    expect(getOpenPrintWindowCount()).toBe(before + 1);
    vi.advanceTimersByTime(PRINT_WINDOW_READY_TIMEOUT_MS);
    expect(isPrintWindowOpen(handle)).toBe(false);
    expect(getOpenPrintWindowCount()).toBe(before);
  });

  it('refuses to open an unisolated window in a browser without BroadcastChannel', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const open = vi.spyOn(window, 'open');
    expect(() => openPrintWindow('popup')).toThrow('Update the browser');
    expect(open).not.toHaveBeenCalled();
  });

  it('measures fixed-size content in this page without printing it', () => {
    const pagePrint = vi.spyOn(window, 'print').mockImplementation(() => {});
    expect(printContentOverflows(html, '.label')).toBe(false);
    expect(document.querySelector('iframe')).toBeNull();
    expect(pagePrint).not.toHaveBeenCalled();
  });

  it('serves the print page in its own browsing-context group', async () => {
    const rules = await nextConfig.headers!();
    const rule = rules.find((entry) => entry.source === '/print-window.html');
    expect(rule?.headers).toContainEqual({
      key: 'Cross-Origin-Opener-Policy',
      value: 'same-origin',
    });
  });
});
