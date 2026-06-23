'use client';

import { memo, useMemo, useState, type ChangeEvent } from 'react';
import { useSession } from 'next-auth/react';
import {
  X,
  Calendar,
  Users,
  CheckSquare,
  MessageSquare,
  Send,
  Circle,
  Trash2,
  ChevronDown,
  Tag,
  Plus,
  Check,
  Paperclip,
  Download,
  Loader2,
  Pencil,
  Clock,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';

type TaskDetailData = NonNullable<inferRouterOutputs<AppRouter>['projects']['getTaskDetail']>;
type TaskComment = TaskDetailData['comments'][number];

const priorities = [
  { value: 'URGENT', label: 'Urgent', color: 'text-red-500', bg: 'bg-red-500' },
  { value: 'HIGH', label: 'High', color: 'text-primary', bg: 'bg-primary' },
  { value: 'MEDIUM', label: 'Medium', color: 'text-amber-500', bg: 'bg-amber-500' },
  { value: 'LOW', label: 'Low', color: 'text-muted-foreground', bg: 'bg-muted-foreground/40' },
] as const;

// Per-comment formatting is memoized so re-renders of the sheet (e.g. typing in
// the composer) don't recompute relative timestamps for every comment.
const CommentItem = memo(function CommentItem({
  comment,
  currentUserId,
  isAdmin,
  onEdit,
  onDelete,
}: {
  comment: TaskComment;
  currentUserId?: string;
  isAdmin?: boolean;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
}) {
  const relativeTime = useMemo(
    () => formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true }),
    [comment.createdAt]
  );
  // IMP-PROJ-04: a comment author (or admin) can edit/delete their comment.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const canModify = comment.user.id === currentUserId || !!isAdmin;
  return (
    <div className="group/comment flex gap-3">
      <Avatar className="h-7 w-7 shrink-0 mt-0.5">
        <AvatarImage src={comment.user.avatar ?? undefined} />
        <AvatarFallback className="text-[9px] bg-secondary font-medium">
          {comment.user.name[0]}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground">{comment.user.name}</span>
          <span className="text-[11px] text-muted-foreground/50">{relativeTime}</span>
          {canModify && !editing && (
            <div className="ml-auto flex gap-0.5 opacity-0 group-hover/comment:opacity-100 transition-opacity">
              <button
                onClick={() => {
                  setDraft(comment.content);
                  setEditing(true);
                }}
                className="text-muted-foreground/60 hover:text-foreground"
                title="Edit"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                onClick={() => onDelete(comment.id)}
                className="text-muted-foreground/60 hover:text-red-500"
                title="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
        {editing ? (
          <div className="mt-1 flex items-center gap-2">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) {
                  onEdit(comment.id, draft.trim());
                  setEditing(false);
                }
                if (e.key === 'Escape') setEditing(false);
              }}
              className="flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none"
            />
            <button
              onClick={() => {
                if (draft.trim()) {
                  onEdit(comment.id, draft.trim());
                  setEditing(false);
                }
              }}
              className="text-[11px] font-semibold text-primary"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">{comment.content}</p>
        )}
      </div>
    </div>
  );
});

