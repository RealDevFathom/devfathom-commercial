import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ teamContent: vi.fn(() => null) }));

vi.mock('./team-content', () => ({ TeamContent: mocks.teamContent }));

import TeamPage from './page';

describe('TeamPage invitation deep link', () => {
  const cases: Array<[{ invite?: string | string[] }, boolean]> = [
    [{}, false],
    [{ invite: ['1'] }, false],
    [{ invite: ['0', '1'] }, false],
    [{ invite: '0' }, false],
    [{ invite: '1' }, true],
  ];

  it.each(cases)(
    'normalizes %o without treating arrays as an invitation request',
    async (query, open) => {
      const element = await TeamPage({ searchParams: Promise.resolve(query) });
      expect(element.type).toBe(mocks.teamContent);
      expect(element.props).toEqual({ initialShowAddMember: open, invitationReturnTo: undefined });
    }
  );

  it('allows only the known Restaurant staff return target', async () => {
    const valid = await TeamPage({
      searchParams: Promise.resolve({ invite: '1', returnTo: '/restaurant/staff' }),
    });
    expect(valid.props.invitationReturnTo).toBe('/restaurant/staff');

    const external = await TeamPage({
      searchParams: Promise.resolve({ invite: '1', returnTo: 'https://example.invalid' }),
    });
    expect(external.props.invitationReturnTo).toBeUndefined();
  });
});
