/**
 * DEV-973: browser printing that never freezes the page that asked for it.
 *
 * A pop-up written from the page (`window.open('')` + `document.write` +
 * `popup.print()`) shares the page's browsing-context group, and the browser's
 * print dialog pauses that whole group until it closes. With the pop-up behind
 * the counter, the counter looked dead.
 *
 * Instead, the page opens the static print page `public/print-window.html`.
 * That page is served with `Cross-Origin-Opener-Policy: same-origin`, so the
 * browser moves it into its own browsing-context group: its print dialog cannot
 * pause this page, and it cannot reach back into this page either. The page
 * hands it the finished document over a `BroadcastChannel` named after a random
 * id in the URL fragment (same origin only, held in memory, never in a URL
 * query, storage or a server request), and the print page prints itself.
 *
 * `window.open` is still called directly, so it stays inside the operator's
 * click and a blocked pop-up is still detected at once. Returning never
 * confirms that paper came out.
 */

export const PRINT_WINDOW_PATH = '/print-window.html';
export const PRINT_WINDOW_CHANNEL_PREFIX = 'devfathom-print-window:';
/** A print page that has not loaded by then is treated as gone. */
export const PRINT_WINDOW_READY_TIMEOUT_MS = 20_000;

/** An opaque handle; the window itself is not reachable once it has loaded. */
export type PrintWindow = { readonly id: string };

type Entry = {
  window: Window;
  channel: BroadcastChannel;
  ready: boolean;
  /** No longer counted as open: cancelled, closed by the operator, or never loaded. */
  closing: boolean;
  html: string | null;
  sent: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let openCount = 0;

function emit(): void {
  openCount = Array.from(entries.values()).filter((entry) => !entry.closing).length;
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
  try {
    entry.channel.close();
  } catch {
    // Cleanup never interrupts the page.
  }
  emit();
}

function onMessage(id: string, data: unknown): void {
  const entry = entries.get(id);
  if (!entry || !data || typeof data !== 'object') return;
  const type = (data as { type?: unknown }).type;
  if (type === 'ready') {
    if (entry.ready) return;
    entry.ready = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.closing) {
      post(entry, { type: 'close' });
      dispose(id);
      return;
    }
    if (entry.html !== null) {
      post(entry, { type: 'print', html: entry.html });
      entry.html = null;
    }
  } else if (type === 'closed') {
    dispose(id);
  }
}

/**
 * Call synchronously from the operator's click. Returns null when the browser
 * blocked the window. Throws when this browser cannot isolate a print window.
 */
export function openPrintWindow(features: string): PrintWindow | null {
  if (typeof BroadcastChannel !== 'function' || typeof crypto?.randomUUID !== 'function') {
    throw new Error('This browser cannot open a print window. Update the browser, then retry.');
  }
  const id = crypto.randomUUID();
  const channel = new BroadcastChannel(`${PRINT_WINDOW_CHANNEL_PREFIX}${id}`);
  const entry: Entry = {
    window: null as unknown as Window,
    channel,
    ready: false,
    closing: false,
    html: null,
    sent: false,
    timer: null,
  };
  // Listen before opening: the print page announces itself as soon as it loads.
  channel.onmessage = (event: MessageEvent) => onMessage(id, event.data);
  entries.set(id, entry);
  let popup: Window | null = null;
  try {
    popup = window.open(`${PRINT_WINDOW_PATH}#${id}`, '_blank', features);
  } catch {
    popup = null;
  }
  if (!popup) {
    dispose(id);
    return null;
  }
  entry.window = popup;
  try {
    // Defence in depth for a browser that ignores the opener policy.
    popup.opener = null;
  } catch {
    // Already isolated.
  }
  if (!entry.ready) {
    entry.timer = setTimeout(() => {
      const current = entries.get(id);
      if (!current || current.ready) return;
      post(current, { type: 'close' });
      dispose(id);
    }, PRINT_WINDOW_READY_TIMEOUT_MS);
  }
  emit();
  return { id };
}

/** True until the operator closes the window, it is cancelled, or it never loaded. */
export function isPrintWindowOpen(handle: PrintWindow): boolean {
  const entry = entries.get(handle.id);
  return !!entry && !entry.closing;
}

/**
 * Hands the finished document to the print window, which prints itself in its
 * own browsing context. This page never calls `print()` on another window.
 */
export function sendToPrintWindow(handle: PrintWindow, html: string): void {
  const entry = entries.get(handle.id);
  if (!entry || entry.closing || entry.sent) throw new Error('The print window is closed.');
  entry.sent = true;
  if (!entry.ready) {
    entry.html = html;
    return;
  }
  if (!post(entry, { type: 'print', html })) {
    closePrintWindow(handle);
    throw new Error('The print window is closed.');
  }
}

/** Closes a window that will not be used (cancelled, failed or refused content). */
export function closePrintWindow(handle: PrintWindow): void {
  const entry = entries.get(handle.id);
  if (!entry) return;
  try {
    // Reaches the window only before it has been isolated.
    entry.window.close();
  } catch {
    // Isolated: the close message below reaches it instead.
  }
  if (entry.ready) {
    post(entry, { type: 'close' });
    dispose(handle.id);
    return;
  }
  // Still loading: it is told to close as soon as it announces itself.
  entry.closing = true;
  entry.html = null;
  emit();
}

/** Asks every open print window to come to the front. */
export function focusPrintWindows(): void {
  for (const entry of entries.values()) {
    if (entry.closing) continue;
    try {
      entry.window.focus();
    } catch {
      // Isolated windows are asked over their channel.
    }
    post(entry, { type: 'focus' });
  }
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
 * One-step print from the operator's click: open the isolated window and hand
 * it the document. Throws `blockedMessage` for a blocked pop-up.
 */
export function printInWindow(
  html: string,
  { features, blockedMessage, failedMessage }: PrintInWindowOptions
): void {
  const handle = openPrintWindow(features);
  if (!handle) throw new Error(blockedMessage);
  try {
    sendToPrintWindow(handle, html);
  } catch {
    closePrintWindow(handle);
    throw new Error(failedMessage);
  }
}

export type PrintInWindowOptions = {
  features: string;
  blockedMessage: string;
  failedMessage: string;
};

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