// Memoized comment list — only re-renders when the comments array identity
// changes (i.e. after a real fetch), not on every keystroke in the sheet.
const CommentList = memo(function CommentList({
  comments,
  currentUserId,
  isAdmin,
  onEdit,
  onDelete,
}: {
  comments: TaskComment[];
  currentUserId?: string;
  isAdmin?: boolean;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      {comments.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </>
  );
});

// IMP-PROJ-10: surface the task's already-logged activity (created/completed/...).
function TaskActivityTimeline({ taskId }: { taskId: string }) {
  const { data } = trpc.projects.getTaskActivity.useQuery({ taskId });
  if (!data || data.length === 0) return null;
  return (
    <div>
      <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <Clock className="h-3 w-3" /> Activity
      </h4>
      <ul className="space-y-1.5">
        {data.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-[11px]">
            <Circle className="h-1.5 w-1.5 shrink-0 fill-current text-primary/50" />
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground/80">{a.user?.name ?? 'Someone'}</span>{' '}
              {a.message}
            </span>
            <span className="ml-auto shrink-0 text-muted-foreground/50">
              {formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// IMP-PROJ-02: full checklist management (was a read-only dead-end).
type ChecklistData = TaskDetailData['checklists'][number];

function ChecklistBlock({
  cl,
  onDelete,
  onToggle,
  onAddItem,
  onDeleteItem,
}: {
  cl: ChecklistData;
  onDelete: () => void;
  onToggle: (id: string, completed: boolean) => void;
  onAddItem: (text: string) => void;
  onDeleteItem: (id: string) => void;
}) {
  const [newItem, setNewItem] = useState('');
  const total = cl.items.length;
  const done = cl.items.filter((i) => i.completed).length;
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <div className="group/cl">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-foreground">{cl.name}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {done}/{total}
          </span>
          <button
            onClick={onDelete}
            className="opacity-0 group-hover/cl:opacity-100 text-muted-foreground/60 hover:text-red-500 transition-opacity"
            title="Delete checklist"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-secondary mb-3">
        <div
          className={cn('h-full rounded-full transition-all', pct === 100 ? 'bg-emerald-500' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="space-y-1">
        {cl.items.map((item) => (
          <div
            key={item.id}
            className="group/it flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-secondary/50 transition-colors"
          >
            <input
              type="checkbox"
              checked={item.completed}
              onChange={() => onToggle(item.id, !item.completed)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span
              className={cn(
                'flex-1 text-sm',
                item.completed ? 'text-muted-foreground line-through' : 'text-foreground'
              )}
            >
              {item.text}
            </span>
            <button
              onClick={() => onDeleteItem(item.id)}
              className="opacity-0 group-hover/it:opacity-100 text-muted-foreground/60 hover:text-red-500 transition-opacity"
              title="Delete item"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <input
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newItem.trim()) {
              onAddItem(newItem.trim());
              setNewItem('');
            }
          }}
          placeholder="Add an item…"
          className="w-full rounded-lg px-2 py-1.5 text-sm bg-transparent text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:bg-secondary/30"
        />
      </div>
    </div>
  );
}

function ChecklistSection({
  taskId,
  checklists,
  onMutated,
}: {
  taskId: string;
  checklists: ChecklistData[];
  onMutated: () => void;
}) {
  const createChecklist = trpc.projects.createChecklist.useMutation({ onSuccess: onMutated });
  const deleteChecklist = trpc.projects.deleteChecklist.useMutation({ onSuccess: onMutated });
  const addItem = trpc.projects.addChecklistItem.useMutation({ onSuccess: onMutated });
  const deleteItem = trpc.projects.deleteChecklistItem.useMutation({ onSuccess: onMutated });
  const toggleItem = trpc.projects.toggleChecklistItem.useMutation({ onSuccess: onMutated });
  const [newName, setNewName] = useState('');
  const addChecklist = () => {
    if (!newName.trim()) return;
    createChecklist.mutate({ taskId, name: newName.trim() });
    setNewName('');
  };
  return (
    <div>
      <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <CheckSquare className="h-3 w-3" /> Checklists
      </h4>
      <div className="space-y-4">
        {checklists.map((cl) => (
          <ChecklistBlock
            key={cl.id}
            cl={cl}
            onDelete={() => deleteChecklist.mutate({ id: cl.id })}
            onToggle={(id, completed) => toggleItem.mutate({ id, completed })}
            onAddItem={(text) => addItem.mutate({ checklistId: cl.id, text })}
            onDeleteItem={(id) => deleteItem.mutate({ id })}
          />
        ))}
        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addChecklist();
            }}
            placeholder="Add a checklist…"
            className="flex-1 rounded-lg border border-border bg-secondary/50 px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
          <button
            onClick={addChecklist}
            disabled={!newName.trim()}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-primary disabled:opacity-30"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Owns its own draft state so typing a comment doesn't re-render the whole sheet.
function CommentComposer({
  onSubmit,
  isPending,
}: {
  onSubmit: (content: string) => void;
  isPending: boolean;
}) {
  const [commentText, setCommentText] = useState('');
  const submit = () => {
    const trimmed = commentText.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setCommentText('');
  };
  return (
    <div className="flex gap-3 pt-2 border-t border-border/60">
      <div className="flex-1 relative">
        <input
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="Write a comment..."
          className="w-full rounded-xl border border-border bg-secondary/50 px-4 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <button
          onClick={submit}
          disabled={!commentText.trim() || isPending}
          className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-primary transition-colors disabled:opacity-30"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// Owns its own edit/draft state so typing in the title doesn't re-render the sheet.
function TitleEditor({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState('');
  const save = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== title) onSave(trimmed);
    setIsEditing(false);
  };
  if (isEditing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setIsEditing(false);
        }}
        className="w-full font-display text-xl font-bold tracking-tight text-foreground bg-transparent border-b-2 border-primary pb-1 focus:outline-none"
      />
    );
  }
  return (
    <h2
      onClick={() => {
        setValue(title);
        setIsEditing(true);
      }}
      className="font-display text-xl font-bold tracking-tight text-foreground leading-snug cursor-text hover:text-primary transition-colors"
      title="Click to edit"
    >
      {title}
    </h2>
  );
}

// Owns its own edit/draft state so typing in the description doesn't re-render the sheet.
function DescriptionEditor({
  description,
  onSave,
}: {
  description: string | null;
  onSave: (description: string | null) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState('');
  const save = () => {
    const val = value.trim() || null;
    if (val !== (description ?? null)) onSave(val);
    setIsEditing(false);
  };
  if (isEditing) {
    return (
      <textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setIsEditing(false);
        }}
        rows={4}
        className="w-full rounded-xl border border-primary/30 bg-card px-4 py-3 text-sm text-foreground leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none"
        placeholder="Add a description..."
      />
    );
  }
  return (
    <div
      onClick={() => {
        setValue(description ?? '');
        setIsEditing(true);
      }}
      className={cn(
        'rounded-xl border border-transparent px-4 py-3 text-sm leading-relaxed cursor-text transition-colors hover:border-border hover:bg-secondary/30',
        description
          ? 'text-muted-foreground whitespace-pre-wrap'
          : 'text-muted-foreground/50 italic'
      )}
    >
      {description || 'Click to add a description...'}
    </div>
  );
}

export function TaskDetailSheet({
  taskId,
  boardId,
  onClose,
}: {
  taskId: string;
  boardId: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();

  const invalidateAll = () => {
    utils.projects.getTaskDetail.invalidate({ id: taskId });
    utils.projects.getBoardWithTasks.invalidate({ boardId });
  };

  const { data: task, isLoading } = trpc.projects.getTaskDetail.useQuery({ id: taskId });

  const updateTask = trpc.projects.updateTask.useMutation({ onSuccess: invalidateAll });

  // PROJ-04: task attachments — add (via the /api/upload pipeline) + delete.
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const addAttachment = trpc.projects.addTaskAttachment.useMutation({ onSuccess: invalidateAll });
  const deleteAttachment = trpc.projects.deleteTaskAttachment.useMutation({
    onSuccess: invalidateAll,
  });
  const handleAttachmentUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingAttachment(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('Upload failed');
      const data = (await res.json()) as {
        url: string;
        name: string;
        size?: number;
        type?: string;
      };
      addAttachment.mutate({
        taskId,
        name: data.name,
        url: data.url,
        type: data.type,
        size: data.size,
      });
    } catch {
      // best-effort; the mutation/upload errors surface no destructive state
    } finally {
      setUploadingAttachment(false);
    }
  };

  const deleteTask = trpc.projects.deleteTask.useMutation({
    onSuccess: () => {
      utils.projects.getBoardWithTasks.invalidate({ boardId });
      onClose();
    },
  });
  const addComment = trpc.projects.addComment.useMutation({
    onSuccess: () => {
      utils.projects.getTaskDetail.invalidate({ id: taskId });
    },
  });
  // IMP-PROJ-04: comment edit/delete.
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const isAdmin = session?.user?.role === 'ADMIN';
  const invalidateDetail = () => utils.projects.getTaskDetail.invalidate({ id: taskId });
  const updateComment = trpc.projects.updateComment.useMutation({ onSuccess: invalidateDetail });
  const deleteComment = trpc.projects.deleteComment.useMutation({ onSuccess: invalidateDetail });
  // Optimistic label add: append the label from the board-labels cache instantly.
  const addLabelToTask = trpc.projects.addLabelToTask.useMutation({
    onMutate: async ({ labelId }) => {
      await utils.projects.getTaskDetail.cancel({ id: taskId });
      const previous = utils.projects.getTaskDetail.getData({ id: taskId });
      utils.projects.getTaskDetail.setData({ id: taskId }, (old) => {
        if (!old) return old;
        if (old.labels.some((tl) => tl.label.id === labelId)) return old;
        const label = boardLabels?.find((l) => l.id === labelId);
        if (!label) return old;
        return {
          ...old,
          labels: [...old.labels, { id: `optimistic-${labelId}`, taskId, labelId, label }],
        };
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) utils.projects.getTaskDetail.setData({ id: taskId }, context.previous);
    },
    onSettled: invalidateAll,
  });
  // Optimistic label remove: drop the label instantly, reconcile on settle.
  const removeLabelFromTask = trpc.projects.removeLabelFromTask.useMutation({
    onMutate: async ({ labelId }) => {
      await utils.projects.getTaskDetail.cancel({ id: taskId });
      const previous = utils.projects.getTaskDetail.getData({ id: taskId });
      utils.projects.getTaskDetail.setData({ id: taskId }, (old) => {
        if (!old) return old;
        return { ...old, labels: old.labels.filter((tl) => tl.label.id !== labelId) };
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) utils.projects.getTaskDetail.setData({ id: taskId }, context.previous);
    },
    onSettled: invalidateAll,
  });
  const createLabel = trpc.projects.createLabel.useMutation({
    onSuccess: () => {
      invalidateAll();
      utils.projects.getBoardLabels.invalidate();
      setNewLabelName('');
      setShowNewLabelForm(false);
    },
  });

  // Optimistic assignee update: rebuild the assignee list instantly from cache + roster.
  const updateAssignees = trpc.projects.updateTaskAssignees.useMutation({
    onMutate: async ({ assigneeIds }) => {
      await utils.projects.getTaskDetail.cancel({ id: taskId });
      const previous = utils.projects.getTaskDetail.getData({ id: taskId });
      utils.projects.getTaskDetail.setData({ id: taskId }, (old) => {
        if (!old) return old;
        return {
          ...old,
          assignees: assigneeIds.flatMap((id) => {
            const existing = old.assignees.find((a) => a.user.id === id);
            if (existing) return [existing];
            const member = teamMembers?.find((m) => m.id === id);
            if (!member) return [];
            return [
              {
                id: `optimistic-${id}`,
                taskId,
                userId: id,
                user: {
                  id: member.id,
                  name: member.name,
                  avatar: member.avatar,
                  title: member.title,
                },
              },
            ];
          }),
        };
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) utils.projects.getTaskDetail.setData({ id: taskId }, context.previous);
    },
    onSettled: invalidateAll,
  });

  // Fetch board labels and team members when task is loaded
  const taskBoardId = task?.column?.board?.id;
  const { data: boardLabels } = trpc.projects.getBoardLabels.useQuery(
    { boardId: taskBoardId ?? '' },
    { enabled: !!taskBoardId }
  );
  const { data: teamMembers } = trpc.team.getRoster.useQuery();

  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [showPriorityMenu, setShowPriorityMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [showNewLabelForm, setShowNewLabelForm] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState('#123A38');

  const handlePriorityChange = (priority: 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW') => {
    updateTask.mutate({ id: taskId, priority });
    setShowPriorityMenu(false);
  };

  const handleDueDateChange = (dateStr: string) => {
    updateTask.mutate({ id: taskId, dueDate: dateStr ? new Date(dateStr) : null });
  };

  const currentPriority = priorities.find((p) => p.value === task?.priority) ?? priorities[2];

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Sheet */}
      <div
        className="fixed right-0 top-0 z-50 h-full w-full max-w-xl border-l border-border bg-background overflow-y-auto shadow-2xl"
        style={{ animation: 'slide-in-from-right 200ms cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-background/90 backdrop-blur-xl px-6 py-4">
          <div className="flex items-center gap-2 min-w-0">
            {task && (
              <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground shrink-0">
                {task.column.name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* Delete button */}
            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-500/10 hover:text-red-500 transition-colors"
                title="Delete task"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => deleteTask.mutate({ id: taskId })}
                  disabled={deleteTask.isPending}
                  className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 transition-colors disabled:opacity-50"
                >
                  {deleteTask.isPending ? 'Deleting...' : 'Delete'}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="p-6 space-y-6">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : task ? (
          <div className="p-6 space-y-6">
            {/* Title — click to edit */}
            <TitleEditor
              title={task.title}
              onSave={(title) => updateTask.mutate({ id: taskId, title })}
            />

            {/* Editable fields grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Priority picker */}
              <div className="relative">
                <label className="block text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                  Priority
                </label>
                <button
                  onClick={() => setShowPriorityMenu(!showPriorityMenu)}
                  className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm transition-colors hover:border-primary/30"
                >
                  <div className="flex items-center gap-2">
                    <Circle className={cn('h-3 w-3', currentPriority.color)} fill="currentColor" />
                    <span className="font-medium text-foreground">{currentPriority.label}</span>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
                {showPriorityMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setShowPriorityMenu(false)}
                    />
                    <div className="absolute top-full left-0 z-20 mt-1 w-full rounded-xl border border-border bg-card py-1 shadow-xl shadow-black/10">
                      {priorities.map((p) => (
                        <button
                          key={p.value}
                          onClick={() => handlePriorityChange(p.value)}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-secondary',
                            task.priority === p.value && 'bg-secondary'
                          )}
                        >
                          <Circle className={cn('h-3 w-3', p.color)} fill="currentColor" />
                          <span className="font-medium text-foreground">{p.label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Due date picker */}
              <div>
                <label className="block text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                  Due Date
                </label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    type="date"
                    value={task.dueDate ? format(new Date(task.dueDate), 'yyyy-MM-dd') : ''}
                    onChange={(e) => handleDueDateChange(e.target.value)}
                    className={cn(
                      'w-full rounded-xl border border-border bg-card pl-9 pr-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/30 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
                      task.dueDate &&
                        new Date(task.dueDate) < new Date() &&
                        'text-red-500 border-red-500/30'
                    )}
                  />
                </div>
              </div>
            </div>

            {/* Labels */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Tag className="h-3 w-3" /> Labels
                </h4>
                <button
                  onClick={() => setShowLabelPicker(!showLabelPicker)}
                  className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  {showLabelPicker ? 'Close' : 'Add'}
                </button>
              </div>

              {/* Current labels — click X to remove */}
              {task.labels.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {task.labels.map((tl) => (
                    <div
                      key={tl.label.id}
                      className="group/label flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition-colors"
                      style={{ backgroundColor: `${tl.label.color}15` }}
                    >
                      <div
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: tl.label.color }}
                      />
                      <span className="text-xs font-medium" style={{ color: tl.label.color }}>
                        {tl.label.name}
                      </span>
                      <button
                        onClick={() => removeLabelFromTask.mutate({ taskId, labelId: tl.label.id })}
                        className="ml-0.5 opacity-0 group-hover/label:opacity-100 transition-opacity"
                      >
                        <X className="h-3 w-3" style={{ color: tl.label.color }} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Label picker dropdown */}
              {showLabelPicker && (
                <div className="rounded-xl border border-border bg-card p-3 space-y-2">
                  {/* Existing board labels */}
                  {boardLabels && boardLabels.length > 0 && (
                    <div className="space-y-1">
                      {boardLabels.map((label) => {
                        const isApplied = task.labels.some((tl) => tl.label.id === label.id);
                        return (
                          <button
                            key={label.id}
                            onClick={() => {
                              if (isApplied) {
                                removeLabelFromTask.mutate({ taskId, labelId: label.id });
                              } else {
                                addLabelToTask.mutate({ taskId, labelId: label.id });
                              }
                            }}
                            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-secondary"
                          >
                            <div
                              className="h-3 w-3 rounded-full shrink-0"
                              style={{ backgroundColor: label.color }}
                            />
                            <span className="flex-1 text-left text-foreground font-medium">
                              {label.name}
                            </span>
                            {isApplied && <Check className="h-4 w-4 text-primary shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Divider */}
                  {boardLabels && boardLabels.length > 0 && (
                    <div className="border-t border-border/60" />
                  )}

                  {/* Create new label */}
                  {showNewLabelForm ? (
                    <div className="space-y-2">
                      <input
                        autoFocus
                        value={newLabelName}
                        onChange={(e) => setNewLabelName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newLabelName.trim() && boardId) {
                            createLabel.mutate({
                              boardId,
                              name: newLabelName.trim(),
                              color: newLabelColor,
                            });
                          }
                          if (e.key === 'Escape') {
                            setShowNewLabelForm(false);
                            setNewLabelName('');
                          }
                        }}
                        placeholder="Label name..."
                        className="w-full rounded-lg border border-border bg-secondary/50 px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                      />
                      <div className="flex flex-wrap gap-1.5">
                        {[
                          '#EF4444',
                          '#123A38',
                          '#F59E0B',
                          '#16A34A',
                          '#2563EB',
                          '#7C3AED',
                          '#DB2777',
                          '#0EA5E9',
                          '#6E7280',
                        ].map((c) => (
                          <button
                            key={c}
                            onClick={() => setNewLabelColor(c)}
                            className={cn(
                              'h-6 w-6 rounded-full transition-all',
                              newLabelColor === c
                                ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card scale-110'
                                : 'hover:scale-110'
                            )}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            if (newLabelName.trim() && boardId) {
                              createLabel.mutate({
                                boardId,
                                name: newLabelName.trim(),
                                color: newLabelColor,
                              });
                            }
                          }}
                          disabled={!newLabelName.trim() || createLabel.isPending}
                          className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
                        >
                          Create
                        </button>
                        <button
                          onClick={() => {
                            setShowNewLabelForm(false);
                            setNewLabelName('');
                          }}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowNewLabelForm(true)}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create new label
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Description — click to edit */}
            <div>
              <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Description
              </h4>
              <DescriptionEditor
                description={task.description}
                onSave={(description) => updateTask.mutate({ id: taskId, description })}
              />
            </div>

            {/* Assignees */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Users className="h-3 w-3" /> Assignees
                </h4>
                <button
                  onClick={() => setShowAssigneePicker(!showAssigneePicker)}
                  className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  {showAssigneePicker ? 'Close' : 'Edit'}
                </button>
              </div>

              {/* Current assignees */}
              {task.assignees.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {task.assignees.map((a) => (
                    <div
                      key={a.user.id}
                      className="group/assignee flex items-center gap-2 rounded-lg bg-secondary px-3 py-2"
                    >
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={a.user.avatar ?? undefined} />
                        <AvatarFallback className="text-[9px] bg-muted font-medium">
                          {a.user.name[0]}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-xs font-medium text-foreground">{a.user.name}</span>
                      <button
                        onClick={() => {
                          const newIds = task.assignees
                            .filter((t) => t.user.id !== a.user.id)
                            .map((t) => t.user.id);
                          updateAssignees.mutate({ taskId, assigneeIds: newIds });
                        }}
                        className="ml-0.5 opacity-0 group-hover/assignee:opacity-100 transition-opacity text-muted-foreground hover:text-red-500"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {task.assignees.length === 0 && !showAssigneePicker && (
                <button
                  onClick={() => setShowAssigneePicker(true)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Click to assign team members...
                </button>
              )}

              {/* Assignee picker */}
              {showAssigneePicker && teamMembers && (
                <div className="rounded-xl border border-border bg-card p-3 space-y-1">
                  {teamMembers.map((member) => {
                    const isAssigned = task.assignees.some((a) => a.user.id === member.id);
                    return (
                      <button
                        key={member.id}
                        onClick={() => {
                          const currentIds = task.assignees.map((a) => a.user.id);
                          const newIds = isAssigned
                            ? currentIds.filter((id) => id !== member.id)
                            : [...currentIds, member.id];
                          updateAssignees.mutate({ taskId, assigneeIds: newIds });
                        }}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-secondary"
                      >
                        <Avatar className="h-6 w-6">
                          <AvatarImage src={member.avatar ?? undefined} />
                          <AvatarFallback className="text-[9px] bg-muted font-medium">
                            {member.name[0]}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 text-left">
                          <span className="text-xs font-medium text-foreground">{member.name}</span>
                          <span className="text-[10px] text-muted-foreground ml-1.5">
                            {member.title}
                          </span>
                        </div>
                        {isAssigned && <Check className="h-4 w-4 text-primary shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Attachments (PROJ-04) */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Paperclip className="h-3 w-3" /> Attachments
                </h4>
                <label className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                  {uploadingAttachment ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  {uploadingAttachment ? 'Uploading…' : 'Add'}
                  <input
                    type="file"
                    className="hidden"
                    onChange={handleAttachmentUpload}
                    disabled={uploadingAttachment}
                  />
                </label>
              </div>
              {task.attachments.length > 0 ? (
                <div className="space-y-1.5">
                  {task.attachments.map((att) => (
                    <div
                      key={att.id}
                      className="group/att flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2"
                    >
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <a
                        href={att.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 truncate text-xs font-medium text-foreground hover:text-primary hover:underline"
                        title={att.name}
                      >
                        {att.name}
                      </a>
                      {typeof att.size === 'number' && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {(att.size / 1024).toFixed(0)} KB
                        </span>
                      )}
                      <a
                        href={att.url}
                        download={att.name}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        title="Download"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </a>
                      <button
                        onClick={() => deleteAttachment.mutate({ id: att.id })}
                        className="shrink-0 opacity-0 group-hover/att:opacity-100 transition-opacity text-muted-foreground hover:text-red-500"
                        title="Remove attachment"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No attachments yet.</p>
              )}
            </div>

            {/* Checklists (IMP-PROJ-02: full management) */}
            <ChecklistSection
              taskId={taskId}
              checklists={task.checklists}
              onMutated={() => utils.projects.getTaskDetail.invalidate({ id: taskId })}
            />

            {/* Activity timeline (PROJ-10) */}
            <TaskActivityTimeline taskId={taskId} />

            {/* Comments */}
            <div>
              <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <MessageSquare className="h-3 w-3" /> Comments ({task.comments.length})
              </h4>

              <div className="space-y-4">
                <CommentList
                  comments={task.comments}
                  currentUserId={currentUserId}
                  isAdmin={isAdmin}
                  onEdit={(id, content) => updateComment.mutate({ id, content })}
                  onDelete={(id) => deleteComment.mutate({ id })}
                />

                {/* Add comment */}
                <CommentComposer
                  onSubmit={(content) => addComment.mutate({ taskId, content })}
                  isPending={addComment.isPending}
                />
              </div>
            </div>

            {/* Created by */}
            <div className="pt-4 border-t border-border/60">
              <p className="text-[11px] text-muted-foreground/50">
                Created by {task.createdBy.name} &middot;{' '}
                {format(new Date(task.createdAt), 'MMM d, yyyy')}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
