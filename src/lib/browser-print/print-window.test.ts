/**
 * DEV-973: the page that asks for a print never calls print() itself and is
 * never paused by the print dialog. It opens the isolated print page with
 * noopener from the click, hands it the document once it has loaded, and
 * counts it as open (for the notice line) until it closes. With noopener a
 * blocked pop-up is the one whose print page never announces itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import nextConfig from '../../../next.config';
import { installFakePrintWindows } from '@/lib/testing/print-window';

import {
  PRINT_WINDOW_READY_TIMEOUT_MS,
  closePrintWindow,
  focusPrintWindows,
  getOpenPrintWindowCount,
  isPrintWindowOpen,
  openPrintWindow,
  printContentOverflows,
  printInWindow,
  printWindowReady,
  sendToPrintWindow,
  subscribePrintWindows,
} from './print-window';

const html =
  '<!doctype html><html><head><title>Receipt 12</title></head><body><pre>R</pre></body></html>';
const messages = { blockedMessage: 'Allow pop-ups', failedMessage: 'Retry printing' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DEV-973 isolated print window', () => {
  it('opens the print page with noopener, with only a random channel id in the URL', () => {
    const windows = installFakePrintWindows();
    const first = openPrintWindow('popup,width=480,height=720');
    const second = openPrintWindow('popup,width=480,height=720');
    expect(windows.open).toHaveBeenNthCalledWith(
      1,
      `/pharmacy/counter/print-window.html#${first.id}`,
      '_blank',
      'noopener,popup,width=480,height=720'
    );
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(second.id).not.toBe(first.id);
    windows.closeAll();
  });

  it('works on a plain-http origin, where crypto.randomUUID is unavailable', async () => {
    const windows = installFakePrintWindows();
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const handle = openPrintWindow('popup');
    await sendToPrintWindow(handle, html, messages);
    expect(windows.last().html()).toBe(html);
    windows.closeAll();
  });

  it('reports a blocked pop-up once its print page fails to announce itself', async () => {
    vi.useFakeTimers();
    installFakePrintWindows({ blocked: true });
    const before = getOpenPrintWindowCount();
    const printing = printInWindow(html, { features: 'popup', ...messages });
    const outcome = expect(printing).rejects.toThrow('Allow pop-ups');
    expect(getOpenPrintWindowCount()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(PRINT_WINDOW_READY_TIMEOUT_MS);
    await outcome;
    expect(getOpenPrintWindowCount()).toBe(before);
  });

  it('hands the document over once when the print page takes eight seconds to load', async () => {
    vi.useFakeTimers();
    const windows = installFakePrintWindows({ ready: false });
    const handle = openPrintWindow('popup');
    const sent = sendToPrintWindow(handle, html, messages);
    const outcome = sent.then(
      () => 'sent',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(8_000);
    expect(isPrintWindowOpen(handle)).toBe(true);
    windows.last().ready();
    await expect(outcome).resolves.toBe('sent');
    expect(windows.last().printRequests()).toBe(1);
    windows.closeAll();
  });

  it('keeps the blocked message when receipt data takes longer than the window timeout', async () => {
    vi.useFakeTimers();
    installFakePrintWindows({ blocked: true });
    const handle = openPrintWindow('popup');
    await vi.advanceTimersByTimeAsync(PRINT_WINDOW_READY_TIMEOUT_MS);
    await expect(sendToPrintWindow(handle, html, messages)).rejects.toThrow('Allow pop-ups');
  });

  it('prints only in the new window when a cashier retries before the old page loads', async () => {
    vi.useFakeTimers();
    const windows = installFakePrintWindows({ ready: false });
    const first = printInWindow(html, { features: 'popup', ...messages });
    const blocked = expect(first).rejects.toThrow('Allow pop-ups');
    await vi.advanceTimersByTimeAsync(PRINT_WINDOW_READY_TIMEOUT_MS);
    await blocked;
    const old = windows.last();
    const retry = printInWindow(html, { features: 'popup', ...messages });
    old.ready();
    windows.last().ready();
    await retry;
    expect(old.messages).toEqual([{ type: 'close' }]);
    expect(windows.last().printRequests()).toBe(1);
    windows.closeAll();
  });

  it('never calls print() on the window or this page; the window prints itself once loaded', async () => {
    const windows = installFakePrintWindows({ ready: false });
    const pagePrint = vi.spyOn(window, 'print').mockImplementation(() => {});
    const handle = openPrintWindow('popup');
    const popup = windows.last();
    const sent = sendToPrintWindow(handle, html, messages);
    await Promise.resolve();
    expect(popup.printRequests()).toBe(0);
    popup.ready();
    await sent;
    expect(popup.messages).toEqual([{ type: 'print', html }]);
    // A second send cannot print twice.
    await expect(sendToPrintWindow(handle, html, messages)).rejects.toThrow('Retry printing');
    expect(popup.printRequests()).toBe(1);
    expect(popup.proxy.print).not.toHaveBeenCalled();
    expect(pagePrint).not.toHaveBeenCalled();
    windows.closeAll();
  });

  it('counts the window as open, for the notice, until it closes', async () => {
    const windows = installFakePrintWindows();
    const before = getOpenPrintWindowCount();
    const listener = vi.fn();
    const unsubscribe = subscribePrintWindows(listener);
    const handle = openPrintWindow('popup');
    expect(getOpenPrintWindowCount()).toBe(before + 1);
    expect(isPrintWindowOpen(handle)).toBe(true);
    expect(listener).toHaveBeenCalled();
    await sendToPrintWindow(handle, html, messages);
    // Still open while its dialog is up; it closes itself afterwards.
    expect(getOpenPrintWindowCount()).toBe(before + 1);
    listener.mockClear();
    windows.last().closeByOperator();
    expect(getOpenPrintWindowCount()).toBe(before);
    expect(isPrintWindowOpen(handle)).toBe(false);
    expect(listener).toHaveBeenCalled();
    await expect(printWindowReady(handle)).rejects.toThrow('closed');
    unsubscribe();
  });

  it('asks each open window to come to the front', () => {
    const windows = installFakePrintWindows();
    openPrintWindow('popup');
    openPrintWindow('popup');
    focusPrintWindows();
    for (const popup of windows.windows) expect(popup.messages).toContainEqual({ type: 'focus' });
    windows.closeAll();
  });

  it('closes a cancelled window, even one still loading', async () => {
    const windows = installFakePrintWindows({ ready: false });
    const before = getOpenPrintWindowCount();
    const loading = openPrintWindow('popup');
    const sent = sendToPrintWindow(loading, html, messages);
    closePrintWindow(loading);
    await expect(sent).rejects.toThrow('Retry printing');
    expect(getOpenPrintWindowCount()).toBe(before);
    windows.last().ready();
    // It loaded after all: told to close, and never given the document.
    expect(windows.last().messages).toEqual([{ type: 'close' }]);
    expect(windows.last().proxy.closed).toBe(true);
  });

  it('tells a print page that loads after the timeout to close', async () => {
    vi.useFakeTimers();
    const windows = installFakePrintWindows({ ready: false });
    const handle = openPrintWindow('popup');
    await vi.advanceTimersByTimeAsync(PRINT_WINDOW_READY_TIMEOUT_MS);
    expect(isPrintWindowOpen(handle)).toBe(false);
    windows.last().ready();
    expect(windows.last().messages).toEqual([{ type: 'close' }]);
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

  it('also sends the opener policy on the print page, for browsers that honour it', async () => {
    const rules = await nextConfig.headers!();
    const rule = rules.find((entry) => entry.source === '/pharmacy/counter/print-window.html');
    expect(rule?.headers).toContainEqual({
      key: 'Cross-Origin-Opener-Policy',
      value: 'same-origin',
    });
  });
});
