/**
 * DEV-973: browser printing that never freezes the page that asked for it.
 *
 * A pop-up written from the page (`window.open('')` + `document.write` +
 * `popup.print()`) shares the page's browsing-context group, and the browser's
 * print dialog pauses that whole group until it closes. With the pop-up behind
 * the counter, the counter looked dead.
 *
 * Instead, the page opens the static print page with `noopener`, which always
 * puts it in its own browsing-context group, on https and on a plain-http LAN
 * address alike (Cross-Origin-Opener-Policy alone is ignored on plain http).
 * Its print dialog therefore cannot pause this page, and it cannot reach back
 * into this page. The page hands it the finished document over a
 * `BroadcastChannel` named after a random id in the URL fragment (same origin
 * only, held in memory, never in a URL query, storage or a server request), and
 * the print page prints itself and handles dismissal.
 *
 * With `noopener`, `window.open` returns null whether or not the browser blocked
 * the window, so "blocked" means the print page never announced itself within
 * `PRINT_WINDOW_READY_TIMEOUT_MS`. The print page lives inside the counter
 * service worker's scope, which keeps a copy for offline printing.
 * Returning never confirms that paper came out.
 */
import { browserUuid } from '@/lib/browser-uuid';

export const PRINT_WINDOW_PATH = '/pharmacy/counter/print-window.html';
export const PRINT_WINDOW_SCRIPT_PATH = '/pharmacy/counter/print-window.js';
export const PRINT_WINDOW_CHANNEL_PREFIX = 'devfathom-print-window:';
/** A print page that has not announced itself by then was blocked or never loaded. */
export const PRINT_WINDOW_READY_TIMEOUT_MS = 12_000;
/** A print page that loads after all is still told to close for this long. */
const LATE_WINDOW_MS = 120_000;

/** An opaque handle: the window itself is never reachable from this page. */
export type PrintWindow = { readonly id: string };

export class PrintWindowError extends Error {
  constructor(readonly reason: 'blocked' | 'closed') {
    super(reason === 'blocked' ? 'The print window did not open.' : 'The print window is closed.');
    this.name = 'PrintWindowError';
  }
}

export type PrintWindowMessages = { blockedMessage: string; failedMessage: string };

