import { redirect } from 'next/navigation';

/**
 * DEV-502: the team directory lives at `/team`. `/settings/team` is a natural
 * address for it, so send it there instead of a bare 404. `/team` keeps its own
 * module and permission checks.
 */
export default function SettingsTeamPage(): never {
  redirect('/team');
}
