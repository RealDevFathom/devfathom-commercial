/**
 * DEV-973: the static print page (public/pharmacy/counter/print-window.js), run
 * as written in its own window. It prints itself from its own task once the
 * opening page hands it a document, renders that document inert, closes itself
 * when the print dialog closes, and tells the opening page when it is gone.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeBroadcastChannel } from '@/lib/testing/print-window';

import { PRINT_WINDOW_CHANNEL_PREFIX, PRINT_WINDOW_PATH } from './print-window';

const source = readFileSync(
  path.join(process.cwd(), 'public/pharmacy/counter/print-window.js'),
  'utf8'
);
const shell = readFileSync(
  path.join(process.cwd(), 'public/pharmacy/counter/print-window.html'),
  'utf8'
);
const root = document.documentElement;
// Each test's page is a new window; drop the window listeners earlier pages added.
const added: Array<[string, EventListenerOrEventListenerObject]> = [];
afterEach(() => {
  for (const [type, listener] of added.splice(0)) window.removeEventListener(type, listener);
  vi.useRealTimers();
  // The page replaces its own document; put this test document back.
  if (document.documentElement !== root) document.replaceChild(root, document.documentElement);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function load(hash?: string) {
  // A fresh channel per page, so pages from earlier tests never answer.
  const ID = crypto.randomUUID();
  hash ??= `#${ID}`;
  window.history.replaceState(null, '', `${PRINT_WINDOW_PATH}${hash}`);
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  const win = window;
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
  const close = vi.spyOn(window, 'close').mockImplementation(() => {});
  const listen = window.addEventListener.bind(window) as (
    type: string,
    listener: EventListenerOrEventListenerObject
  ) => void;
  vi.spyOn(window, 'addEventListener').mockImplementation(
    (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (!listener) return;
      added.push([type, listener]);
      listen(type, listener);
    }
  );
  const opener = new FakeBroadcastChannel(`${PRINT_WINDOW_CHANNEL_PREFIX}${ID}`);
  const heard: unknown[] = [];
  opener.onmessage = (event) => heard.push(event.data);
  // Run as written, as a classic script of the print page.
  new Function(source)();
  return { win, print, focus, close, opener, heard };
}

function shown(html: string) {
  const page = load();
  page.opener.postMessage({ type: 'print', html });
  page.opener.close();
  return page.win.document;
}

const receipt =
  '<!doctype html><html lang="en"><head><title>Receipt 12</title><style>pre{font:12px monospace}</style></head>' +
  '<body><pre>Medicine &amp; name</pre><script>window.injected = true</script><img src="x" onerror="window.injected = true"></body></html>';

describe('DEV-973 print page', () => {
  it('announces itself and keeps the channel id out of its address', () => {
    const page = load();
    expect(page.heard).toEqual([{ type: 'ready' }]);
    expect(page.win.location.pathname).toBe(PRINT_WINDOW_PATH);
    expect(page.win.location.hash).toBe('');
    page.opener.close();
  });

  it('ignores an address that does not carry a channel id', () => {
    const page = load('#not-an-id');
    expect(page.heard).toEqual([]);
    page.opener.close();
  });

  it('shows the document, then prints itself from its own task', () => {
    vi.useFakeTimers();
    const page = load();
    page.opener.postMessage({ type: 'print', html: receipt });
    expect(page.win.document.title).toBe('Receipt 12');
    expect(page.win.document.querySelector('pre')?.textContent).toBe('Medicine & name');
    expect(page.win.document.querySelector('style')?.textContent).toContain('monospace');
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
  });

  it('closes itself once the print dialog closes, printed or cancelled', () => {
    const page = load();
    // A dialog closing before any document arrived is not this window's.
    page.win.dispatchEvent(new page.win.Event('afterprint'));
    expect(page.close).not.toHaveBeenCalled();
    page.opener.postMessage({ type: 'print', html: receipt });
    page.win.dispatchEvent(new page.win.Event('afterprint'));
    expect(page.close).toHaveBeenCalledOnce();
    // Said before closing, so the notice clears even if teardown drops later messages.
    expect(page.heard.at(-1)).toEqual({ type: 'closed' });
    // Closed by hand (no afterprint): said on pagehide.
    page.heard.length = 0;
    page.win.dispatchEvent(new page.win.Event('pagehide'));
    expect(page.heard).toEqual([{ type: 'closed' }]);
    page.opener.close();
  });

  it('comes to the front and closes on request', () => {
    const page = load();
    page.opener.postMessage({ type: 'focus' });
    expect(page.focus).toHaveBeenCalledOnce();
    page.opener.postMessage({ type: 'close' });
    expect(page.close).toHaveBeenCalledOnce();
    page.opener.close();
  });

  describe('keeps the document inert', () => {
    it('drops scripts', () => {
      expect(shown(receipt).querySelector('script')).toBeNull();
    });

    it('drops meta http-equiv, so a refresh cannot navigate the window away', () => {
      const doc = shown(
        '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://elsewhere.test">' +
          '<meta http-equiv="Content-Security-Policy" content="script-src *"><meta charset="utf-8"></head><body><pre>R</pre></body></html>'
      );
      expect(doc.querySelector('meta[http-equiv]')).toBeNull();
      expect(doc.querySelector('meta[charset]')).not.toBeNull();
    });

    it('drops base, so links cannot be re-based', () => {
      const doc = shown(
        '<!doctype html><html><head><base href="https://elsewhere.test/"></head><body><pre>R</pre></body></html>'
      );
      expect(doc.querySelector('base')).toBeNull();
    });

    it('drops every on* attribute', () => {
      const doc = shown(
        '<!doctype html><html><body onload="x()"><pre onclick="x()" ONMOUSEOVER="x()" title="kept">R</pre>' +
          '<svg onload="x()"><rect onfocusin="x()"></rect></svg></body></html>'
      );
      for (const element of doc.querySelectorAll('*'))
        expect(element.getAttributeNames().filter((name) => /^on/i.test(name))).toEqual([]);
      expect(doc.querySelector('pre')?.getAttribute('title')).toBe('kept');
    });

    it('drops javascript: URLs, however they are spelled', () => {
      const doc = shown(
        '<!doctype html><html><body><a href="javascript:x()">a</a><a href=" JaVaScRiPt:x()">b</a>' +
          '<a href="java&#x09;script:x()">c</a><form action="javascript:x()"><button formaction="javascript:x()">d</button></form>' +
          '<iframe src="javascript:x()"></iframe><svg><a xlink:href="javascript:x()"><text>e</text></a></svg>' +
          '<a href="https://tenant.test/receipt">kept</a></body></html>'
      );
      const urls = Array.from(doc.querySelectorAll('*')).flatMap((element) =>
        ['href', 'src', 'action', 'formaction', 'xlink:href'].map((name) =>
          element.getAttribute(name)
        )
      );
      expect(urls.filter((value) => value !== null && /script:/i.test(value))).toEqual([]);
      expect(doc.querySelector('a[href="https://tenant.test/receipt"]')).not.toBeNull();
    });
  });

  it('loads its script from this origin only, so the page CSP needs no inline script', () => {
    expect(shell).toContain('<script src="/pharmacy/counter/print-window.js"></script>');
    expect(shell).not.toMatch(/<script>(?!<)/);
    expect(shell).not.toMatch(/\son[a-z]+=/i);
  });
});