type Entry = {
  channel: BroadcastChannel;
  /** Counted as open (for the notice) until it closes, fails or is cancelled. */
  open: boolean;
  ready: boolean;
  /** Cancelled or failed: a late print page is told to close. */
  failure: PrintWindowError | null;
  sent: boolean;
  readiness: Promise<void>;
  settle: (error?: PrintWindowError) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let openCount = 0;

function emit(): void {
  openCount = Array.from(entries.values()).filter((entry) => entry.open).length;
  for (const listener of listeners) listener();
}

function post(entry: Entry, message: Record<string, unknown>): boolean {
  try {
    entry.channel.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function dispose(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  entry.settle(new PrintWindowError('closed'));
  try {
    entry.channel.close();
  } catch {
    // Cleanup never interrupts the page.
  }
  emit();
}

/** Stops counting the window; a print page that loads later is told to close. */
function abandon(id: string, reason: 'blocked' | 'closed'): void {
  const entry = entries.get(id);
  if (!entry || entry.failure) return;
  entry.open = false;
  entry.failure = new PrintWindowError(reason);
  entry.settle(entry.failure);
  if (entry.ready) {
    post(entry, { type: 'close' });
    dispose(id);
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => dispose(id), LATE_WINDOW_MS);
  emit();
}

function onMessage(id: string, data: unknown): void {
  const entry = entries.get(id);
  if (!entry || !data || typeof data !== 'object') return;
  const type = (data as { type?: unknown }).type;
  if (type === 'ready') {
    if (entry.ready) return;
    entry.ready = true;
    if (entry.failure) {
      post(entry, { type: 'close' });
      dispose(id);
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.settle();
  } else if (type === 'closed') {
    dispose(id);
  }
}

/**
 * Call synchronously from the operator's click: browsers only allow a pop-up
 * there. Throws when this browser cannot isolate a print window.
 */
export function openPrintWindow(features: string): PrintWindow {
  let id: string;
  try {
    if (typeof BroadcastChannel !== 'function') throw new Error('No BroadcastChannel.');
    id = browserUuid();
  } catch {
    throw new Error('This browser cannot open a print window. Update the browser, then retry.');
  }
  const channel = new BroadcastChannel(`${PRINT_WINDOW_CHANNEL_PREFIX}${id}`);
  let settle!: Entry['settle'];
  const readiness = new Promise<void>((resolve, reject) => {
    let settled = false;
    settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
  });
  // Nobody may be waiting yet; a failure is still reported to whoever asks.
  readiness.catch(() => {});
  const entry: Entry = {
    channel,
    open: true,
    ready: false,
    failure: null,
    sent: false,
    readiness,
    settle,
    timer: null,
  };
  // Listen before opening: the print page announces itself as soon as it loads.
  channel.onmessage = (event: MessageEvent) => onMessage(id, event.data);
  entries.set(id, entry);
  entry.timer = setTimeout(() => {
    const current = entries.get(id);
    if (current && !current.ready) abandon(id, 'blocked');
  }, PRINT_WINDOW_READY_TIMEOUT_MS);
  emit();
  try {
    // noopener: its own browsing-context group, so its print dialog cannot
    // pause this page; and no reference back into this page.
    window.open(`${PRINT_WINDOW_PATH}#${id}`, '_blank', `noopener,${features}`);
  } catch {
    abandon(id, 'blocked');
  }
  return { id };
}

/** Resolves once the print page has loaded; rejects if it was blocked or closed. */
export function printWindowReady(handle: PrintWindow): Promise<void> {
  const entry = entries.get(handle.id);
  if (!entry || entry.failure) {
    return Promise.reject(entry?.failure ?? new PrintWindowError('closed'));
  }
  return entry.readiness;
}

/** True until the operator closes the window, it is cancelled, or it never loaded. */
export function isPrintWindowOpen(handle: PrintWindow): boolean {
  return entries.get(handle.id)?.open ?? false;
}

// The isolated static page has no application stylesheet. Pass the resolved
// Studio tokens for its screen-only Close action with the print document.
function printDocumentMessage(html: string): Record<string, unknown> {
  const styles = getComputedStyle(document.documentElement);
  const tokens = [
    '--surface-raised',
    '--surface-sunken',
    '--text-strong',
    '--border-strong',
    '--radius-control',
    '--ring',
    '--font-sans',
  ];
  const chrome = Object.fromEntries(
    tokens
      .map((token) => [token, styles.getPropertyValue(token).trim()])
      .filter(([, value]) => value)
  );
  return { type: 'print', html, ...(Object.keys(chrome).length ? { chrome } : {}) };
}

/**
 * Hands the finished document to the print window, which prints itself in its
 * own browsing context. This page never calls `print()` on another window.
 * Resolves once the document has been handed over; rejects (and closes the
 * window) with `blockedMessage` when it never loaded, otherwise `failedMessage`.
 */
export async function sendToPrintWindow(
  handle: PrintWindow,
  html: string,
  messages: PrintWindowMessages = {
    blockedMessage: 'Allow pop-ups for this site, then retry printing.',
    failedMessage: 'The print window is closed. Retry printing.',
  }
): Promise<void> {
  const entry = entries.get(handle.id);
  if (!entry || entry.sent) throw new Error(messages.failedMessage);
  entry.sent = true;
  try {
    await printWindowReady(handle);
    if (entry.failure) throw entry.failure;
    if (entries.get(handle.id) !== entry || !post(entry, printDocumentMessage(html)))
      throw new PrintWindowError('closed');
  } catch (error) {
    closePrintWindow(handle);
    throw new Error(
      error instanceof PrintWindowError && error.reason === 'blocked'
        ? messages.blockedMessage
        : messages.failedMessage
    );
  }
}

/** Closes a window that will not be used (cancelled, failed or refused content). */
export function closePrintWindow(handle: PrintWindow): void {
  abandon(handle.id, 'closed');
}

/** Asks every open print window to come to the front. */
export function focusPrintWindows(): void {
  for (const entry of entries.values()) if (entry.open) post(entry, { type: 'focus' });
}

/** For `useSyncExternalStore`: how many print windows are open right now. */
export function getOpenPrintWindowCount(): number {
  return openCount;
}

export function subscribePrintWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * One-step print from the operator's click: the window opens synchronously,
 * the returned promise settles once the document has been handed over.
 */
export function printInWindow(
  html: string,
  { features, ...messages }: PrintWindowMessages & { features: string }
): Promise<void> {
  return sendToPrintWindow(openPrintWindow(features), html, messages);
}

/** A detached document to build print content with DOM APIs (text nodes only). */
export function createPrintDocument(title: string): Document {
  return document.implementation.createHTMLDocument(title);
}

/** A detached, inert copy of a built print document, to add text to before sending. */
export function parsePrintDocument(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Serialises a detached print document for `sendToPrintWindow`. */
export function serializePrintDocument(doc: Document): string {
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/**
 * Lays the document out in an invisible frame of this page (no printing, so
 * nothing is paused) and reports whether any `selector` element overflows its
 * fixed size. Labels that do not fit are refused rather than clipped.
 */
export function printContentOverflows(html: string, selector: string): boolean {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText =
    'position:fixed;left:-10000px;top:0;width:720px;height:800px;border:0;visibility:hidden';
  document.body.append(frame);
  try {
    const doc = frame.contentDocument;
    if (!doc) throw new Error('Print content could not be measured.');
    doc.open();
    doc.write(html);
    doc.close();
    return Array.from(doc.querySelectorAll<HTMLElement>(selector)).some(
      (element) =>
        element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth
    );
  } finally {
    frame.remove();
  }
}
