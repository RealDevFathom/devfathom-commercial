import type { Metadata } from 'next';
import { TeamContent } from './team-content';

export const metadata: Metadata = {
  title: 'Team',
};

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string | string[]; returnTo?: string | string[] }>;
}) {
  const query = await searchParams;
  return (
    <TeamContent
      initialShowAddMember={query.invite === '1'}
      invitationReturnTo={query.returnTo === '/restaurant/staff' ? query.returnTo : undefined}
    />
  );
}
