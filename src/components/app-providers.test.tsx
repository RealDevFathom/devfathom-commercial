import { act, renderHook, waitFor } from '@testing-library/react';
import { Suspense, use, type ReactNode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToReadableStream } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc-provider', () => ({
  TRPCProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));

const streaming = new Promise<never>(() => {});

function StreamedPage(): ReactNode {
  return use(streaming);
}

/**
 * Fresh provider modules per test: the preferences store caches its first
 * client read at module scope, exactly once per page load.
 */
async function loadTree() {
  vi.resetModules();
  const { AppProviders } = await import('./app-providers');
  const { usePreferences } = await import('./preferences-provider');
  const { useTheme } = await import('./theme-provider');
  function Tree({ children, page }: { children?: ReactNode; page?: ReactNode }) {
    return (
      <AppProviders>
        <main>
          {children}
          <Suspense fallback={<p>Loading inventory</p>}>{page ?? <StreamedPage />}</Suspense>
        </main>
      </AppProviders>
    );
  }
  return { Tree, usePreferences, useTheme };
}

/** The HTML shell React flushes while the page below the boundary is still streaming. */
async function streamedShell(tree: ReactNode) {
  const server = new AbortController();
  const stream = await renderToReadableStream(tree, { signal: server.signal, onError: () => {} });
  const { value } = await stream.getReader().read();
  server.abort();
  return new TextDecoder().decode(value);
}

async function hydrate(tree: ReactNode, serverPage?: ReactNode) {
  const container = document.createElement('div');
  // Render a context-free server fixture. SSR and the browser normally have
  // separate provider instances; sharing them in jsdom triggers React's
  // multiple-renderers warning. Keep the real providers on the hydration side
  // and preserve every console/recoverable-error assertion below.
  container.innerHTML = await streamedShell(
    <main>
      <Suspense fallback={<p>Loading inventory</p>}>{serverPage ?? <StreamedPage />}</Suspense>
    </main>
  );
  document.body.appendChild(container);
  const recoverableErrors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    root = hydrateRoot(container, tree, {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
  });
  return {
    container,
    recoverableErrors,
    rerender: (nextTree: ReactNode) => act(async () => root.render(nextTree)),
    unmount: () => act(async () => root.unmount()),
  };
}

const defaults = {
  density: 'default',
  type: 'default',
  accent: 'quiet',
  layout: 'rail',
  icons: 'numeric',
};
const nondefaults = {
  density: 'compact',
  type: 'lg',
  accent: 'bold',
  layout: 'top',
  icons: 'architectural',
};
const storageStates = [
  { name: 'empty storage', theme: null, preferences: null },
  { name: 'saved defaults', theme: 'light', preferences: defaults },
  { name: 'saved dark theme', theme: 'dark', preferences: null },
  { name: 'saved nondefault layout', theme: null, preferences: { layout: 'top' } },
  { name: 'saved dark theme and nondefault preferences', theme: 'dark', preferences: nondefaults },
];

function seedStorage({ theme, preferences }: (typeof storageStates)[number]) {
  if (theme !== null) localStorage.setItem('theme', theme);
  if (preferences !== null) localStorage.setItem('devfathom-prefs', JSON.stringify(preferences));
}

