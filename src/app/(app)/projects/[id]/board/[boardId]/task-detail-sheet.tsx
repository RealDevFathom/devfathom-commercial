'use client';

import { useState } from 'react';
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
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';

const priorities = [
  { value: 'URGENT', label: 'Urgent', color: 'text-red-500', bg: 'bg-red-500' },
  { value: 'HIGH', label: 'High', color: 'text-[#FF4C29]', bg: 'bg-[#FF4C29]' },
  { value: 'MEDIUM', label: 'Medium', color: 'text-amber-500', bg: 'bg-amber-500' },
  { value: 'LOW', label: 'Low', color: 'text-muted-foreground', bg: 'bg-muted-foreground/40' },
] as const;

export function TaskDetailSheet({
  taskId,
  onClose,
}: {
  taskId: string;
  boardId: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();

  const invalidateAll = () => {
    utils.projects.getTaskDetail.invalidate({ id: taskId });
    utils.projects.getBoardWithTasks.invalidate();
  };

  const { data: task, isLoading } = trpc.projects.getTaskDetail.useQuery({ id: taskId });

  const updateTask = trpc.projects.updateTask.useMutation({ onSuccess: invalidateAll });
  const deleteTask = trpc.projects.deleteTask.useMutation({
    onSuccess: () => {
      utils.projects.getBoardWithTasks.invalidate();
      onClose();
    },
  });
  const addComment = trpc.projects.addComment.useMutation({
    onSuccess: () => {
      utils.projects.getTaskDetail.invalidate({ id: taskId });
      setCommentText('');
    },
  });
  const toggleItem = trpc.projects.toggleChecklistItem.useMutation({ onSuccess: invalidateAll });
  const addLabelToTask = trpc.projects.addLabelToTask.useMutation({ onSuccess: invalidateAll });
  const removeLabelFromTask = trpc.projects.removeLabelFromTask.useMutation({ onSuccess: invalidateAll });
  const createLabel = trpc.projects.createLabel.useMutation({
    onSuccess: () => {
      invalidateAll();
      utils.projects.getBoardLabels.invalidate();
      setNewLabelName('');
      setShowNewLabelForm(false);
    },
  });

  const updateAssignees = trpc.projects.updateTaskAssignees.useMutation({ onSuccess: invalidateAll });

  // Fetch board labels and team members when task is loaded
  const boardId = task?.column?.board?.id;
  const { data: boardLabels } = trpc.projects.getBoardLabels.useQuery(
    { boardId: boardId ?? '' },
    { enabled: !!boardId }
  );
  const { data: teamMembers } = trpc.team.getAll.useQuery();

  const [commentText, setCommentText] = useState('');
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [editDesc, setEditDesc] = useState('');
  const [showPriorityMenu, setShowPriorityMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [showNewLabelForm, setShowNewLabelForm] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState('#FF4C29');

  const handleTitleSave = () => {
    if (editTitle.trim() && editTitle.trim() !== task?.title) {
      updateTask.mutate({ id: taskId, title: editTitle.trim() });
    }
    setIsEditingTitle(false);
  };

  const handleDescSave = () => {
    const val = editDesc.trim() || null;
    if (val !== (task?.description ?? null)) {
      updateTask.mutate({ id: taskId, description: val });
    }
    setIsEditingDesc(false);
  };

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
      <div className="fixed right-0 top-0 z-50 h-full w-full max-w-xl border-l border-border bg-background overflow-y-auto shadow-2xl" style={{ animation: 'slide-in-from-right 200ms cubic-bezier(0.16, 1, 0.3, 1)' }}>
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
            <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors">
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
            {isEditingTitle ? (
              <input
                autoFocus
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => { if (e.key === 'Enter') handleTitleSave(); if (e.key === 'Escape') setIsEditingTitle(false); }}
                className="w-full font-display text-xl font-bold tracking-tight text-foreground bg-transparent border-b-2 border-[#FF4C29] pb-1 focus:outline-none"
              />
            ) : (
              <h2
                onClick={() => { setEditTitle(task.title); setIsEditingTitle(true); }}
                className="font-display text-xl font-bold tracking-tight text-foreground leading-snug cursor-text hover:text-[#FF4C29] transition-colors"
                title="Click to edit"
              >
                {task.title}
              </h2>
            )}

            {/* Editable fields grid */}
            <div className="grid grid-cols-2 gap-3">
              {/* Priority picker */}
              <div className="relative">
                <label className="block text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Priority</label>
                <button
                  onClick={() => setShowPriorityMenu(!showPriorityMenu)}
                  className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm transition-colors hover:border-[#FF4C29]/30"
                >
                  <div className="flex items-center gap-2">
                    <Circle className={cn('h-3 w-3', currentPriority.color)} fill="currentColor" />
                    <span className="font-medium text-foreground">{currentPriority.label}</span>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
                {showPriorityMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowPriorityMenu(false)} />
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
                <label className="block text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Due Date</label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    type="date"
                    value={task.dueDate ? format(new Date(task.dueDate), 'yyyy-MM-dd') : ''}
                    onChange={(e) => handleDueDateChange(e.target.value)}
                    className={cn(
                      'w-full rounded-xl border border-border bg-card pl-9 pr-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-[#FF4C29]/30 focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20',
                      task.dueDate && new Date(task.dueDate) < new Date() && 'text-red-500 border-red-500/30'
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
                      <div className="h-2 w-2 rounded-full" style={{ backgroundColor: tl.label.color }} />
                      <span className="text-xs font-medium" style={{ color: tl.label.color }}>{tl.label.name}</span>
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
                            <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
                            <span className="flex-1 text-left text-foreground font-medium">{label.name}</span>
                            {isApplied && <Check className="h-4 w-4 text-[#FF4C29] shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Divider */}
                  {boardLabels && boardLabels.length > 0 && <div className="border-t border-border/60" />}

                  {/* Create new label */}
                  {showNewLabelForm ? (
                    <div className="space-y-2">
                      <input
                        autoFocus
                        value={newLabelName}
                        onChange={(e) => setNewLabelName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newLabelName.trim() && boardId) {
                            createLabel.mutate({ boardId, name: newLabelName.trim(), color: newLabelColor });
                          }
                          if (e.key === 'Escape') { setShowNewLabelForm(false); setNewLabelName(''); }
                        }}
                        placeholder="Label name..."
                        className="w-full rounded-lg border border-border bg-secondary/50 px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#FF4C29] focus:outline-none"
                      />
                      <div className="flex flex-wrap gap-1.5">
                        {['#EF4444', '#FF4C29', '#F59E0B', '#16A34A', '#2563EB', '#7C3AED', '#DB2777', '#0EA5E9', '#6E7280'].map((c) => (
                          <button
                            key={c}
                            onClick={() => setNewLabelColor(c)}
                            className={cn(
                              'h-6 w-6 rounded-full transition-all',
                              newLabelColor === c ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card scale-110' : 'hover:scale-110'
                            )}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            if (newLabelName.trim() && boardId) {
                              createLabel.mutate({ boardId, name: newLabelName.trim(), color: newLabelColor });
                            }
                          }}
                          disabled={!newLabelName.trim() || createLabel.isPending}
                          className="rounded-lg bg-[#FF4C29] px-3 py-1 text-xs font-semibold text-white hover:bg-[#E63E1C] disabled:opacity-40 transition-colors"
                        >
                          Create
                        </button>
                        <button
                          onClick={() => { setShowNewLabelForm(false); setNewLabelName(''); }}
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
              <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Description</h4>
              {isEditingDesc ? (
                <textarea
                  autoFocus
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  onBlur={handleDescSave}
                  onKeyDown={(e) => { if (e.key === 'Escape') setIsEditingDesc(false); }}
                  rows={4}
                  className="w-full rounded-xl border border-[#FF4C29]/30 bg-card px-4 py-3 text-sm text-foreground leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20 resize-none"
                  placeholder="Add a description..."
                />
              ) : (
                <div
                  onClick={() => { setEditDesc(task.description ?? ''); setIsEditingDesc(true); }}
                  className={cn(
                    'rounded-xl border border-transparent px-4 py-3 text-sm leading-relaxed cursor-text transition-colors hover:border-border hover:bg-secondary/30',
                    task.description ? 'text-muted-foreground whitespace-pre-wrap' : 'text-muted-foreground/50 italic'
                  )}
                >
                  {task.description || 'Click to add a description...'}
                </div>
              )}
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
                    <div key={a.user.id} className="group/assignee flex items-center gap-2 rounded-lg bg-secondary px-3 py-2">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={a.user.avatar ?? undefined} />
                        <AvatarFallback className="text-[9px] bg-muted font-medium">{a.user.name[0]}</AvatarFallback>
                      </Avatar>
                      <span className="text-xs font-medium text-foreground">{a.user.name}</span>
                      <button
                        onClick={() => {
                          const newIds = task.assignees.filter((t) => t.user.id !== a.user.id).map((t) => t.user.id);
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
                          <AvatarFallback className="text-[9px] bg-muted font-medium">{member.name[0]}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 text-left">
                          <span className="text-xs font-medium text-foreground">{member.name}</span>
                          <span className="text-[10px] text-muted-foreground ml-1.5">{member.title}</span>
                        </div>
                        {isAssigned && <Check className="h-4 w-4 text-[#FF4C29] shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Checklists */}
            {task.checklists.length > 0 && (
              <div>
                <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <CheckSquare className="h-3 w-3" /> Checklists
                </h4>
                <div className="space-y-4">
                  {task.checklists.map((cl) => {
                    const total = cl.items.length;
                    const done = cl.items.filter((i) => i.completed).length;
                    const pct = total > 0 ? (done / total) * 100 : 0;
                    return (
                      <div key={cl.id}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium text-foreground">{cl.name}</span>
                          <span className="text-xs text-muted-foreground">{done}/{total}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-secondary mb-3">
                          <div className={cn('h-full rounded-full transition-all', pct === 100 ? 'bg-emerald-500' : 'bg-[#FF4C29]')} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="space-y-1">
                          {cl.items.map((item) => (
                            <label key={item.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-secondary/50 cursor-pointer transition-colors">
                              <input
                                type="checkbox"
                                checked={item.completed}
                                onChange={() => toggleItem.mutate({ id: item.id, completed: !item.completed })}
                                className="h-4 w-4 rounded border-border accent-[#FF4C29]"
                              />
                              <span className={cn('text-sm', item.completed ? 'text-muted-foreground line-through' : 'text-foreground')}>{item.text}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Comments */}
            <div>
              <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <MessageSquare className="h-3 w-3" /> Comments ({task.comments.length})
              </h4>

              <div className="space-y-4">
                {task.comments.map((comment) => (
                  <div key={comment.id} className="flex gap-3">
                    <Avatar className="h-7 w-7 shrink-0 mt-0.5">
                      <AvatarImage src={comment.user.avatar ?? undefined} />
                      <AvatarFallback className="text-[9px] bg-secondary font-medium">{comment.user.name[0]}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold text-foreground">{comment.user.name}</span>
                        <span className="text-[11px] text-muted-foreground/50">
                          {formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">{comment.content}</p>
                    </div>
                  </div>
                ))}

                {/* Add comment */}
                <div className="flex gap-3 pt-2 border-t border-border/60">
                  <div className="flex-1 relative">
                    <input
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && commentText.trim()) {
                          addComment.mutate({ taskId, content: commentText.trim() });
                        }
                      }}
                      placeholder="Write a comment..."
                      className="w-full rounded-xl border border-border bg-secondary/50 px-4 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20"
                    />
                    <button
                      onClick={() => { if (commentText.trim()) addComment.mutate({ taskId, content: commentText.trim() }); }}
                      disabled={!commentText.trim() || addComment.isPending}
                      className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-[#FF4C29] transition-colors disabled:opacity-30"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Created by */}
            <div className="pt-4 border-t border-border/60">
              <p className="text-[11px] text-muted-foreground/50">
                Created by {task.createdBy.name} &middot; {format(new Date(task.createdAt), 'MMM d, yyyy')}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
