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

  it('names pharmacy accounts sub-pages by their page headings', async () => {
    const pages = [
      ['account-activity-bridge', 'Account activity bridge'],
      ['account-code-reference', 'Account code reference'],
      ['balance-sheet', 'Balance sheet'],
      ['cash-flow', 'Classified cash-flow projection'],
      ['cheque-maturity', 'Recorded cheque maturity'],
      ['fiscal-exceptions', 'Fiscal exception evidence'],
      ['journal-entry-lookup', 'Journal entry lookup'],
      ['journal-evidence-export', 'Journal evidence export'],
      ['profit-loss', 'Profit and loss'],
      ['tax-profile-review', 'Tax profile review'],
      ['trial-balance-control', 'Trial-balance control'],
    ];
    const container = document.createElement('nav');
    container.innerHTML = renderToString(<TopbarBreadcrumbs />);
    document.body.appendChild(container);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <TopbarBreadcrumbs />);
    });
    for (const [slug, label] of pages) {
      navigation.pathname = `/pharmacy/accounts/${slug}`;
      await act(async () => root.render(<TopbarBreadcrumbs />));
      expect(container.querySelector('[aria-current="page"]'), slug).toHaveTextContent(label);
      expect(container).toHaveTextContent('PharmacyAccounts');
      expect(container.querySelector('a[href="/pharmacy/accounts"]')).toBeNull();
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

  it('names the pharmacist queue with its page heading, not the raw slug', async () => {
    navigation.pathname = '/pharmacy/pharmacist-queue';
    const container = document.createElement('nav');
    container.innerHTML = renderToString(<TopbarBreadcrumbs />);
    document.body.appendChild(container);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <TopbarBreadcrumbs />);
    });
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent('Pharmacist queue');
    expect(container).not.toHaveTextContent('Pharmacist-queue');
    await act(async () => root.unmount());
  });

  it('names every pharmacy destination as the pharmacy menu does (DEV-44)', async () => {
    const pages = menu.filter((item) => item.group === 'Pharmacy');
    expect(pages.map((item) => item.href)).toEqual(
      expect.arrayContaining(['/pharmacy', '/pharmacy/medicines', '/pharmacy/counter/close'])
    );
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

  it('links a pharmacy menu destination above the current page, but not the workspace (DEV-44)', async () => {
    const container = document.createElement('nav');
    container.innerHTML = renderToString(<TopbarBreadcrumbs />);
    document.body.appendChild(container);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <TopbarBreadcrumbs />);
    });

    navigation.pathname = '/pharmacy/counter/close';
    await act(async () => root.render(<TopbarBreadcrumbs />));
    expect(container.querySelector('a[href="/pharmacy/counter"]')).toHaveTextContent('Counter');
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent('Day close');
    // The workspace segment is not the Onboarding page and does not link to it.
    expect(container.querySelector('a[href="/pharmacy"]')).toBeNull();
    expect(container).toHaveTextContent('PharmacyCounterDay close');
    expect(container).not.toHaveTextContent('Onboarding');

    navigation.pathname = '/pharmacy/inventory/expiry';
    await act(async () => root.render(<TopbarBreadcrumbs />));
    expect(container.querySelector('a[href="/pharmacy/inventory"]')).toHaveTextContent('Inventory');

    navigation.pathname = '/pharmacy/reports';
    await act(async () => root.render(<TopbarBreadcrumbs />));
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent(
      'Reports & Insights'
    );
    await act(async () => root.unmount());
  });
});
