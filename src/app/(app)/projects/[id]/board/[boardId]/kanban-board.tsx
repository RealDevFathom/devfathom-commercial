'use client';

import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useDeferredValue,
  memo,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import {
  ArrowLeft,
  Plus,
  MessageSquare,
  Paperclip,
  Calendar,
  CheckSquare,
  X,
  Trash2,
  GripVertical,
  Search,
  UserPlus,
  Crown,
  Tag,
  MoveRight,
  ListChecks,
  Check,
  Gauge,
  Ban,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { useBreadcrumbLabel } from '@/lib/breadcrumb-store';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { TaskDetailSheet } from './task-detail-sheet';

const priorityColors: Record<string, string> = {
  URGENT: 'bg-red-500',
  HIGH: 'bg-primary',
  MEDIUM: 'bg-amber-500',
  LOW: 'bg-muted-foreground/40',
};

// IMP-PROJ-09: how many tasks to render per column before a "Show more" prompt.
// Bounds the initial paint regardless of board size; the cap applies to the
// filtered result when a filter is active.
const INITIAL_VISIBLE = 20;

// IMP-PROJ-06: mirrors the server's done-column heuristic (projects.moveTask).
// A blocker is "still open" when its blocking task isn't in a done column.
const DONE_COLUMN_RE = /^(done|complete|completed|shipped|closed)$/i;

type TaskLabel = { label: { id: string; name: string; color: string } };
type TaskAssignee = { user: { id: string; name: string; avatar: string | null } };
// Board cards only need checklist completion counts — getBoardWithTasks selects items.completed only.
type ChecklistItem = { completed: boolean };
type TaskChecklist = { id: string; name: string; items: ChecklistItem[] };
// IMP-PROJ-06: each blocker carries only its blocking task's column name, enough
// to decide whether the dependency is still open.
type TaskBlocker = { blockingTask: { column: { name: string } } };
type TaskData = {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  dueDate: Date | null;
  order: number;
  columnId: string;
  labels: TaskLabel[];
  assignees: TaskAssignee[];
  checklists: TaskChecklist[];
  blockedBy: TaskBlocker[];
  _count: { comments: number; attachments: number; checklists: number };
};

export function KanbanBoardContent({ projectId, boardId }: { projectId: string; boardId: string }) {
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const { data: board, isLoading } = trpc.projects.getBoardWithTasks.useQuery({ boardId });
  const [ownerPickerColumnId, setOwnerPickerColumnId] = useState<string | null>(null);

  // Replace the raw project/board ids in the topbar breadcrumb with their names.
  useBreadcrumbLabel(projectId, board?.project.name);
  useBreadcrumbLabel(boardId, board?.name);

  const setColumnOwners = trpc.projects.setColumnDefaultAssignees.useMutation({
    onSuccess: () => {
      utils.projects.getBoardWithTasks.invalidate({ boardId });
      setOwnerPickerColumnId(null);
    },
  });

  // Each drag captures its own pre-mutation snapshot locally (see handleDragEnd)
  // and rolls back via a per-call onError, so overlapping drags can't clobber a
  // shared snapshot. moveTask reconciles on settle (the server may auto-assign the
  // destination column's default owners + recompute order); reorderColumns is
  // purely positional, so it trusts the optimistic state with no refetch.
  const moveTask = trpc.projects.moveTask.useMutation({
    onSettled: () => utils.projects.getBoardWithTasks.invalidate({ boardId }),
  });
  const reorderColumns = trpc.projects.reorderColumns.useMutation();
  const createTask = trpc.projects.createTask.useMutation({
    onSuccess: () => utils.projects.getBoardWithTasks.invalidate({ boardId }),
  });
  const createColumn = trpc.projects.createColumn.useMutation({
    onSuccess: () => {
      utils.projects.getBoardWithTasks.invalidate({ boardId });
      setAddingColumn(false);
      setNewColumnName('');
    },
  });
  const updateColumn = trpc.projects.updateColumn.useMutation({
    onSuccess: () => {
      utils.projects.getBoardWithTasks.invalidate({ boardId });
      setEditingColumnId(null);
      setWipEditorColumnId(null);
    },
  });
  const deleteColumn = trpc.projects.deleteColumn.useMutation({
    onSuccess: () => {
      utils.projects.getBoardWithTasks.invalidate({ boardId });
      setDeletingColumnId(null);
    },
  });

  // IMP-PROJ-08: bulk actions. Move/delete go through dedicated server
  // mutations (atomic, race-free); label/assign reuse the per-item mutations in
  // a Promise.all loop. None of these auto-invalidate — we invalidate once after
  // the whole batch settles (see afterBulk).
  const bulkMove = trpc.projects.bulkMoveTasks.useMutation();
  const bulkDelete = trpc.projects.bulkDeleteTasks.useMutation();
  const bulkAddLabelM = trpc.projects.addLabelToTask.useMutation();
  const bulkRemoveLabelM = trpc.projects.removeLabelFromTask.useMutation();
  const bulkAssignM = trpc.projects.updateTaskAssignees.useMutation();

  const { data: teamMembers } = trpc.team.getRoster.useQuery();
  const [addingToColumn, setAddingToColumn] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [deletingColumnId, setDeletingColumnId] = useState<string | null>(null);

  // IMP-PROJ-07: per-column WIP limit — which column's limit editor is open,
  // plus a transient (non-blocking) warning when a move/add pushes a column over.
  const [wipEditorColumnId, setWipEditorColumnId] = useState<string | null>(null);
  const [wipWarning, setWipWarning] = useState<string | null>(null);
  useEffect(() => {
    if (!wipWarning) return;
    const t = setTimeout(() => setWipWarning(null), 4500);
    return () => clearTimeout(t);
  }, [wipWarning]);

  // IMP-PROJ-08: multi-select / bulk-action state.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMenu, setBulkMenu] = useState<'move' | 'addLabel' | 'removeLabel' | 'assign' | null>(
    null
  );
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  // IMP-PROJ-09: per-column "visible task" cap (task id -> count). Absent = INITIAL_VISIBLE.
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [filterPriority, setFilterPriority] = useState<string>('ALL');
  const [filterAssignee, setFilterAssignee] = useState<string>('ALL');
  const [filterLabel, setFilterLabel] = useState<string>('ALL');
  const hasFilters =
    searchQuery || filterPriority !== 'ALL' || filterAssignee !== 'ALL' || filterLabel !== 'ALL';

  // Filter tasks within columns. Declared BEFORE handleDragEnd because the drag
  // handler maps the rendered (filtered) drop position back to a real index.
  const filteredColumns = useMemo(() => {
    if (!board) return [];
    if (!hasFilters) return board.columns;

    return board.columns.map((col) => ({
      ...col,
      tasks: col.tasks.filter((task) => {
        if (
          deferredSearchQuery &&
          !task.title.toLowerCase().includes(deferredSearchQuery.toLowerCase())
        )
          return false;
        if (filterPriority !== 'ALL' && task.priority !== filterPriority) return false;
        if (filterAssignee !== 'ALL' && !task.assignees.some((a) => a.user.id === filterAssignee))
          return false;
        if (filterLabel !== 'ALL' && !task.labels.some((l) => l.label.id === filterLabel))
          return false;
        return true;
      }),
    }));
  }, [board, deferredSearchQuery, filterPriority, filterAssignee, filterLabel, hasFilters]);

  const handleDragEnd = useCallback(
    (result: DropResult) => {
      if (!result.destination || !board) return;

      const { source, destination, draggableId, type } = result;
      if (source.droppableId === destination.droppableId && source.index === destination.index)
        return;

      // --- Column reorder ---
      if (type === 'COLUMN') {
        const newColumns = [...board.columns];
        const [moved] = newColumns.splice(source.index, 1);
        newColumns.splice(destination.index, 0, moved);

        const previous = board;
        utils.projects.getBoardWithTasks.setData(
          { boardId },
          {
            ...board,
            columns: newColumns,
          }
        );

        reorderColumns.mutate(
          { boardId, columnId: draggableId, newOrder: destination.index },
          {
            onError: () => {
              if (previous) utils.projects.getBoardWithTasks.setData({ boardId }, previous);
            },
          }
        );
        return;
      }

      // --- Task reorder / move ---
      // PROJ-01: the drag indices (source.index / destination.index) are positions
      // in the RENDERED list, which is `filteredColumns` when a filter is active.
      // Splicing those indices into the unfiltered `board.columns` moves the wrong
      // task and persists a wrong order. So we map everything by task id:
      //   1. remove the dragged task from the real source column by its id;
      //   2. work in filtered space to find which task the dragged one lands in
      //      front of (its "follow neighbour"), exactly as the DnD lib intends;
      //   3. insert before that neighbour's REAL index (or append) and send that
      //      real index as newOrder. When no filter is active filtered === real,
      //      so this collapses to the original behaviour.
      const newColumns = board.columns.map((col) => ({
        ...col,
        tasks: [...col.tasks],
      }));

      const sourceCol = newColumns.find((c) => c.id === source.droppableId);
      const destCol = newColumns.find((c) => c.id === destination.droppableId);
      if (!sourceCol || !destCol) return;

      // 1. Remove by id, not by (possibly filtered) index.
      const srcRealIdx = sourceCol.tasks.findIndex((t) => t.id === draggableId);
      if (srcRealIdx === -1) return;
      const [movedTask] = sourceCol.tasks.splice(srcRealIdx, 1);

      // 2. Determine the follow-neighbour in filtered space (post-removal list).
      const filteredSource =
        filteredColumns.find((c) => c.id === source.droppableId)?.tasks ?? sourceCol.tasks;
      const filteredDestBase =
        source.droppableId === destination.droppableId
          ? filteredSource
          : (filteredColumns.find((c) => c.id === destination.droppableId)?.tasks ?? destCol.tasks);
      const filteredDestAfterRemoval = filteredDestBase.filter((t) => t.id !== draggableId);
      const followNeighbour = filteredDestAfterRemoval[destination.index] ?? null;

      // 3. Translate that to a real insertion index in the unfiltered dest column.
      const destRealIdx = followNeighbour
        ? (() => {
            const i = destCol.tasks.findIndex((t) => t.id === followNeighbour.id);
            return i === -1 ? destCol.tasks.length : i;
          })()
        : destCol.tasks.length;
      destCol.tasks.splice(destRealIdx, 0, movedTask);

      // IMP-PROJ-09: if the task lands beyond the destination column's visible
      // cap, widen the cap so the moved card doesn't vanish below the fold.
      setVisibleCounts((prev) => {
        const cur = prev[destination.droppableId] ?? INITIAL_VISIBLE;
        if (destRealIdx < cur) return prev;
        return { ...prev, [destination.droppableId]: destRealIdx + 1 };
      });

      // IMP-PROJ-07: non-blocking warning when a cross-column move pushes the
      // destination past its WIP limit. destCol.tasks already includes the moved
      // card here, so its length is the post-move count. The move still proceeds.
      if (
        source.droppableId !== destination.droppableId &&
        destCol.wipLimit != null &&
        destCol.tasks.length > destCol.wipLimit
      ) {
        setWipWarning(
          `"${destCol.name}" is over its WIP limit (${destCol.tasks.length}/${destCol.wipLimit}).`
        );
      }

      const previous = board;
      utils.projects.getBoardWithTasks.setData(
        { boardId },
        {
          ...board,
          columns: newColumns,
        }
      );

      moveTask.mutate(
        {
          taskId: draggableId,
          targetColumnId: destination.droppableId,
          newOrder: destRealIdx,
        },
        {
          onError: () => {
            if (previous) utils.projects.getBoardWithTasks.setData({ boardId }, previous);
          },
        }
      );
    },
    [board, boardId, filteredColumns, moveTask, reorderColumns, utils.projects.getBoardWithTasks]
  );

  const handleAddTask = useCallback(
    (columnId: string, title: string, assigneeIds: string[]) => {
      createTask.mutate({ title, columnId, assigneeIds });
      setAddingToColumn(null);
      // IMP-PROJ-07: non-blocking warning if adding this task exceeds the limit.
      const col = board?.columns.find((c) => c.id === columnId);
      if (col?.wipLimit != null && col.tasks.length + 1 > col.wipLimit) {
        setWipWarning(
          `"${col.name}" is over its WIP limit (${col.tasks.length + 1}/${col.wipLimit}).`
        );
      }
    },
    [createTask, board, setAddingToColumn, setWipWarning]
  );

  // Stable selection handler so memoized children don't re-render on every change.
  const handleSelectTask = useCallback(
    (taskId: string) => setSelectedTaskId(taskId),
    [setSelectedTaskId]
  );

  // Compute unique assignees and labels from board data for filter options
  const allAssignees = useMemo(() => {
    if (!board) return [];
    const map = new Map<string, { id: string; name: string; avatar: string | null }>();
    for (const col of board.columns) {
      for (const task of col.tasks) {
        for (const a of task.assignees) {
          map.set(a.user.id, a.user);
        }
      }
    }
    return Array.from(map.values());
  }, [board]);

  const allLabels = useMemo(() => {
    return board?.labels ?? [];
  }, [board]);

  // IMP-PROJ-08: fast lookup of a task's current data (labels/assignees) so
  // bulk label/assign ops can skip no-ops and preserve existing assignees.
  const tasksById = useMemo(() => {
    const map = new Map<string, TaskData>();
    if (board) {
      for (const col of board.columns) {
        for (const task of col.tasks) map.set(task.id, task);
      }
    }
    return map;
  }, [board]);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  const toggleSelect = useCallback((taskId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setBulkMenu(null);
    setBulkDeleteConfirm(false);
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    clearSelection();
  }, [clearSelection]);

  const isBulkBusy =
    bulkMove.isPending ||
    bulkDelete.isPending ||
    bulkAddLabelM.isPending ||
    bulkRemoveLabelM.isPending ||
    bulkAssignM.isPending;

  // Run after every bulk op: refresh the board once, then drop the selection.
  const afterBulk = useCallback(async () => {
    await utils.projects.getBoardWithTasks.invalidate({ boardId });
    clearSelection();
  }, [boardId, clearSelection, utils.projects.getBoardWithTasks]);

  const handleBulkMove = async (targetColumnId: string) => {
    if (selectedIds.length === 0) return;
    await bulkMove.mutateAsync({ taskIds: selectedIds, targetColumnId });
    await afterBulk();
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    await bulkDelete.mutateAsync({ taskIds: selectedIds });
    await afterBulk();
  };

  const handleBulkAddLabel = async (labelId: string) => {
    const ids = selectedIds.filter(
      (id) => !tasksById.get(id)?.labels.some((l) => l.label.id === labelId)
    );
    await Promise.all(ids.map((id) => bulkAddLabelM.mutateAsync({ taskId: id, labelId })));
    await afterBulk();
  };

  const handleBulkRemoveLabel = async (labelId: string) => {
    const ids = selectedIds.filter((id) =>
      tasksById.get(id)?.labels.some((l) => l.label.id === labelId)
    );
    await Promise.all(ids.map((id) => bulkRemoveLabelM.mutateAsync({ taskId: id, labelId })));
    await afterBulk();
  };

  const handleBulkAssign = async (memberId: string) => {
    await Promise.all(
      selectedIds.map((id) => {
        const t = tasksById.get(id);
        if (!t) return Promise.resolve(undefined);
        const current = t.assignees.map((a) => a.user.id);
        if (current.includes(memberId)) return Promise.resolve(undefined);
        return bulkAssignM.mutateAsync({ taskId: id, assigneeIds: [...current, memberId] });
      })
    );
    await afterBulk();
  };

  if (isLoading) return <BoardSkeleton />;
  if (!board) return null;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-3 shrink-0">
          <div>
            <Link
              href={`/projects/${projectId}`}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-2"
            >
              <ArrowLeft className="h-4 w-4" />
              {board.project.name}
            </Link>
            <h1 className="font-display text-xl font-bold tracking-tight text-foreground">
              {board.name}
            </h1>
          </div>
        </div>

        {/* Filters toolbar */}
        <div className="flex flex-wrap items-center gap-2 mb-4 shrink-0">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tasks..."
              className="h-8 w-44 rounded-lg border border-border bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
            />
          </div>

          {/* Priority filter */}
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            className={cn(
              'h-8 rounded-lg border bg-card px-2.5 text-xs font-medium focus:border-primary focus:outline-none',
              filterPriority !== 'ALL'
                ? 'border-primary/30 text-primary'
                : 'border-border text-muted-foreground'
            )}
          >
            <option value="ALL">All Priorities</option>
            <option value="URGENT">Urgent</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </select>

          {/* Assignee filter */}
          <select
            value={filterAssignee}
            onChange={(e) => setFilterAssignee(e.target.value)}
            className={cn(
              'h-8 rounded-lg border bg-card px-2.5 text-xs font-medium focus:border-primary focus:outline-none',
              filterAssignee !== 'ALL'
                ? 'border-primary/30 text-primary'
                : 'border-border text-muted-foreground'
            )}
          >
            <option value="ALL">All Assignees</option>
            {allAssignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          {/* Label filter */}
          {allLabels.length > 0 && (
            <select
              value={filterLabel}
              onChange={(e) => setFilterLabel(e.target.value)}
              className={cn(
                'h-8 rounded-lg border bg-card px-2.5 text-xs font-medium focus:border-primary focus:outline-none',
                filterLabel !== 'ALL'
                  ? 'border-primary/30 text-primary'
                  : 'border-border text-muted-foreground'
              )}
            >
              <option value="ALL">All Labels</option>
              {allLabels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}

          {/* Clear filters */}
          {hasFilters && (
            <button
              onClick={() => {
                setSearchQuery('');
                setFilterPriority('ALL');
                setFilterAssignee('ALL');
                setFilterLabel('ALL');
              }}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          )}

          {/* IMP-PROJ-08: enter/exit multi-select mode */}
          <button
            onClick={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
            className={cn(
              'ml-auto flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
              selectionMode
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground'
            )}
          >
            <ListChecks className="h-3.5 w-3.5" />
            {selectionMode ? 'Done' : 'Select'}
          </button>
        </div>

        {/* Board — columns are draggable horizontally */}
        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="board-columns" direction="horizontal" type="COLUMN">
            {(boardProvided) => (
              <div
                ref={boardProvided.innerRef}
                {...boardProvided.droppableProps}
                className="flex gap-4 overflow-x-auto pb-4 flex-1 min-h-0"
              >
                {filteredColumns.map((column, colIndex) => {
                  // IMP-PROJ-07: WIP-limit values for this column's header indicator.
                  const wipLimit = column.wipLimit;
                  const wipCount = column.tasks.length;
                  const wipOver = wipLimit != null && wipCount > wipLimit;
                  return (
                    <Draggable key={column.id} draggableId={column.id} index={colIndex}>
                      {(colProvided, colSnapshot) => (
                        <div
                          ref={colProvided.innerRef}
                          {...(colProvided.draggableProps as HTMLAttributes<HTMLDivElement>)}
                          className={cn(
                            'flex flex-col w-full sm:w-72 sm:shrink-0 max-h-full rounded-xl transition-shadow',
                            colSnapshot.isDragging &&
                              'shadow-2xl shadow-black/20 ring-1 ring-primary/20'
                          )}
                        >
                          {/* Column header */}
                          <div className="flex items-center justify-between mb-3 px-1 group/col">
                            {/* Drag handle */}
                            <div
                              {...colProvided.dragHandleProps}
                              className="flex h-6 w-5 items-center justify-center rounded-md text-muted-foreground/0 group-hover/col:text-muted-foreground cursor-grab active:cursor-grabbing transition-colors shrink-0 mr-1"
                              title="Drag to reorder"
                            >
                              <GripVertical className="h-3.5 w-3.5" />
                            </div>

                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              {editingColumnId === column.id ? (
                                <ColumnRenameInput
                                  initialName={column.name}
                                  onRename={(name) => updateColumn.mutate({ id: column.id, name })}
                                  onCancel={() => setEditingColumnId(null)}
                                />
                              ) : (
                                <h3
                                  onDoubleClick={() => setEditingColumnId(column.id)}
                                  className="text-sm font-semibold text-foreground cursor-default truncate"
                                  title="Double-click to rename"
                                >
                                  {column.name}
                                </h3>
                              )}
                              {/* IMP-PROJ-07: task count, shown as count/limit when a
                                WIP limit is set; red once the column is over. */}
                              <span
                                className={cn(
                                  'flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium shrink-0',
                                  wipOver
                                    ? 'bg-red-500/15 text-red-500'
                                    : 'bg-secondary text-muted-foreground'
                                )}
                                title={
                                  wipLimit != null
                                    ? `${wipCount} of ${wipLimit} (WIP limit)`
                                    : `${wipCount} task${wipCount === 1 ? '' : 's'}`
                                }
                              >
                                {wipLimit != null ? `${wipCount}/${wipLimit}` : wipCount}
                              </span>
                            </div>

                            <div className="flex items-center gap-0.5">
                              {deletingColumnId === column.id ? (
                                <div className="flex items-center gap-1">
                                  {/* PROJ-03: name the task count so cascade deletion is never silent. */}
                                  <button
                                    onClick={() => deleteColumn.mutate({ id: column.id })}
                                    title={
                                      column.tasks.length > 0
                                        ? `Permanently deletes this column and its ${column.tasks.length} task(s), including their comments, checklists and attachments.`
                                        : 'Delete this empty column'
                                    }
                                    className="rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600"
                                  >
                                    {column.tasks.length > 0
                                      ? `Delete ${column.tasks.length} task${column.tasks.length === 1 ? '' : 's'}`
                                      : 'Delete'}
                                  </button>
                                  <button
                                    onClick={() => setDeletingColumnId(null)}
                                    className="text-[10px] text-muted-foreground hover:text-foreground px-1"
                                  >
                                    No
                                  </button>
                                </div>
                              ) : (
                                <>
                                  {/* IMP-PROJ-07: set / clear this column's WIP limit */}
                                  <button
                                    onClick={() =>
                                      setWipEditorColumnId((prev) =>
                                        prev === column.id ? null : column.id
                                      )
                                    }
                                    className={cn(
                                      'flex h-6 w-6 items-center justify-center rounded-md transition-all hover:bg-secondary hover:text-foreground',
                                      wipLimit != null || wipEditorColumnId === column.id
                                        ? 'text-muted-foreground'
                                        : 'text-muted-foreground/0 group-hover/col:text-muted-foreground'
                                    )}
                                    title={
                                      wipLimit != null ? `WIP limit: ${wipLimit}` : 'Set WIP limit'
                                    }
                                  >
                                    <Gauge className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={() => setDeletingColumnId(column.id)}
                                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/0 group-hover/col:text-muted-foreground hover:!bg-red-500/10 hover:!text-red-500 transition-all"
                                    title="Delete column"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={() => setAddingToColumn(column.id)}
                                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                                  >
                                    <Plus className="h-4 w-4" />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>

                          {/* IMP-PROJ-07: WIP-limit editor (set / clear) */}
                          {wipEditorColumnId === column.id && (
                            <ColumnWipEditor
                              initialLimit={wipLimit}
                              taskCount={wipCount}
                              isSaving={updateColumn.isPending}
                              onSave={(limit) =>
                                updateColumn.mutate({ id: column.id, wipLimit: limit })
                              }
                              onClear={() => updateColumn.mutate({ id: column.id, wipLimit: null })}
                              onCancel={() => setWipEditorColumnId(null)}
                            />
                          )}

                          {/* Column owners — auto-assigned when a task enters */}
                          <ColumnOwners
                            column={column}
                            projectMembers={board.project.members}
                            currentUserId={session?.user?.id}
                            isAdmin={session?.user?.role === 'ADMIN'}
                            pickerOpen={ownerPickerColumnId === column.id}
                            onTogglePicker={() =>
                              setOwnerPickerColumnId((prev) =>
                                prev === column.id ? null : column.id
                              )
                            }
                            onSave={(userIds) =>
                              setColumnOwners.mutate({ columnId: column.id, userIds })
                            }
                            isSaving={setColumnOwners.isPending}
                          />

                          {/* Droppable task zone */}
                          <Droppable droppableId={column.id} type="TASK">
                            {(provided, snapshot) => {
                              // IMP-PROJ-09: only render the first N (filtered) tasks.
                              const visible = visibleCounts[column.id] ?? INITIAL_VISIBLE;
                              const hiddenCount = column.tasks.length - visible;
                              return (
                                <div
                                  ref={provided.innerRef}
                                  {...provided.droppableProps}
                                  className={cn(
                                    'flex-1 space-y-2 rounded-xl p-2 min-h-[100px] overflow-y-auto transition-colors',
                                    snapshot.isDraggingOver
                                      ? 'bg-primary/5 ring-1 ring-primary/20'
                                      : 'bg-secondary/30'
                                  )}
                                >
                                  {column.tasks.slice(0, visible).map((task, index) => {
                                    const isSelected = selected.has(task.id);
                                    return (
                                      <Draggable key={task.id} draggableId={task.id} index={index}>
                                        {(taskProvided, taskSnapshot) => (
                                          <div
                                            ref={taskProvided.innerRef}
                                            {...(taskProvided.draggableProps as HTMLAttributes<HTMLDivElement>)}
                                            {...(taskProvided.dragHandleProps as HTMLAttributes<HTMLDivElement>)}
                                            onClick={() =>
                                              selectionMode
                                                ? toggleSelect(task.id)
                                                : handleSelectTask(task.id)
                                            }
                                            className={cn(
                                              'group/card relative rounded-xl border bg-card p-3.5 cursor-pointer transition-all',
                                              isSelected
                                                ? 'border-primary ring-2 ring-primary/30'
                                                : 'border-border/60',
                                              taskSnapshot.isDragging
                                                ? 'shadow-xl shadow-black/10 rotate-[2deg] border-primary/30'
                                                : 'hover:border-border hover:shadow-md hover:shadow-black/5 dark:hover:shadow-black/20'
                                            )}
                                          >
                                            {/* IMP-PROJ-08: per-card select checkbox */}
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                if (!selectionMode) setSelectionMode(true);
                                                toggleSelect(task.id);
                                              }}
                                              className={cn(
                                                'absolute right-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-md border transition-all',
                                                isSelected
                                                  ? 'border-primary bg-primary text-primary-foreground opacity-100'
                                                  : 'border-border bg-card text-transparent opacity-0 group-hover/card:opacity-100',
                                                selectionMode && 'opacity-100'
                                              )}
                                              title={isSelected ? 'Deselect task' : 'Select task'}
                                              aria-label={
                                                isSelected ? 'Deselect task' : 'Select task'
                                              }
                                            >
                                              {isSelected && (
                                                <Check className="h-3.5 w-3.5" strokeWidth={3} />
                                              )}
                                            </button>
                                            <TaskCard task={task} />
                                          </div>
                                        )}
                                      </Draggable>
                                    );
                                  })}
                                  {provided.placeholder}

                                  {/* IMP-PROJ-09: reveal more tasks in this column */}
                                  {hiddenCount > 0 && (
                                    <button
                                      onClick={() =>
                                        setVisibleCounts((prev) => ({
                                          ...prev,
                                          [column.id]:
                                            (prev[column.id] ?? INITIAL_VISIBLE) + INITIAL_VISIBLE,
                                        }))
                                      }
                                      className="w-full rounded-lg border border-dashed border-border bg-card/50 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                                    >
                                      Show {Math.min(INITIAL_VISIBLE, hiddenCount)} more
                                    </button>
                                  )}

                                  {/* Inline add task */}
                                  {addingToColumn === column.id && (
                                    <AddTaskForm
                                      columnId={column.id}
                                      teamMembers={teamMembers}
                                      onAdd={handleAddTask}
                                      onCancel={() => setAddingToColumn(null)}
                                    />
                                  )}
                                </div>
                              );
                            }}
                          </Droppable>
                        </div>
                      )}
                    </Draggable>
                  );
                })}
                {boardProvided.placeholder}

                {/* Add column */}
                <div className="w-72 shrink-0">
                  {addingColumn ? (
                    <div className="rounded-xl border border-primary/30 bg-card p-3">
                      <input
                        autoFocus
                        value={newColumnName}
                        onChange={(e) => setNewColumnName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newColumnName.trim())
                            createColumn.mutate({ boardId, name: newColumnName.trim() });
                          if (e.key === 'Escape') {
                            setAddingColumn(false);
                            setNewColumnName('');
                          }
                        }}
                        placeholder="Column name..."
                        className="w-full bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:outline-none"
                      />
                      <div className="flex items-center justify-between mt-2">
                        <button
                          onClick={() => {
                            if (newColumnName.trim())
                              createColumn.mutate({ boardId, name: newColumnName.trim() });
                          }}
                          disabled={!newColumnName.trim() || createColumn.isPending}
                          className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-40"
                        >
                          {createColumn.isPending ? 'Adding...' : 'Add Column'}
                        </button>
                        <button
                          onClick={() => {
                            setAddingColumn(false);
                            setNewColumnName('');
                          }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setAddingColumn(true)}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-secondary/20 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground hover:bg-secondary/40"
                    >
                      <Plus className="h-4 w-4" />
                      Add Column
                    </button>
                  )}
                </div>
              </div>
            )}
          </Droppable>
        </DragDropContext>
      </div>

      {/* IMP-PROJ-08: bulk-action toolbar — appears while ≥1 task is selected */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 animate-fade-in">
          <div className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 shadow-2xl shadow-black/25">
            <span className="px-1 text-xs font-semibold text-foreground">
              {selected.size} selected
            </span>
            <div className="h-5 w-px bg-border" />

            {/* Move to column */}
            <BulkMenuButton
              label="Move"
              icon={<MoveRight className="h-3.5 w-3.5" />}
              open={bulkMenu === 'move'}
              onToggle={() => setBulkMenu((m) => (m === 'move' ? null : 'move'))}
              disabled={isBulkBusy}
            >
              {board.columns.map((c) => (
                <BulkMenuItem key={c.id} onClick={() => handleBulkMove(c.id)}>
                  {c.name}
                </BulkMenuItem>
              ))}
            </BulkMenuButton>

            {/* Add label */}
            {allLabels.length > 0 && (
              <BulkMenuButton
                label="Label"
                icon={<Tag className="h-3.5 w-3.5" />}
                open={bulkMenu === 'addLabel'}
                onToggle={() => setBulkMenu((m) => (m === 'addLabel' ? null : 'addLabel'))}
                disabled={isBulkBusy}
              >
                <p className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Add label
                </p>
                {allLabels.map((l) => (
                  <BulkMenuItem key={l.id} onClick={() => handleBulkAddLabel(l.id)}>
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: l.color }}
                    />
                    {l.name}
                  </BulkMenuItem>
                ))}
              </BulkMenuButton>
            )}

            {/* Remove label */}
            {allLabels.length > 0 && (
              <BulkMenuButton
                label="Unlabel"
                icon={<Tag className="h-3.5 w-3.5" />}
                open={bulkMenu === 'removeLabel'}
                onToggle={() => setBulkMenu((m) => (m === 'removeLabel' ? null : 'removeLabel'))}
                disabled={isBulkBusy}
              >
                <p className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Remove label
                </p>
                {allLabels.map((l) => (
                  <BulkMenuItem key={l.id} onClick={() => handleBulkRemoveLabel(l.id)}>
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: l.color }}
                    />
                    {l.name}
                  </BulkMenuItem>
                ))}
              </BulkMenuButton>
            )}

            {/* Assign member */}
            {teamMembers && teamMembers.length > 0 && (
              <BulkMenuButton
                label="Assign"
                icon={<UserPlus className="h-3.5 w-3.5" />}
                open={bulkMenu === 'assign'}
                onToggle={() => setBulkMenu((m) => (m === 'assign' ? null : 'assign'))}
                disabled={isBulkBusy}
              >
                {teamMembers.map((m) => (
                  <BulkMenuItem key={m.id} onClick={() => handleBulkAssign(m.id)}>
                    <Avatar className="h-4 w-4">
                      <AvatarImage src={m.avatar ?? undefined} />
                      <AvatarFallback className="text-[7px] bg-secondary font-medium">
                        {m.name[0]}
                      </AvatarFallback>
                    </Avatar>
                    {m.name}
                  </BulkMenuItem>
                ))}
              </BulkMenuButton>
            )}

            <div className="h-5 w-px bg-border" />

            {/* Delete (single confirm) */}
            {bulkDeleteConfirm ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={handleBulkDelete}
                  disabled={isBulkBusy}
                  className="rounded-lg bg-red-500 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                >
                  {bulkDelete.isPending ? 'Deleting…' : `Delete ${selected.size}`}
                </button>
                <button
                  onClick={() => setBulkDeleteConfirm(false)}
                  className="rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setBulkMenu(null);
                  setBulkDeleteConfirm(true);
                }}
                disabled={isBulkBusy}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                title="Delete selected tasks"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}

            <div className="h-5 w-px bg-border" />

            <button
              onClick={clearSelection}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title="Clear selection"
              aria-label="Clear selection"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* IMP-PROJ-07: transient, non-blocking WIP-limit warning */}
      {wipWarning && (
        <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 animate-fade-in">
          <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-card px-3.5 py-2 shadow-2xl shadow-black/25">
            <span className="flex h-2 w-2 shrink-0 rounded-full bg-amber-500" />
            <span className="text-xs font-medium text-foreground">{wipWarning}</span>
            <button
              onClick={() => setWipWarning(null)}
              className="ml-1 flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="Dismiss warning"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Task detail slide-over */}
      {selectedTaskId && (
        <TaskDetailSheet
          taskId={selectedTaskId}
          boardId={boardId}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </>
  );
}

const TaskCard = memo(function TaskCard({ task }: { task: TaskData }) {
  const hasChecklist = task.checklists && task.checklists.length > 0;
  const totalItems = hasChecklist
    ? task.checklists.reduce((sum: number, cl: TaskChecklist) => sum + cl.items.length, 0)
    : 0;
  const completedItems = hasChecklist
    ? task.checklists.reduce(
        (sum: number, cl: TaskChecklist) =>
          sum + cl.items.filter((i: ChecklistItem) => i.completed).length,
        0
      )
    : 0;

  // IMP-PROJ-06: blocked when any blocker's blocking task is NOT in a done column.
  const isBlocked = task.blockedBy.some((b) => !DONE_COLUMN_RE.test(b.blockingTask.column.name));

  return (
    <>
      {task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {task.labels.map((tl: TaskLabel) => (
            <span
              key={tl.label.id}
              className="inline-block h-1.5 w-8 rounded-full"
              style={{ backgroundColor: tl.label.color }}
              title={tl.label.name}
            />
          ))}
        </div>
      )}

      <p className="text-sm font-medium text-foreground leading-snug">{task.title}</p>

      <div className="flex items-center justify-between mt-3">
        <div className="flex items-center gap-2">
          <div
            className={cn('h-2 w-2 rounded-full', priorityColors[task.priority])}
            title={task.priority}
          />

          {task.dueDate && (
            <span
              className={cn(
                'flex items-center gap-1 text-[11px]',
                new Date(task.dueDate) < new Date()
                  ? 'text-red-500 font-medium'
                  : 'text-muted-foreground'
              )}
            >
              <Calendar className="h-3 w-3" />
              {format(new Date(task.dueDate), 'MMM d')}
            </span>
          )}

          {hasChecklist && totalItems > 0 && (
            <span
              className={cn(
                'flex items-center gap-1 text-[11px]',
                completedItems === totalItems ? 'text-emerald-500' : 'text-muted-foreground'
              )}
            >
              <CheckSquare className="h-3 w-3" />
              {completedItems}/{totalItems}
            </span>
          )}

          {task._count.comments > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              {task._count.comments}
            </span>
          )}

          {task._count.attachments > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Paperclip className="h-3 w-3" />
              {task._count.attachments}
            </span>
          )}

          {isBlocked && (
            <span
              className="flex items-center gap-1 text-[11px] font-medium text-red-500"
              title="Blocked by an unfinished task"
            >
              <Ban className="h-3 w-3" />
              Blocked
            </span>
          )}
        </div>

        {task.assignees.length > 0 && (
          <div className="flex -space-x-1.5">
            {task.assignees.slice(0, 3).map((a: TaskAssignee) => (
              <Avatar key={a.user.id} className="h-5 w-5 border border-card">
                <AvatarImage src={a.user.avatar ?? undefined} />
                <AvatarFallback className="text-[8px] bg-secondary font-medium">
                  {a.user.name[0]}
                </AvatarFallback>
              </Avatar>
            ))}
          </div>
        )}
      </div>
    </>
  );
});

