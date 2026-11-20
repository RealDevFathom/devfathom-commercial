/**
 * DEV-973: the static print page (public/print-window.js), run as written in
 * its own window. It prints itself from its own task once the opening page
 * hands it a document, renders that document inert, and tells the opening page
 * when it is closed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeBroadcastChannel } from '@/lib/testing/print-window';

import { PRINT_WINDOW_CHANNEL_PREFIX } from './print-window';

const source = readFileSync(path.join(process.cwd(), 'public/print-window.js'), 'utf8');
const shell = readFileSync(path.join(process.cwd(), 'public/print-window.html'), 'utf8');
const root = document.documentElement;
afterEach(() => {
  // The page replaces its own document; put this test document back.
  if (document.documentElement !== root) document.replaceChild(root, document.documentElement);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function load(hash?: string) {
  // A fresh channel per page, so pages from earlier tests never answer.
  const ID = crypto.randomUUID();
  hash ??= `#${ID}`;
  window.history.replaceState(null, '', `/print-window.html${hash}`);
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  const win = window;
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
  const close = vi.spyOn(window, 'close').mockImplementation(() => {});
  const opener = new FakeBroadcastChannel(`${PRINT_WINDOW_CHANNEL_PREFIX}${ID}`);
  const heard: unknown[] = [];
  opener.onmessage = (event) => heard.push(event.data);
  // Run as written, as a classic script of the print page.
  new Function(source)();
  return { win, print, focus, close, opener, heard };
}

const receipt =
  '<!doctype html><html lang="en"><head><title>Receipt 12</title><style>pre{font:12px monospace}</style></head>' +
  '<body><pre>Medicine &amp; name</pre><script>window.injected = true</script><img src="x" onerror="window.injected = true"></body></html>';

describe('DEV-973 print page', () => {
  it('announces itself and keeps the channel id out of its address', () => {
    const page = load();
    expect(page.heard).toEqual([{ type: 'ready' }]);
    expect(page.win.location.pathname).toBe('/print-window.html');
    expect(page.win.location.hash).toBe('');
    page.opener.close();
  });

  it('ignores an address that does not carry a channel id', () => {
    const page = load('#not-an-id');
    expect(page.heard).toEqual([]);
    page.opener.close();
  });

  it('shows the document inert, then prints itself from its own task', async () => {
    vi.useFakeTimers();
    try {
      const page = load();
      page.opener.postMessage({ type: 'print', html: receipt });
      expect(page.win.document.title).toBe('Receipt 12');
      expect(page.win.document.querySelector('pre')?.textContent).toBe('Medicine & name');
      expect(page.win.document.querySelector('style')?.textContent).toContain('monospace');
      expect(page.win.document.querySelector('script')).toBeNull();
      expect(page.heard).toEqual([{ type: 'ready' }, { type: 'printing' }]);
      expect(page.focus).toHaveBeenCalledOnce();
      expect(page.print).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(page.print).toHaveBeenCalledOnce();
      expect((page.win as unknown as { injected?: boolean }).injected).toBeUndefined();
      // One document per window: a second print request is ignored.
      page.opener.postMessage({ type: 'print', html: receipt });
      vi.runAllTimers();
      expect(page.print).toHaveBeenCalledOnce();
      page.opener.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('comes to the front, closes on request, and reports being closed', () => {
    const page = load();
    page.opener.postMessage({ type: 'focus' });
    expect(page.focus).toHaveBeenCalledOnce();
    page.opener.postMessage({ type: 'close' });
    expect(page.close).toHaveBeenCalledOnce();
    page.win.dispatchEvent(new page.win.Event('pagehide'));
    expect(page.heard).toContainEqual({ type: 'closed' });
    page.opener.close();
  });

  it('loads its script from this origin only, so the page CSP needs no inline script', () => {
    expect(shell).toContain('<script src="/print-window.js"></script>');
    expect(shell).not.toMatch(/<script>(?!<)/);
    expect(shell).not.toMatch(/\son[a-z]+=/i);
  });
});
