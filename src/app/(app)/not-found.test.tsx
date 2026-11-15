import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  }),
}));
vi.mock('next/navigation', () => navigation);

import WorkspaceNotFound from './not-found';
import MissingSettingsPage from './settings/[...missing]/page';

describe('in-app not-found (DEV-502)', () => {
  it('explains the missing page and offers a way back', () => {
    render(<WorkspaceNotFound />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard'
    );
  });

  it('routes unknown settings addresses to the in-app not-found page', () => {
    navigation.notFound.mockClear();
    expect(() => MissingSettingsPage()).toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(navigation.notFound).toHaveBeenCalledTimes(1);
  });
});
