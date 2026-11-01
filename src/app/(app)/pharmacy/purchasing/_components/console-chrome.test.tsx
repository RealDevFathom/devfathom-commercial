import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The tab list shares a module with the server loaders; none of them run here.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({ pharmacyPurchasingRouter: {} }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn() }));

import { PURCHASING_TABS } from '../_lib/console';
import { PurchasingTabs } from './console-chrome';

describe('PurchasingTabs', () => {
  it('keeps every tab a link inside a scroll rail that can show an edge arrow', () => {
    const returns = PURCHASING_TABS[PURCHASING_TABS.length - 1]!;
    const { container } = render(<PurchasingTabs active={returns.href} />);
    const nav = screen.getByRole('navigation', { name: 'Purchasing surfaces' });
    // The nav itself no longer scrolls silently; the rail owns the overflow and its cue.
    expect(nav).not.toHaveClass('overflow-x-auto');
    const rail = container.querySelector('[data-slot="scroll-rail"]');
    expect(rail).not.toBeNull();
    expect(nav).toContainElement(rail as HTMLElement);
    expect(rail!.querySelector('[data-slot="scroll-rail-viewport"]')).toHaveClass(
      'overflow-x-auto'
    );
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      PURCHASING_TABS.map((tab) => tab.href)
    );
    expect(within(nav).getByRole('link', { current: 'page' })).toHaveAttribute(
      'href',
      returns.href
    );
  });
});
