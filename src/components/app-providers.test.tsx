import { act } from '@testing-library/react';
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
  function Tree({ children }: { children?: ReactNode }) {
    return (
      <AppProviders>
        <main>
          {children}
          <Suspense fallback={<p>Loading inventory</p>}>
            <StreamedPage />
          </Suspense>
        </main>
      </AppProviders>
    );
  }
  return { Tree, usePreferences };
}

/** The HTML shell React flushes while the page below the boundary is still streaming. */
async function streamedShell(tree: ReactNode) {
  const server = new AbortController();
  const stream = await renderToReadableStream(tree, { signal: server.signal, onError: () => {} });
  const { value } = await stream.getReader().read();
  server.abort();
  return new TextDecoder().decode(value);
}

async function hydrate(tree: ReactNode) {
  const container = document.createElement('div');
  container.innerHTML = await streamedShell(tree);
  document.body.appendChild(container);
  const recoverableErrors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    root = hydrateRoot(container, tree, {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
  });
  return { container, recoverableErrors, unmount: () => act(async () => root.unmount()) };
}

describe('AppProviders hydration', () => {
  beforeEach(() => {
    // The page below the boundary is still arriving, as it is mid-stream.
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  });
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('leaves a still-streaming Suspense boundary to hydrate instead of client-rendering it', async () => {
    // WHA-1569: a context change above a boundary whose content has not been
    // revealed yet makes React client-render it, and the streamed copy of the
    // page (with its forms) is left hidden in the document beside the live one.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { Tree } = await loadTree();

    const { container, recoverableErrors, unmount } = await hydrate(<Tree />);

    // React's placeholder for the streamed content is still in place: the
    // boundary is waiting for its server HTML, not rendered on the client.
    expect(container.querySelector('template')).not.toBeNull();
    expect(container).toHaveTextContent('Loading inventory');
    expect(recoverableErrors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await unmount();
  });

  it('still applies saved non-default preferences after hydration', async () => {
    localStorage.setItem('devfathom-prefs', JSON.stringify({ layout: 'top' }));
    const { Tree, usePreferences } = await loadTree();
    const layouts: string[] = [];
    function LayoutProbe() {
      layouts.push(usePreferences().layout);
      return null;
    }

    const { unmount } = await hydrate(
      <Tree>
        <LayoutProbe />
      </Tree>
    );

    expect(layouts[0]).toBe('rail');
    expect(layouts.at(-1)).toBe('top');
    await unmount();
  });
});
