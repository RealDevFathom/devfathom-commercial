/**
 * TEST-ONLY (DEV-973): stands in for the isolated print page
 * (`public/print-window.html`) so tests can read the exact document a page
 * hands to it. Messages are delivered synchronously through an in-memory
 * BroadcastChannel, so a test reads what was sent right after the call.
 */
import { vi } from 'vitest';

import { PRINT_WINDOW_CHANNEL_PREFIX, PRINT_WINDOW_PATH } from '@/lib/browser-print/print-window';

type Listener = (event: MessageEvent) => void;

const channels = new Map<string, Set<FakeBroadcastChannel>>();

export class FakeBroadcastChannel {
  onmessage: Listener | null = null;
  private closed = false;
  constructor(readonly name: string) {
    if (!channels.has(name)) channels.set(name, new Set());
    channels.get(name)!.add(this);
  }
  postMessage(data: unknown): void {
    if (this.closed) throw new Error('InvalidStateError: channel closed');
    for (const peer of channels.get(this.name) ?? []) {
      if (peer !== this && !peer.closed) peer.onmessage?.({ data } as MessageEvent);
    }
  }
  close(): void {
    this.closed = true;
    channels.get(this.name)?.delete(this);
  }
}

export type FakePrintWindow = {
  /** A stand-in for the print page's own window (unreachable from the page that opened it). */
  proxy: { closed: boolean; close: () => void; focus: () => void; print: () => void };
  url: string;
  features: string | undefined;
  /** Every message the page sent, in order. */
  messages: Array<{ type: string; html?: string }>;
  /** The document handed over for printing, if any. */
  html: () => string | undefined;
  /** The printed document, parsed as the print page shows it. */
  document: () => Document | undefined;
  printRequests: () => number;
  /** The print page has loaded and announces itself. */
  ready: () => void;
  /** The operator closes the print window (or it closes itself after printing). */
  closeByOperator: () => void;
};

/**
 * Replaces `window.open` and `BroadcastChannel`. Like a real `noopener` open,
 * `window.open` returns null. By default each print page loads at once; pass
 * `{ ready: false }` to load it later with `ready()`, or `{ blocked: true }`
 * for a browser that blocks the pop-up (nothing ever loads).
 */
export function installFakePrintWindows({
  ready = true,
  blocked = false,
}: { ready?: boolean; blocked?: boolean } = {}) {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  const windows: FakePrintWindow[] = [];
  const open = vi.spyOn(window, 'open').mockImplementation((url, _target, features) => {
    const href = String(url ?? '');
    const parsed = new URL(href, 'https://tenant.test');
    if (parsed.pathname !== PRINT_WINDOW_PATH) {
      throw new Error(`Unexpected window.open(${href})`);
    }
    if (blocked) return null;
    const channel = new FakeBroadcastChannel(
      `${PRINT_WINDOW_CHANNEL_PREFIX}${parsed.hash.slice(1)}`
    );
    const messages: FakePrintWindow['messages'] = [];
    const proxy = {
      closed: false,
      close: vi.fn(() => {
        if (proxy.closed) return;
        proxy.closed = true;
        channel.postMessage({ type: 'closed' });
        channel.close();
      }),
      focus: vi.fn(),
      print: vi.fn(),
    };
    channel.onmessage = (event) => {
      const message = event.data as { type: string; html?: string };
      messages.push(message);
      // As the print page does: a close request closes the window.
      if (message.type === 'close') proxy.close();
    };
    const html = () => messages.find((message) => message.type === 'print')?.html;
    const fake: FakePrintWindow = {
      proxy,
      url: href,
      features,
      messages,
      html,
      document: () => {
        const value = html();
        return value === undefined
          ? undefined
          : new DOMParser().parseFromString(value, 'text/html');
      },
      printRequests: () => messages.filter((message) => message.type === 'print').length,
      ready: () => channel.postMessage({ type: 'ready' }),
      closeByOperator: () => proxy.close(),
    };
    windows.push(fake);
    if (ready) fake.ready();
    // noopener: the opening page gets no reference.
    return null;
  });
  return {
    open,
    windows,
    last: () => windows[windows.length - 1]!,
    /** The operator closes every print window still open. */
    closeAll: () => {
      for (const fake of windows) if (!fake.proxy.closed) fake.closeByOperator();
    },
  };
}
