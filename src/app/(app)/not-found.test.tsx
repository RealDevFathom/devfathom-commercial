import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  }),
}));
vi.mock('next/navigation', () => navigation);

import WorkspaceNotFound from './not-found';
import MissingPharmacyPage from './pharmacy/[...missing]/page';
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

  it.each([
    ['pharmacy', MissingPharmacyPage],
    ['settings', MissingSettingsPage],
  ])('routes unknown %s addresses to the in-app not-found page', (_section, Page) => {
    navigation.notFound.mockClear();
    expect(() => Page()).toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(navigation.notFound).toHaveBeenCalledTimes(1);
  });
});
