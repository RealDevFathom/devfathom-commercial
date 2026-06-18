import type { Metadata } from 'next';
import { KanbanBoardContent } from './kanban-board';

export const metadata: Metadata = {
  title: 'Board',
};

export default async function BoardPage(props: {
  params: Promise<{ id: string; boardId: string }>;
}) {
  const { id, boardId } = await props.params;
  return <KanbanBoardContent projectId={id} boardId={boardId} />;
}
