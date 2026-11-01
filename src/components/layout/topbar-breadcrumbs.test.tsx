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
import { humanizeSegment, TopbarBreadcrumbs } from './topbar-breadcrumbs';

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
      ['/restaurant/sop', 'SOP board'],
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

  it('names a page by its menu label rather than its raw slug', async () => {
    const container = document.createElement('nav');
    container.innerHTML = renderToString(<TopbarBreadcrumbs />);
    document.body.appendChild(container);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <TopbarBreadcrumbs />);
    });
    navigation.pathname = '/pharmacy/pharmacist-queue';
    await act(async () => root.render(<TopbarBreadcrumbs />));
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent(
      'Pharmacist queue'
    );
    // The section root keeps its section name, not the menu label of its landing page.
    expect(container).toHaveTextContent(/^Pharmacy/);
    expect(container.textContent).not.toMatch(/Pharmacist-queue/);
    await act(async () => root.unmount());
  });

  it('humanizes a slug no menu item names', async () => {
    const container = document.createElement('nav');
    container.innerHTML = renderToString(<TopbarBreadcrumbs />);
    document.body.appendChild(container);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <TopbarBreadcrumbs />);
    });
    navigation.pathname = '/pharmacy/reports/branch-comparison';
    await act(async () => root.render(<TopbarBreadcrumbs />));
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent(
      'Branch comparison'
    );
    await act(async () => root.unmount());
  });
});

describe('humanizeSegment', () => {
  it('turns a hyphenated slug into sentence-case words', () => {
    expect(humanizeSegment('branch-comparison')).toBe('Branch comparison');
    expect(humanizeSegment('pharmacist-queue')).toBe('Pharmacist queue');
    expect(humanizeSegment('sop')).toBe('Sop');
  });
});
