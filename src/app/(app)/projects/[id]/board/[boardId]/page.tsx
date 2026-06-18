'use client';

import { use } from 'react';
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

function BoardSkeleton() {
  return (
    <div className="space-y-5 animate-fade-in">
      <div>
        <Skeleton className="h-4 w-28 mb-2" />
        <Skeleton className="h-7 w-48" />
      </div>
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="w-72 shrink-0 space-y-3">
            <Skeleton className="h-6 w-24" />
            <div className="rounded-xl bg-secondary/30 p-2 space-y-2">
              {Array.from({ length: 3 - (i % 2) }).map((_, j) => (
                <Skeleton key={j} className="h-24 w-full rounded-xl" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Client-only, code-split: the board is fully client-data driven (tRPC, DnD,
// session), so skip SSR and load it in its own chunk behind a skeleton.
const KanbanBoardContent = dynamic(
  () => import('./kanban-board').then((m) => m.KanbanBoardContent),
  {
    ssr: false,
    loading: () => <BoardSkeleton />,
  }
);

export default function BoardPage(props: { params: Promise<{ id: string; boardId: string }> }) {
  const { id, boardId } = use(props.params);
  return <KanbanBoardContent projectId={id} boardId={boardId} />;
}
