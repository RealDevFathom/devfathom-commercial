import { describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock('next/navigation', () => navigation);

import SettingsTeamPage from './page';

describe('/settings/team (DEV-502)', () => {
  it('reaches the team page instead of a 404', () => {
    expect(() => SettingsTeamPage()).toThrow('NEXT_REDIRECT /team');
    expect(navigation.redirect).toHaveBeenCalledWith('/team');
  });
});
