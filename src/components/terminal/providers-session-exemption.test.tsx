import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ pathname: '/terminal' }));

vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));
vi.mock('@/components/app-providers', () => ({
  AppProviders: ({ children }: { children: ReactNode }) => (
    <div data-testid="app-providers">{children}</div>
  ),
}));

import { Providers } from '@/components/providers';

describe('terminal root providers', () => {
  it('keeps only the exact terminal route outside SessionProvider-backed app providers', () => {
    const { rerender } = render(
      <Providers>
        <span>terminal</span>
      </Providers>
    );
    expect(screen.queryByTestId('app-providers')).not.toBeInTheDocument();

    navigation.pathname = '/terminal/settings';
    rerender(
      <Providers>
        <span>terminal settings</span>
      </Providers>
    );
    expect(screen.getByTestId('app-providers')).toBeInTheDocument();
  });
});
