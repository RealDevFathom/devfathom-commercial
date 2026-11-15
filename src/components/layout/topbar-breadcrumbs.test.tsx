import { act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigation = { pathname: '/restaurant/sop' };

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/breadcrumb-store', () => ({
  useBreadcrumbStore: (selector: (state: { labels: Record<string, string> }) => unknown) =>
    selector({ labels: {} }),
}));

import { navigation as menu } from './sidebar';
import { TopbarBreadcrumbs } from './topbar-breadcrumbs';

describe('TopbarBreadcrumbs hydration', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    navigation.pathname = '/restaurant/sop';
  });

  it('keeps SSR and first hydration route-inert, then shows the client destination', async () => {
    const serverMarkup = renderToString(<TopbarBreadcrumbs />);
    expect(serverMarkup).toBe('');

    const container = document.createElement('nav');
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);
    navigation.pathname = '/restaurant/inventory';
    const recoverableErrors: unknown[] = [];

    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <TopbarBreadcrumbs />, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });

    expect(recoverableErrors).toEqual([]);
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent('Inventory');

    await act(async () => root.unmount());
  });

  it('updates successive client navigations without stale labels', async () => {
    const container = document.createElement('nav');
    container.innerHTML = renderToString(<TopbarBreadcrumbs />);
    document.body.appendChild(container);
    const recoverableErrors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <TopbarBreadcrumbs />, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });

    for (const [pathname, label] of [
      ['/dashboard', 'Dashboard'],
      ['/restaurant/inventory', 'Inventory'],
      ['/restaurant/sop', 'Sop'],
      ['/restaurant/menus', 'Menus'],
      ['/restaurant/tax', 'Tax'],
    ]) {
      navigation.pathname = pathname;
      await act(async () => root.render(<TopbarBreadcrumbs />));
      expect(container.querySelector('[aria-current="page"]')).toHaveTextContent(label);
    }

    expect(recoverableErrors).toEqual([]);
    await act(async () => root.unmount());
  });

  it('names each hospitality settings page as the hospitality menu does', async () => {
    const pages = menu.filter((item) => item.href.startsWith('/hotel/settings/'));
    // The six pages the menu offers today, so a renamed or added page is a decision here too.
    expect(pages.map((item) => item.label)).toEqual([
      'Property',
      'Rooms',
      'Meal plans',
      'Function spaces',
      'Extras',
      'Guest messages',
    ]);
    const container = document.createElement('nav');
    container.innerHTML = renderToString(<TopbarBreadcrumbs />);
    document.body.appendChild(container);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <TopbarBreadcrumbs />);
    });
    for (const page of pages) {
      navigation.pathname = page.href;
      await act(async () => root.render(<TopbarBreadcrumbs />));
      expect(container.querySelector('[aria-current="page"]'), page.href).toHaveTextContent(
        page.label
      );
    }
    await act(async () => root.unmount());
  });

  it('names the pharmacy SOP workspace "Procedures", not "Sop"', async () => {
    navigation.pathname = '/pharmacy/sop';
    const container = document.createElement('nav');
    container.innerHTML = renderToString(<TopbarBreadcrumbs />);
    document.body.appendChild(container);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <TopbarBreadcrumbs />);
    });
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent('Procedures');
    expect(container).toHaveTextContent('Pharmacy');
    expect(container).not.toHaveTextContent('Sop');
    await act(async () => root.unmount());
  });
  it('uses pharmacy navigation labels for the current destination', async () => {
    const pages = menu.filter((item) => item.group === 'Pharmacy');
    const container = document.createElement('nav');
    document.body.appendChild(container);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <TopbarBreadcrumbs />);
    });
    for (const page of pages) {
      navigation.pathname = page.href;
      await act(async () => root.render(<TopbarBreadcrumbs />));
      expect(container.querySelector('[aria-current="page"]'), page.href).toHaveTextContent(
        page.label
      );
    }
    await act(async () => root.unmount());
  });
});