describe('AppProviders hydration', () => {
  beforeEach(() => {
    // The page below the boundary is still arriving, as it is mid-stream.
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  });
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    for (const key of ['theme', 'density', 'type', 'accent', 'layout', 'icons']) {
      document.documentElement.removeAttribute(`data-${key}`);
    }
    document.documentElement.style.removeProperty('color-scheme');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(storageStates)('preserves a still-streaming boundary with $name', async (state) => {
    // WHA-1569: a context change above a boundary whose content has not been
    // revealed yet makes React client-render it, and the streamed copy of the
    // page (with its forms) is left hidden in the document beside the live one.
    const fetchMock = vi.fn();
    const consoleError = vi.spyOn(console, 'error');
    vi.stubGlobal('fetch', fetchMock);
    seedStorage(state);
    const { Tree } = await loadTree();

    const { container, recoverableErrors, unmount } = await hydrate(<Tree />);

    // React's placeholder for the streamed content is still in place: the
    // boundary is waiting for its server HTML, not rendered on the client.
    try {
      expect(container.querySelectorAll('template')).toHaveLength(1);
      expect(container.querySelectorAll('main')).toHaveLength(1);
      expect(container).toHaveTextContent('Loading inventory');
      expect(recoverableErrors).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      // No preference consumer has hydrated yet; provider-level cross-tab
      // attribute sync must still work without replacing the pending shell.
      await act(async () => {
        localStorage.setItem('devfathom-prefs', JSON.stringify({ layout: 'top' }));
        window.dispatchEvent(new StorageEvent('storage', { key: 'devfathom-prefs' }));
      });
      expect(document.documentElement).toHaveAttribute('data-layout', 'top');
      expect(container.querySelectorAll('template')).toHaveLength(1);
      expect(recoverableErrors).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });

  it.each(storageStates)(
    'keeps one hydrated subtree across rerenders with $name',
    async (state) => {
      seedStorage(state);
      const fetchMock = vi.fn();
      const consoleError = vi.spyOn(console, 'error');
      vi.stubGlobal('fetch', fetchMock);
      const { Tree, usePreferences, useTheme } = await loadTree();
      const observed: string[] = [];
      function ReceiptPage() {
        const { density, type, accent, layout, icons } = usePreferences();
        const { theme } = useTheme();
        const value = JSON.stringify({ theme, density, type, accent, layout, icons });
        observed.push(value);
        return <div id="receipt-history">{value}</div>;
      }

      // Completed server HTML inside Suspense exercises hydration and subsequent
      // provider rerenders. The separate pending-shell case covers the period
      // before arrival; neither substitutes for Next's browser stream/reveal path.
      const { container, recoverableErrors, rerender, unmount } = await hydrate(
        <Tree page={<ReceiptPage />} />,
        <div id="receipt-history">{JSON.stringify({ theme: 'light', ...defaults })}</div>
      );
      const expected = JSON.stringify({
        theme: state.theme ?? 'light',
        ...defaults,
        ...state.preferences,
      });

      try {
        expect(observed[0]).toBe(JSON.stringify({ theme: 'light', ...defaults }));
        for (let pass = 0; pass < 3; pass += 1) {
          if (pass > 0) await rerender(<Tree page={<ReceiptPage />} />);
          // querySelectorAll includes hidden nodes, unlike a visibility-only oracle.
          expect(container.querySelectorAll('#receipt-history')).toHaveLength(1);
          expect(container.querySelector('#receipt-history')).toHaveTextContent(expected);
          expect(container.querySelectorAll('main')).toHaveLength(1);
          expect(container.querySelector('template')).toBeNull();
          expect(recoverableErrors).toEqual([]);
          expect(consoleError).not.toHaveBeenCalled();
        }
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await unmount();
      }
    }
  );

  it.each(storageStates)(
    'restores settings after an actual delayed React reveal with $name',
    async (state) => {
      seedStorage(state);
      const consoleError = vi.spyOn(console, 'error');
      const { Tree, usePreferences, useTheme } = await loadTree();
      let resolve!: () => void;
      const ready = new Promise<void>((done) => {
        resolve = done;
      });
      const initial = JSON.stringify({ theme: 'light', ...defaults });
      const expected = JSON.stringify({
        theme: state.theme ?? 'light',
        ...defaults,
        ...state.preferences,
      });
      function ServerPage() {
        use(ready);
        return <div id="receipt-history">{initial}</div>;
      }
      function Values({ receipt = false }: { receipt?: boolean }) {
        const { density, type, accent, layout, icons } = usePreferences();
        const { theme } = useTheme();
        return (
          <div id={receipt ? 'receipt-history' : 'shell-settings'}>
            {JSON.stringify({ theme, density, type, accent, layout, icons })}
          </div>
        );
      }
      function ClientPage() {
        use(ready);
        return <Values receipt />;
      }
      const errors: unknown[] = [];
      const stream = await renderToReadableStream(
        <main>
          <div id="shell-settings">{initial}</div>
          <Suspense fallback={<p>Loading inventory</p>}>
            <ServerPage />
          </Suspense>
        </main>,
        {
          onError: (error) => {
            errors.push(error);
          },
        }
      );
      const reader = stream.getReader();
      const container = document.createElement('div');
      container.innerHTML = new TextDecoder().decode((await reader.read()).value);
      document.body.appendChild(container);
      let root!: ReturnType<typeof hydrateRoot>;
      await act(async () => {
        root = hydrateRoot(
          container,
          <Tree page={<ClientPage />}>
            <Values />
          </Tree>,
          {
            onRecoverableError: (error) => errors.push(error),
          }
        );
      });
      try {
        expect(container.querySelectorAll('template')).toHaveLength(1);
        expect(container.querySelector('#shell-settings')).toHaveTextContent(expected);
        expect(container.querySelectorAll('#receipt-history')).toHaveLength(0);
        await act(async () => {
          resolve();
          let tail = '';
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            tail += new TextDecoder().decode(chunk.value);
          }
          // Execute the real server renderer's reveal scripts, not hand-written
          // placeholder removal. jsdom does not execute innerHTML scripts itself.
          const arrival = document.createElement('div');
          arrival.innerHTML = tail;
          const scripts = [...arrival.querySelectorAll('script')];
          container.appendChild(arrival);
          for (const script of scripts) window.eval(script.textContent ?? '');
        });
        await waitFor(() => {
          expect(container.querySelector('template')).toBeNull();
          expect(container.querySelectorAll('#receipt-history')).toHaveLength(1);
          expect(container.querySelector('#receipt-history')).toHaveTextContent(expected);
        });
        expect(container.querySelectorAll('main')).toHaveLength(1);
        expect(container).not.toHaveTextContent('Loading inventory');
        expect(errors).toEqual([]);
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        resolve();
        await act(async () => root.unmount());
        reader.releaseLock();
      }
    }
  );

  it('preserves local writes, sanitized cross-tab updates and storage-failure behavior', async () => {
    const { Tree, usePreferences, useTheme } = await loadTree();
    const useSettings = () => ({ prefs: usePreferences(), theme: useTheme() });
    let hook!: ReturnType<typeof renderHook<ReturnType<typeof useSettings>, unknown>>;
    await act(async () => {
      hook = renderHook(useSettings, { wrapper: Tree });
    });
    const { result, unmount } = hook;
    try {
      act(() => {
        result.current.prefs.setPreference('layout', 'top');
        result.current.prefs.setPreferences({ density: 'compact', accent: 'bold' });
        result.current.theme.setTheme('dark');
      });
      expect(result.current.prefs).toMatchObject({
        layout: 'top',
        density: 'compact',
        accent: 'bold',
      });
      expect(JSON.parse(localStorage.getItem('devfathom-prefs')!)).toMatchObject({ layout: 'top' });
      expect(result.current.theme.theme).toBe('dark');
      expect(localStorage.getItem('theme')).toBe('dark');
      expect(document.documentElement).toHaveAttribute('data-layout', 'top');
      act(() => {
        localStorage.setItem(
          'devfathom-prefs',
          JSON.stringify({ layout: 'invalid', icons: 'architectural' })
        );
        localStorage.setItem('theme', 'light');
        window.dispatchEvent(new StorageEvent('storage', { key: 'devfathom-prefs' }));
      });
      expect(result.current.prefs).toMatchObject({ ...defaults, icons: 'architectural' });
      expect(result.current.theme.theme).toBe('light');
      expect(document.documentElement).toHaveAttribute('data-layout', 'rail');
      act(() => {
        localStorage.setItem('devfathom-prefs', '{broken');
        window.dispatchEvent(new StorageEvent('storage', { key: 'devfathom-prefs' }));
      });
      expect(result.current.prefs).toMatchObject(defaults);
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      act(() => {
        result.current.prefs.setPreference('layout', 'top');
        result.current.theme.setTheme('dark');
      });
      expect(result.current.prefs.layout).toBe('top');
      expect(result.current.theme.resolvedTheme).toBe('dark');
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    } finally {
      unmount();
    }
  });
});
