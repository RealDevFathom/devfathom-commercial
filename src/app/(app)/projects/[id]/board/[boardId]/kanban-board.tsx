'use client';

import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useDeferredValue,
  memo,
  type HTMLAttributes,
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

type TaskLabel = { label: { id: string; name: string; color: string } };
type TaskAssignee = { user: { id: string; name: string; avatar: string | null } };
// Board cards only need checklist completion counts — getBoardWithTasks selects items.completed only.
type ChecklistItem = { completed: boolean };
type TaskChecklist = { id: string; name: string; items: ChecklistItem[] };
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
    },
  });
  const deleteColumn = trpc.projects.deleteColumn.useMutation({
    onSuccess: () => {
      utils.projects.getBoardWithTasks.invalidate({ boardId });
      setDeletingColumnId(null);
    },
  });

  const { data: teamMembers } = trpc.team.getRoster.useQuery();
  const [addingToColumn, setAddingToColumn] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [deletingColumnId, setDeletingColumnId] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [filterPriority, setFilterPriority] = useState<string>('ALL');
  const [filterAssignee, setFilterAssignee] = useState<string>('ALL');
  const [filterLabel, setFilterLabel] = useState<string>('ALL');
  const hasFilters =
    searchQuery || filterPriority !== 'ALL' || filterAssignee !== 'ALL' || filterLabel !== 'ALL';

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
      const newColumns = board.columns.map((col) => ({
        ...col,
        tasks: [...col.tasks],
      }));

      const sourceCol = newColumns.find((c) => c.id === source.droppableId);
      const destCol = newColumns.find((c) => c.id === destination.droppableId);
      if (!sourceCol || !destCol) return;

      const [movedTask] = sourceCol.tasks.splice(source.index, 1);
      destCol.tasks.splice(destination.index, 0, movedTask);

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
          newOrder: destination.index,
        },
        {
          onError: () => {
            if (previous) utils.projects.getBoardWithTasks.setData({ boardId }, previous);
          },
        }
      );
    },
    [board, boardId, moveTask, reorderColumns, utils.projects.getBoardWithTasks]
  );

  const handleAddTask = useCallback(
    (columnId: string, title: string, assigneeIds: string[]) => {
      createTask.mutate({ title, columnId, assigneeIds });
      setAddingToColumn(null);
    },
    [createTask]
  );

  // Stable selection handler so memoized children don't re-render on every change.
  const handleSelectTask = useCallback((taskId: string) => setSelectedTaskId(taskId), []);

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

  // Filter tasks within columns
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

  if (isLoading) return <BoardSkeleton />;
  if (!board) return null;

  return (
    <>
      <div className="flex flex-col h-[calc(100vh-8rem)]">
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
                {filteredColumns.map((column, colIndex) => (
                  <Draggable key={column.id} draggableId={column.id} index={colIndex}>
                    {(colProvided, colSnapshot) => (
                      <div
                        ref={colProvided.innerRef}
                        {...(colProvided.draggableProps as HTMLAttributes<HTMLDivElement>)}
                        className={cn(
                          'flex flex-col w-72 shrink-0 max-h-full rounded-xl transition-shadow',
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
                            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-secondary px-1.5 text-[11px] font-medium text-muted-foreground shrink-0">
                              {column.tasks.length}
                            </span>
                          </div>

                          <div className="flex items-center gap-0.5">
                            {deletingColumnId === column.id ? (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => deleteColumn.mutate({ id: column.id })}
                                  className="rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600"
                                >
                                  Delete
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
                          {(provided, snapshot) => (
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
                              {column.tasks.map((task, index) => (
                                <Draggable key={task.id} draggableId={task.id} index={index}>
                                  {(taskProvided, taskSnapshot) => (
                                    <div
                                      ref={taskProvided.innerRef}
                                      {...(taskProvided.draggableProps as HTMLAttributes<HTMLDivElement>)}
                                      {...(taskProvided.dragHandleProps as HTMLAttributes<HTMLDivElement>)}
                                      onClick={() => handleSelectTask(task.id)}
                                      className={cn(
                                        'rounded-xl border border-border/60 bg-card p-3.5 cursor-pointer transition-all',
                                        taskSnapshot.isDragging
                                          ? 'shadow-xl shadow-black/10 rotate-[2deg] border-primary/30'
                                          : 'hover:border-border hover:shadow-md hover:shadow-black/5 dark:hover:shadow-black/20'
                                      )}
                                    >
                                      <TaskCard task={task} />
                                    </div>
                                  )}
                                </Draggable>
                              ))}
                              {provided.placeholder}

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
                          )}
                        </Droppable>
                      </div>
                    )}
                  </Draggable>
                ))}
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
                          className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-[#0C2E2C] disabled:opacity-40"
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
          className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-[#0C2E2C] disabled:opacity-40"
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

  // Reset draft whenever the picker opens (in case owners were updated externally)
  const ownerIdsKey = owners
    .map((o) => o.user.id)
    .sort()
    .join(',');
  // Sync draft when picker opens or owners change
  useEffect(() => {
    if (pickerOpen) setDraft(new Set(owners.map((o) => o.user.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen, ownerIdsKey]);

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
        onClick={canManage ? onTogglePicker : undefined}
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
              className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
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
