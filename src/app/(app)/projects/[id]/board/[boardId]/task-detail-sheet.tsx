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
  Timer,
  ListTree,
  Link2,
  Ban,
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

// IMP-PROJ-06: mirrors the server's done-column heuristic (projects.moveTask) so
// completed subtasks / satisfied blockers can be shown as done.
const DONE_COLUMN_RE = /^(done|complete|completed|shipped|closed)$/i;

// A lightweight {id,title} candidate for the subtask/blocker pickers.
type PickerTask = { id: string; title: string };

const priorities = [
  { value: 'URGENT', label: 'Urgent', color: 'text-red-500', bg: 'bg-red-500' },
  { value: 'HIGH', label: 'High', color: 'text-primary', bg: 'bg-primary' },
  { value: 'MEDIUM', label: 'Medium', color: 'text-amber-500', bg: 'bg-amber-500' },
  { value: 'LOW', label: 'Low', color: 'text-muted-foreground', bg: 'bg-muted-foreground/40' },
] as const;

// Shared label palette — used by both the create-label form and the inline
// edit (recolor) affordance in the picker (IMP-PROJ-05).
const LABEL_COLORS = [
  '#EF4444',
  '#123A38',
  '#F59E0B',
  '#16A34A',
  '#2563EB',
  '#7C3AED',
  '#DB2777',
  '#0EA5E9',
  '#6E7280',
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
          className={cn(
            'h-full rounded-full transition-all',
            pct === 100 ? 'bg-emerald-500' : 'bg-primary'
          )}
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

// IMP-PROJ-05: a board label in the picker, with inline rename/recolor + delete.
// Toggling applies/removes it from the task; the edit + delete affordances call
// updateLabel/deleteLabel (server enforces manage access).
type BoardLabel = { id: string; name: string; color: string };

function LabelRow({
  label,
  isApplied,
  onToggle,
  onRename,
  onDelete,
  isBusy,
}: {
  label: BoardLabel;
  isApplied: boolean;
  onToggle: () => void;
  onRename: (name: string, color: string) => void;
  onDelete: () => void;
  isBusy: boolean;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirmDelete'>('view');
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);

  if (mode === 'edit') {
    const save = () => {
      const trimmed = name.trim();
      if (trimmed) onRename(trimmed, color);
      setMode('view');
    };
    return (
      <div className="space-y-2 rounded-lg border border-primary/20 bg-secondary/30 p-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setMode('view');
          }}
          placeholder="Label name..."
          className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
        />
        <div className="flex flex-wrap gap-1.5">
          {LABEL_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={cn(
                'h-5 w-5 rounded-full transition-all',
                color === c
                  ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card scale-110'
                  : 'hover:scale-110'
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={!name.trim() || isBusy}
            className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
          >
            Save
          </button>
          <button
            onClick={() => {
              setName(label.name);
              setColor(label.color);
              setMode('view');
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/lbl flex items-center gap-1 rounded-lg transition-colors hover:bg-secondary">
      <button
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm"
      >
        <div className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
        <span className="flex-1 truncate text-left font-medium text-foreground">{label.name}</span>
        {isApplied && <Check className="h-4 w-4 shrink-0 text-primary" />}
      </button>
      {mode === 'confirmDelete' ? (
        <div className="flex shrink-0 items-center gap-1 pr-1.5">
          <button
            onClick={() => {
              onDelete();
              setMode('view');
            }}
            disabled={isBusy}
            className="rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600 disabled:opacity-50"
            title="Permanently delete this label and remove it from every task"
          >
            Delete
          </button>
          <button
            onClick={() => setMode('view')}
            className="px-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            No
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5 pr-1.5 opacity-0 transition-opacity group-hover/lbl:opacity-100">
          <button
            onClick={() => {
              setName(label.name);
              setColor(label.color);
              setMode('edit');
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground"
            title="Rename / recolor label"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={() => setMode('confirmDelete')}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
            title="Delete label"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

// IMP-PROJ-06: a search-and-pick panel over the board's tasks, shared by the
// subtask and blocker "add" affordances.
function TaskSelectPanel({
  candidates,
  onPick,
  onClose,
  placeholder,
}: {
  candidates: PickerTask[];
  onPick: (taskId: string) => void;
  onClose: () => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const filtered = candidates.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="rounded-xl border border-border bg-card p-2 space-y-2">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder ?? 'Search tasks…'}
          className="flex-1 rounded-lg border border-border bg-secondary/50 px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Close picker"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            No matching tasks.
          </p>
        ) : (
          filtered.map((t) => (
            <button
              key={t.id}
              onClick={() => onPick(t.id)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary"
            >
              <span className="truncate">{t.title}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// IMP-PROJ-06: subtasks — link an existing board task (or create-and-link a new
// one) as a child, surface the parent relationship, and unlink children.
function SubtasksSection({
  task,
  boardTasks,
  onMutated,
}: {
  task: TaskDetailData;
  boardTasks: PickerTask[];
  onMutated: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const setParent = trpc.projects.setTaskParent.useMutation({
    onSuccess: () => {
      setError(null);
      onMutated();
    },
    onError: (e) => setError(e.message),
  });
  const createTask = trpc.projects.createTask.useMutation();

  // Candidates: any board task that isn't this task or already one of its subtasks.
  const subtaskIds = new Set(task.subtasks.map((s) => s.id));
  const candidates = boardTasks.filter((t) => t.id !== task.id && !subtaskIds.has(t.id));

  // Bonus: create a fresh task in this task's column and link it as a subtask.
  const handleCreateLink = async () => {
    const title = newTitle.trim();
    if (!title) return;
    try {
      const created = await createTask.mutateAsync({ title, columnId: task.column.id });
      await setParent.mutateAsync({ taskId: created.id, parentId: task.id });
      setNewTitle('');
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create subtask.');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <ListTree className="h-3 w-3" /> Subtasks
          {task.subtasks.length > 0 ? ` (${task.subtasks.length})` : ''}
        </h4>
        <button
          onClick={() => {
            setPicking((p) => !p);
            setError(null);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <Plus className="h-3 w-3" />
          {picking ? 'Close' : 'Add'}
        </button>
      </div>

      {/* This task is itself a subtask of another — show + allow detach. */}
      {task.parent && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-secondary/40 px-3 py-1.5 text-xs">
          <ListTree className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">Subtask of</span>
          <span className="flex-1 truncate font-medium text-foreground">{task.parent.title}</span>
          <button
            onClick={() => setParent.mutate({ taskId: task.id, parentId: null })}
            className="shrink-0 text-muted-foreground hover:text-red-500"
            title="Detach from parent"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Child subtasks */}
      {task.subtasks.length > 0 && (
        <div className="space-y-1 mb-2">
          {task.subtasks.map((s) => {
            const done = DONE_COLUMN_RE.test(s.column.name);
            return (
              <div
                key={s.id}
                className="group/sub flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-1.5"
              >
                {done ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                ) : (
                  <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                )}
                <span
                  className={cn(
                    'flex-1 truncate text-sm',
                    done ? 'text-muted-foreground line-through' : 'text-foreground'
                  )}
                >
                  {s.title}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{s.column.name}</span>
                <button
                  onClick={() => setParent.mutate({ taskId: s.id, parentId: null })}
                  className="shrink-0 opacity-0 transition-opacity group-hover/sub:opacity-100 text-muted-foreground hover:text-red-500"
                  title="Unlink subtask"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="mb-2 text-[11px] font-medium text-red-500">{error}</p>}

      {picking && (
        <div className="space-y-2">
          <TaskSelectPanel
            candidates={candidates}
            onPick={(pickedId) => {
              setParent.mutate({ taskId: pickedId, parentId: task.id });
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
            placeholder="Link an existing task…"
          />
          <div className="flex items-center gap-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateLink();
              }}
              placeholder="Or create a new subtask…"
              className="flex-1 rounded-lg border border-border bg-secondary/50 px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <button
              onClick={handleCreateLink}
              disabled={!newTitle.trim() || createTask.isPending || setParent.isPending}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-primary disabled:opacity-30"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// IMP-PROJ-06: task dependencies — "Blocked by" + "Blocking" edges, add a blocker
// by picking another board task, remove edges. Cycle/duplicate rejections from
// the server surface inline.
function DependenciesSection({
  task,
  boardTasks,
  onMutated,
}: {
  task: TaskDetailData;
  boardTasks: PickerTask[];
  onMutated: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const addBlocker = trpc.projects.addBlocker.useMutation({
    onSuccess: () => {
      setError(null);
      setPicking(false);
      onMutated();
    },
    onError: (e) => setError(e.message),
  });
  const removeBlocker = trpc.projects.removeBlocker.useMutation({ onSuccess: onMutated });

  // Candidates: any board task that isn't this task or already blocking it.
  const blockerIds = new Set(task.blockedBy.map((b) => b.blockingTask.id));
  const candidates = boardTasks.filter((t) => t.id !== task.id && !blockerIds.has(t.id));

  const openBlockerCount = task.blockedBy.filter(
    (b) => !DONE_COLUMN_RE.test(b.blockingTask.column.name)
  ).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Link2 className="h-3 w-3" /> Dependencies
        </h4>
        <button
          onClick={() => {
            setPicking((p) => !p);
            setError(null);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <Plus className="h-3 w-3" />
          {picking ? 'Close' : 'Add blocker'}
        </button>
      </div>

      {openBlockerCount > 0 && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs">
          <Ban className="h-3.5 w-3.5 shrink-0 text-red-500" />
          <span className="font-medium text-red-500">
            Blocked by {openBlockerCount} unfinished task{openBlockerCount === 1 ? '' : 's'}.
          </span>
        </div>
      )}

      {picking && (
        <div className="mb-2">
          <TaskSelectPanel
            candidates={candidates}
            onPick={(pickedId) =>
              addBlocker.mutate({ blockedTaskId: task.id, blockingTaskId: pickedId })
            }
            onClose={() => setPicking(false)}
            placeholder="Blocked by which task?"
          />
        </div>
      )}

      {error && <p className="mb-2 text-[11px] font-medium text-red-500">{error}</p>}

      <div className="space-y-3">
        {/* Blocked by */}
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Blocked by
          </p>
          {task.blockedBy.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">Nothing is blocking this task.</p>
          ) : (
            <div className="space-y-1">
              {task.blockedBy.map((edge) => {
                const done = DONE_COLUMN_RE.test(edge.blockingTask.column.name);
                return (
                  <div
                    key={edge.id}
                    className="group/dep flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-1.5"
                  >
                    {done ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <Ban className="h-3.5 w-3.5 shrink-0 text-red-500" />
                    )}
                    <span
                      className={cn(
                        'flex-1 truncate text-sm',
                        done ? 'text-muted-foreground line-through' : 'text-foreground'
                      )}
                    >
                      {edge.blockingTask.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {edge.blockingTask.column.name}
                    </span>
                    <button
                      onClick={() => removeBlocker.mutate({ id: edge.id })}
                      className="shrink-0 opacity-0 transition-opacity group-hover/dep:opacity-100 text-muted-foreground hover:text-red-500"
                      title="Remove dependency"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Blocking */}
        {task.blocking.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Blocking
            </p>
            <div className="space-y-1">
              {task.blocking.map((edge) => (
                <div
                  key={edge.id}
                  className="group/dep flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-1.5"
                >
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-sm text-foreground">
                    {edge.blockedTask.title}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {edge.blockedTask.column.name}
                  </span>
                  <button
                    onClick={() => removeBlocker.mutate({ id: edge.id })}
                    className="shrink-0 opacity-0 transition-opacity group-hover/dep:opacity-100 text-muted-foreground hover:text-red-500"
                    title="Remove dependency"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// IMP-PROJ-01: time tracking — log hours against the task, see who logged what,
// owner/admin can edit or delete their entries. Hours are Decimal(5,2) on the
// server (validated there); we convert with Number() for display + the total.
type TimeEntryData = inferRouterOutputs<AppRouter>['projects']['listTaskTime'][number];

function TimeEntryRow({
  entry,
  canModify,
  onUpdate,
  onDelete,
  isBusy,
}: {
  entry: TimeEntryData;
  canModify: boolean;
  onUpdate: (data: { hours: number; description: string | null; date: Date }) => void;
  onDelete: () => void;
  isBusy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [hours, setHours] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');

  const beginEdit = () => {
    setHours(String(Number(entry.hours)));
    setDescription(entry.description ?? '');
    setDate(format(new Date(entry.date), 'yyyy-MM-dd'));
    setEditing(true);
  };
  const save = () => {
    const h = Number(hours);
    if (!hours || Number.isNaN(h) || h <= 0) return;
    onUpdate({ hours: h, description: description.trim() || null, date: new Date(date) });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="space-y-2 rounded-lg border border-primary/20 bg-secondary/30 p-2">
        <div className="flex items-center gap-2">
          <input
            type="number"
            step="0.25"
            min="0"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="w-20 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
          />
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
          />
        </div>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
          placeholder="Description (optional)"
          className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={!hours || isBusy}
            className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
          >
            Save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/te flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-1.5">
      <Avatar className="h-5 w-5 shrink-0">
        <AvatarImage src={entry.user.avatar ?? undefined} />
        <AvatarFallback className="text-[8px] bg-muted font-medium">
          {entry.user.name[0]}
        </AvatarFallback>
      </Avatar>
      <span className="shrink-0 text-xs font-medium text-foreground">{entry.user.name}</span>
      <span className="shrink-0 text-xs font-semibold text-primary">{Number(entry.hours)}h</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {format(new Date(entry.date), 'MMM d')}
      </span>
      {entry.description && (
        <span
          className="flex-1 truncate text-[11px] text-muted-foreground"
          title={entry.description}
        >
          {entry.description}
        </span>
      )}
      {canModify && (
        <div className="ml-auto flex shrink-0 gap-0.5 opacity-0 group-hover/te:opacity-100 transition-opacity">
          <button
            onClick={beginEdit}
            className="text-muted-foreground/60 hover:text-foreground"
            title="Edit time entry"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={onDelete}
            disabled={isBusy}
            className="text-muted-foreground/60 hover:text-red-500 disabled:opacity-40"
            title="Delete time entry"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function TimeSection({
  taskId,
  projectId,
  currentUserId,
  isAdmin,
  onMutated,
}: {
  taskId: string;
  projectId: string;
  currentUserId?: string;
  isAdmin?: boolean;
  onMutated: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: entries } = trpc.projects.listTaskTime.useQuery({ taskId });

  const [hours, setHours] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    utils.projects.listTaskTime.invalidate({ taskId });
    onMutated();
  };
  const logTime = trpc.projects.logTime.useMutation({
    onSuccess: () => {
      setHours('');
      setDescription('');
      setError(null);
      invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const updateEntry = trpc.projects.updateTimeEntry.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });
  const deleteEntry = trpc.projects.deleteTimeEntry.useMutation({ onSuccess: invalidate });

  const total = useMemo(
    () => (entries ?? []).reduce((sum, e) => sum + Number(e.hours), 0),
    [entries]
  );
  const totalDisplay = Math.round(total * 100) / 100;

  const submit = () => {
    const h = Number(hours);
    if (!hours || Number.isNaN(h) || h <= 0) {
      setError('Enter a positive number of hours.');
      return;
    }
    logTime.mutate({
      taskId,
      projectId,
      hours: h,
      description: description.trim() || undefined,
      date: new Date(date),
    });
  };

  return (
    <div>
      <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <Timer className="h-3 w-3" /> Time
        {totalDisplay > 0 && (
          <span className="ml-1 font-semibold normal-case tracking-normal text-foreground/80">
            · {totalDisplay}h logged
          </span>
        )}
      </h4>

      {entries && entries.length > 0 ? (
        <div className="space-y-1 mb-3">
          {entries.map((entry) => (
            <TimeEntryRow
              key={entry.id}
              entry={entry}
              canModify={entry.user.id === currentUserId || !!isAdmin}
              onUpdate={(data) => updateEntry.mutate({ id: entry.id, ...data })}
              onDelete={() => deleteEntry.mutate({ id: entry.id })}
              isBusy={updateEntry.isPending || deleteEntry.isPending}
            />
          ))}
        </div>
      ) : (
        <p className="mb-3 text-xs text-muted-foreground">No time logged yet.</p>
      )}

      {error && <p className="mb-2 text-[11px] font-medium text-red-500">{error}</p>}

      {/* Compact log-time form */}
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="0.25"
          min="0"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="Hrs"
          className="w-16 rounded-lg border border-border bg-secondary/50 px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-border bg-secondary/50 px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="What did you work on? (optional)"
          className="flex-1 rounded-lg border border-border bg-secondary/50 px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        <button
          onClick={submit}
          disabled={!hours || logTime.isPending}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-primary disabled:opacity-30"
          title="Log time"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
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
          labels: [
            ...old.labels,
            {
              id: `optimistic-${labelId}`,
              organizationId: old.organizationId,
              taskId,
              labelId,
              label,
            },
          ],
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
  // IMP-PROJ-05: rename/recolor + delete a board label from the picker.
  const labelMutated = () => {
    invalidateAll();
    utils.projects.getBoardLabels.invalidate();
  };
  const updateLabel = trpc.projects.updateLabel.useMutation({ onSuccess: labelMutated });
  const deleteLabel = trpc.projects.deleteLabel.useMutation({ onSuccess: labelMutated });

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
                organizationId: old.organizationId,
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

  // IMP-PROJ-06: the board's tasks power the subtask/blocker pickers. Shares the
  // same query key as the kanban board, so this is normally a cache hit.
  const { data: boardForPickers } = trpc.projects.getBoardWithTasks.useQuery(
    { boardId },
    { enabled: !!boardId }
  );
  const boardTasks = useMemo<PickerTask[]>(() => {
    if (!boardForPickers) return [];
    return boardForPickers.columns.flatMap((c) =>
      c.tasks.map((t) => ({ id: t.id, title: t.title }))
    );
  }, [boardForPickers]);

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
                          <LabelRow
                            key={label.id}
                            label={label}
                            isApplied={isApplied}
                            onToggle={() => {
                              if (isApplied) {
                                removeLabelFromTask.mutate({ taskId, labelId: label.id });
                              } else {
                                addLabelToTask.mutate({ taskId, labelId: label.id });
                              }
                            }}
                            onRename={(name, color) =>
                              updateLabel.mutate({ id: label.id, name, color })
                            }
                            onDelete={() => deleteLabel.mutate({ id: label.id })}
                            isBusy={updateLabel.isPending || deleteLabel.isPending}
                          />
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
                        {LABEL_COLORS.map((c) => (
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
                          className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
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

            {/* Time tracking (IMP-PROJ-01) */}
            <TimeSection
              taskId={taskId}
              projectId={task.column.board.projectId}
              currentUserId={currentUserId}
              isAdmin={isAdmin}
              onMutated={invalidateAll}
            />

            {/* Subtasks (IMP-PROJ-06) */}
            <SubtasksSection task={task} boardTasks={boardTasks} onMutated={invalidateAll} />

            {/* Dependencies (IMP-PROJ-06) */}
            <DependenciesSection task={task} boardTasks={boardTasks} onMutated={invalidateAll} />

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
