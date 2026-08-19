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

  it('keeps only the exact POS route outside SessionProvider-backed app providers', () => {
    navigation.pathname = '/pos';
    const { rerender } = render(
      <Providers>
        <span>POS</span>
      </Providers>
    );
    expect(screen.queryByTestId('app-providers')).not.toBeInTheDocument();

    navigation.pathname = '/pos/settings';
    rerender(
      <Providers>
        <span>POS settings</span>
      </Providers>
    );
    expect(screen.getByTestId('app-providers')).toBeInTheDocument();
  });
});