/* ============================================
   Add Task — inline new-task form (owns its own draft state)
   ============================================ */
function AddTaskForm({
  columnId,
  teamMembers,
  onAdd,
  onCancel,
}: {
  columnId: string;
  teamMembers: Array<{ id: string; name: string; avatar: string | null }> | undefined;
  onAdd: (columnId: string, title: string, assigneeIds: string[]) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [assignees, setAssignees] = useState<string[]>([]);

  const submit = () => {
    if (!title.trim()) return;
    onAdd(columnId, title.trim(), assignees);
  };

  return (
    <div className="rounded-xl border border-primary/30 bg-card p-3 space-y-2">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="Task title..."
        className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      {/* Assignee picker */}
      <div className="flex flex-wrap gap-1">
        {teamMembers?.slice(0, 6).map((m) => (
          <button
            key={m.id}
            onClick={() =>
              setAssignees((prev) =>
                prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id]
              )
            }
            className={cn(
              'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              assignees.includes(m.id)
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            )}
          >
            <Avatar className="h-3.5 w-3.5">
              <AvatarImage src={m.avatar ?? undefined} />
              <AvatarFallback className="text-[6px] bg-muted">{m.name[0]}</AvatarFallback>
            </Avatar>
            {m.name.split(' ')[0]}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <button
          onClick={submit}
          disabled={!title.trim()}
          className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          Add
        </button>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/* ============================================
   Column Rename — inline rename input (owns its own draft state)
   ============================================ */
function ColumnRenameInput({
  initialName,
  onRename,
  onCancel,
}: {
  initialName: string;
  onRename: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialName);

  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value.trim() && value.trim() !== initialName) {
          onRename(value.trim());
        } else {
          onCancel();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) onRename(value.trim());
        if (e.key === 'Escape') onCancel();
      }}
      className="text-sm font-semibold text-foreground bg-transparent border-b border-primary pb-0.5 focus:outline-none w-full"
    />
  );
}

/* ============================================
   Column WIP limit — set / clear a column's work-in-progress cap (IMP-PROJ-07)
   Owns its own draft state; a blank value clears the limit.
   ============================================ */
function ColumnWipEditor({
  initialLimit,
  taskCount,
  onSave,
  onClear,
  onCancel,
  isSaving,
}: {
  initialLimit: number | null;
  taskCount: number;
  onSave: (limit: number) => void;
  onClear: () => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [value, setValue] = useState(initialLimit != null ? String(initialLimit) : '');
  const trimmed = value.trim();
  const num = Number(trimmed);
  const valid = trimmed !== '' && Number.isInteger(num) && num >= 0;

  const submit = () => {
    if (trimmed === '') onClear();
    else if (valid) onSave(num);
  };

  return (
    <div className="px-1 -mt-1 mb-2">
      <div className="rounded-lg border border-primary/20 bg-card p-2 shadow-lg">
        <div className="flex items-center justify-between mb-2 px-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            WIP limit
          </p>
          <button
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close WIP editor"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        <p className="px-1 mb-2 text-[10px] text-muted-foreground leading-snug">
          Max tasks for this column ({taskCount} now). Leave blank to remove the limit.
        </p>
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            type="number"
            min={0}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onCancel();
            }}
            placeholder="No limit"
            className="h-7 w-20 rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
          <button
            onClick={submit}
            disabled={isSaving || (trimmed !== '' && !valid)}
            className="rounded-md bg-primary px-2.5 py-1 text-[10px] font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40 transition-colors"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          {initialLimit != null && (
            <button
              onClick={onClear}
              disabled={isSaving}
              className="rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================
   Column Owners — auto-assignees for a column
   ============================================ */
type ColumnOwnersColumn = {
  id: string;
  defaultAssignees: Array<{
    user: { id: string; name: string; avatar: string | null; title: string | null };
  }>;
};

type ProjectMember = {
  role: string;
  user: { id: string; name: string; avatar: string | null; title: string | null };
};

function ColumnOwners({
  column,
  projectMembers,
  currentUserId,
  isAdmin,
  pickerOpen,
  onTogglePicker,
  onSave,
  isSaving,
}: {
  column: ColumnOwnersColumn;
  projectMembers: ProjectMember[];
  currentUserId: string | undefined;
  isAdmin: boolean;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onSave: (userIds: string[]) => void;
  isSaving: boolean;
}) {
  const callerMembership = projectMembers.find((m) => m.user.id === currentUserId);
  const canManage = isAdmin || callerMembership?.role === 'LEAD';

  const owners = column.defaultAssignees;
  const hasOwners = owners.length > 0;

  // Local draft state for the picker — committed on Save
  const [draft, setDraft] = useState<Set<string>>(new Set(owners.map((o) => o.user.id)));

  const toggle = (userId: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleSave = () => onSave(Array.from(draft));
  const isDirty = draft.size !== owners.length || owners.some((o) => !draft.has(o.user.id));

  // Empty + can't manage → render nothing (don't take up space)
  if (!hasOwners && !canManage) return null;

  return (
    <div className="px-1 -mt-1 mb-2">
      {/* Compact owner row */}
      <button
        type="button"
        onClick={
          canManage
            ? () => {
                if (!pickerOpen) setDraft(new Set(owners.map((o) => o.user.id)));
                onTogglePicker();
              }
            : undefined
        }
        disabled={!canManage}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] transition-colors',
          canManage && 'hover:bg-secondary/50',
          !canManage && 'cursor-default'
        )}
        title={canManage ? 'Set column owners' : undefined}
      >
        {hasOwners ? (
          <>
            <Crown className="h-3 w-3 text-primary shrink-0" />
            <div className="flex -space-x-1.5">
              {owners.slice(0, 4).map((o) => (
                <Avatar key={o.user.id} className="h-5 w-5 border-[1.5px] border-card">
                  <AvatarImage src={o.user.avatar ?? undefined} />
                  <AvatarFallback className="text-[8px] bg-secondary font-medium">
                    {o.user.name[0]}
                  </AvatarFallback>
                </Avatar>
              ))}
              {owners.length > 4 && (
                <div className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-card bg-secondary text-[8px] font-semibold text-muted-foreground">
                  +{owners.length - 4}
                </div>
              )}
            </div>
            <span className="truncate text-muted-foreground">
              {owners.length === 1
                ? `${owners[0].user.name.split(' ')[0]} owns this column`
                : `${owners.length} owners`}
            </span>
          </>
        ) : (
          <>
            <UserPlus className="h-3 w-3 text-muted-foreground/60 shrink-0" />
            <span className="text-muted-foreground/60">Set column owner</span>
          </>
        )}
      </button>

      {/* Picker panel */}
      {pickerOpen && canManage && (
        <div className="mt-1.5 rounded-lg border border-primary/20 bg-card p-2 shadow-lg">
          <div className="flex items-center justify-between mb-2 px-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Column owners
            </p>
            <button
              onClick={onTogglePicker}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close picker"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <p className="px-1 mb-2 text-[10px] text-muted-foreground leading-snug">
            Tasks moved into this column will be auto-assigned to these members. Existing assignees
            are kept.
          </p>
          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {projectMembers.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-muted-foreground text-center">
                No project members yet. Add members from the Team tab first.
              </p>
            ) : (
              projectMembers.map((m) => {
                const checked = draft.has(m.user.id);
                return (
                  <button
                    key={m.user.id}
                    type="button"
                    onClick={() => toggle(m.user.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
                      checked ? 'bg-primary/10' : 'hover:bg-secondary'
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors shrink-0',
                        checked ? 'bg-primary border-primary' : 'border-border bg-background'
                      )}
                    >
                      {checked && (
                        <CheckSquare className="h-2.5 w-2.5 text-white" strokeWidth={3} />
                      )}
                    </div>
                    <Avatar className="h-5 w-5">
                      <AvatarImage src={m.user.avatar ?? undefined} />
                      <AvatarFallback className="text-[8px] bg-secondary font-medium">
                        {m.user.name[0]}
                      </AvatarFallback>
                    </Avatar>
                    <span className="flex-1 truncate text-[11px] text-foreground">
                      {m.user.name}
                    </span>
                    {m.role === 'LEAD' && <Crown className="h-2.5 w-2.5 text-primary shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
          <div className="mt-2 flex items-center justify-end gap-1.5 pt-2 border-t border-border/60">
            <button
              onClick={onTogglePicker}
              className="rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!isDirty || isSaving}
              className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[10px] font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40 transition-colors"
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================
   Bulk-action toolbar menus (IMP-PROJ-08)
   A button whose dropdown opens upward (the toolbar is pinned to the bottom).
   ============================================ */
function BulkMenuButton({
  label,
  icon,
  open,
  onToggle,
  disabled,
  children,
}: {
  label: string;
  icon: ReactNode;
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        disabled={disabled}
        className={cn(
          'flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
          open
            ? 'bg-secondary text-foreground'
            : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
        )}
      >
        {icon}
        {label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={onToggle} />
          <div className="absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-48 overflow-y-auto rounded-xl border border-border bg-card py-1 shadow-xl shadow-black/15">
            {children}
          </div>
        </>
      )}
    </div>
  );
}

function BulkMenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary"
    >
      {children}
    </button>
  );
}

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
