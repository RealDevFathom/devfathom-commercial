import type { Metadata } from 'next';
import { ProjectDetailContent } from './project-detail-content';

export const metadata: Metadata = {
  title: 'Project',
};

export default async function ProjectDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <ProjectDetailContent projectId={id} />;
}
