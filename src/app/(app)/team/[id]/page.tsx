import type { Metadata } from 'next';
import { MemberDetailContent } from './member-detail-content';

export const metadata: Metadata = { title: 'Team Member' };

export default async function MemberDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <MemberDetailContent memberId={id} />;
}
