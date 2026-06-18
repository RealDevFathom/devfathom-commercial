'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { safeHref } from '@/lib/validators';
import {
  ArrowLeft,
  FolderKanban,
  Users,
  Calendar,
  FileText,
  ExternalLink,
  Clock,
  CheckCircle2,
  Plus,
  Loader2,
  Pencil,
  Trash2,
  Save,
  UserPlus,
  Crown,
  X,
  Search,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { NotesContent } from '@/app/(app)/notes/notes-content';

const statusConfig: Record<string, { bg: string; dot: string; label: string }> = {
  ACTIVE: {
    bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    label: 'Active',
  },
  IN_DEVELOPMENT: {
    bg: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    dot: 'bg-blue-500',
    label: 'In Development',
  },
  ON_HOLD: {
    bg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
    label: 'On Hold',
  },
  COMPLETED: {
    bg: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
    label: 'Completed',
  },
};

export function ProjectDetailContent({ projectId }: { projectId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: project, isLoading } = trpc.projects.getById.useQuery({ id: projectId });

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const updateProject = trpc.projects.update.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setIsEditing(false);
    },
  });
  const deleteProject = trpc.projects.delete.useMutation({
    onSuccess: () => router.push('/projects'),
  });

  if (isLoading) return <ProjectDetailSkeleton />;
  if (!project) return <ProjectNotFound />;

  const config = statusConfig[project.status] || statusConfig.ACTIVE;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Back + Header */}
      <div>
        <Link
          href="/projects"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Projects
        </Link>

        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
                {project.name}
              </h1>
              <div
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
                  config.bg
                )}
              >
                <div className={cn('h-1.5 w-1.5 rounded-full', config.dot)} />
                {config.label}
              </div>
            </div>
            {project.client && (
              <p className="text-muted-foreground mt-1.5 text-[15px]">
                {project.client.name}
                {project.client.website && (
                  <a
                    href={safeHref(project.client.website)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 ml-2 text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </p>
            )}
            {!project.client && project.type === 'INTERNAL' && (
              <p className="text-muted-foreground mt-1.5 text-[15px]">Internal Product</p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                setIsEditing(!isEditing);
                setEditName(project.name);
                setEditDesc(project.description || '');
                setEditStatus(project.status);
              }}
              className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </button>
            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-muted-foreground hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/20 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => deleteProject.mutate({ id: projectId })}
                  disabled={deleteProject.isPending}
                  className="rounded-xl bg-red-500 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
                >
                  {deleteProject.isPending ? 'Deleting...' : 'Confirm Delete'}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded-xl px-2 py-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit form */}
      {isEditing && (
        <Card className="border-primary/20">
          <CardContent className="p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Edit Project</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Name</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Status</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                >
                  <option value="ACTIVE">Active</option>
                  <option value="IN_DEVELOPMENT">In Development</option>
                  <option value="ON_HOLD">On Hold</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Description</label>
              <textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                rows={3}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground resize-none focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setIsEditing(false)}
                className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  updateProject.mutate({
                    id: projectId,
                    name: editName.trim() || undefined,
                    description: editDesc || null,
                    status: editStatus as
                      | 'ACTIVE'
                      | 'IN_DEVELOPMENT'
                      | 'ON_HOLD'
                      | 'COMPLETED'
                      | 'CANCELLED',
                  })
                }
                disabled={updateProject.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
              >
                {updateProject.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save Changes
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="milestones">Milestones</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>

        {/* OVERVIEW */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {/* Details */}
            <Card className="lg:col-span-2 border-border/60">
              <CardHeader className="pb-3">
                <CardTitle className="text-[15px] font-semibold text-foreground">
                  Project Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {project.description && (
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {project.description}
                  </p>
                )}

                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                      Type
                    </p>
                    <p className="text-sm font-medium text-foreground">
                      {project.type === 'CLIENT' ? 'Client Project' : 'Internal Product'}
                    </p>
                  </div>
                  {project.startDate && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                        Started
                      </p>
                      <p className="text-sm font-medium text-foreground">
                        {format(new Date(project.startDate), 'MMM d, yyyy')}
                      </p>
                    </div>
                  )}
                  {project.endDate && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                        Deadline
                      </p>
                      <p className="text-sm font-medium text-foreground">
                        {format(new Date(project.endDate), 'MMM d, yyyy')}
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                      Team
                    </p>
                    <p className="text-sm font-medium text-foreground">
                      {project.members.length} members
                    </p>
                  </div>
                </div>

                {project.techStack.length > 0 && (
                  <div className="pt-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                      Tech Stack
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {project.techStack.map((tech) => (
                        <span
                          key={tech}
                          className="inline-flex items-center rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium text-foreground"
                        >
                          {tech}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Quick stats */}
            <div className="space-y-4">
              <Card className="border-border/60">
                <CardContent className="p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                      <FolderKanban className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-display text-2xl font-bold text-foreground">
                        {project.boards.length}
                      </p>
                      <p className="text-xs text-muted-foreground">Boards</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-border/60">
                <CardContent className="p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10">
                      <Calendar className="h-5 w-5 text-amber-500" />
                    </div>
                    <div>
                      <p className="font-display text-2xl font-bold text-foreground">
                        {project.milestones.length}
                      </p>
                      <p className="text-xs text-muted-foreground">Milestones</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-border/60">
                <CardContent className="p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10">
                      <Users className="h-5 w-5 text-blue-500" />
                    </div>
                    <div>
                      <p className="font-display text-2xl font-bold text-foreground">
                        {project.members.length}
                      </p>
                      <p className="text-xs text-muted-foreground">Team Members</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* BOARD */}
        <TabsContent value="board" className="space-y-4">
          <BoardsTab projectId={projectId} boards={project.boards} />
        </TabsContent>

        {/* TEAM */}
        <TabsContent value="team">
          <ProjectTeamTab projectId={projectId} members={project.members} />
        </TabsContent>

        {/* MILESTONES */}
        <TabsContent value="milestones">
          <MilestonesTab projectId={projectId} milestones={project.milestones} />
        </TabsContent>

        {/* NOTES */}
        <TabsContent value="notes">
          <NotesContent projectId={projectId} embedded />
        </TabsContent>

        {/* FILES */}
        <TabsContent value="files">
          {project.files.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No files yet"
              description="Upload project files, designs, and documents"
            />
          ) : (
            <div className="space-y-2">
              {project.files.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-4"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10">
                    <FileText className="h-5 w-5 text-blue-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{f.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Uploaded by {f.uploadedBy.name} &middot;{' '}
                      {format(new Date(f.createdAt), 'MMM d, yyyy')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BoardsTab({
  projectId,
  boards,
}: {
  projectId: string;
  boards: Array<{
    id: string;
    name: string;
    columns: Array<{ id: string; name: string; _count: { tasks: number } }>;
  }>;
}) {
  const utils = trpc.useUtils();
  const [showCreate, setShowCreate] = useState(false);
  const [boardName, setBoardName] = useState('');
  const [deletingBoardId, setDeletingBoardId] = useState<string | null>(null);

  const createBoard = trpc.projects.createBoard.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setShowCreate(false);
      setBoardName('');
    },
  });
  const deleteBoard = trpc.projects.deleteBoard.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setDeletingBoardId(null);
    },
  });

  return (
    <>
      {/* Header with create button */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {boards.length} board{boards.length !== 1 ? 's' : ''}
        </p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
        >
          <Plus className="h-3.5 w-3.5" />
          New Board
        </button>
      </div>

      {/* Create board inline form */}
      {showCreate && (
        <div className="rounded-xl border border-primary/30 bg-card p-4">
          <label className="block text-sm font-medium text-foreground mb-1.5">Board Name</label>
          <input
            autoFocus
            value={boardName}
            onChange={(e) => setBoardName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && boardName.trim()) {
                createBoard.mutate({ projectId, name: boardName.trim() });
              }
              if (e.key === 'Escape') {
                setShowCreate(false);
                setBoardName('');
              }
            }}
            placeholder="e.g. Sprint Board, Feature Roadmap..."
            className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <p className="text-xs text-muted-foreground mt-1.5 mb-3">
            Creates with default columns (Backlog, To Do, In Progress, Review, Done) and labels.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (boardName.trim()) createBoard.mutate({ projectId, name: boardName.trim() });
              }}
              disabled={!boardName.trim() || createBoard.isPending}
              className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
            >
              {createBoard.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Creating...
                </>
              ) : (
                'Create Board'
              )}
            </button>
            <button
              onClick={() => {
                setShowCreate(false);
                setBoardName('');
              }}
              className="rounded-xl px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Board cards */}
      {boards.length === 0 && !showCreate ? (
        <EmptyState
          icon={FolderKanban}
          title="No boards yet"
          description="Create a board to start managing tasks"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {boards.map((board) => {
            const totalTasks = board.columns.reduce((sum, c) => sum + c._count.tasks, 0);
            return (
              <Card
                key={board.id}
                className="group border-border/60 transition-all duration-200 hover:border-border hover:shadow-lg"
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={`/projects/${projectId}/board/${board.id}`}
                      className="flex-1 min-w-0"
                    >
                      <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                        {board.name}
                      </h3>
                      <p className="text-xs text-muted-foreground mt-1">
                        {board.columns.length} columns &middot; {totalTasks} tasks
                      </p>
                    </Link>
                    {deletingBoardId === board.id ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => deleteBoard.mutate({ id: board.id })}
                          className="rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setDeletingBoardId(null)}
                          className="text-[10px] text-muted-foreground hover:text-foreground px-1"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          setDeletingBoardId(board.id);
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/0 group-hover:text-muted-foreground hover:!bg-red-500/10 hover:!text-red-500 transition-all shrink-0"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <Link href={`/projects/${projectId}/board/${board.id}`}>
                    <div className="flex items-center gap-2 mt-4">
                      {board.columns.map((col) => (
                        <div
                          key={col.id}
                          className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden"
                          title={`${col.name}: ${col._count.tasks}`}
                        >
                          <div
                            className="h-full rounded-full bg-primary/60"
                            style={{
                              width:
                                totalTasks > 0 ? `${(col._count.tasks / totalTasks) * 100}%` : '0%',
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function MilestonesTab({
  projectId,
  milestones,
}: {
  projectId: string;
  milestones: Array<{
    id: string;
    name: string;
    description: string | null;
    dueDate: Date;
    completedAt: Date | null;
  }>;
}) {
  const utils = trpc.useUtils();
  const [showAdd, setShowAdd] = useState(false);
  const [msName, setMsName] = useState('');
  const [msDesc, setMsDesc] = useState('');
  const [msDue, setMsDue] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editDue, setEditDue] = useState('');

  const createMilestone = trpc.projects.createMilestone.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setShowAdd(false);
      setMsName('');
      setMsDesc('');
      setMsDue('');
    },
  });
  const updateMilestone = trpc.projects.updateMilestone.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id: projectId }),
  });
  const deleteMilestone = trpc.projects.deleteMilestone.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id: projectId }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {milestones.length} milestone{milestones.length !== 1 ? 's' : ''}
        </p>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
        >
          <Plus className="h-3.5 w-3.5" /> Add Milestone
        </button>
      </div>

      {showAdd && (
        <Card className="border-primary/20">
          <CardContent className="p-5 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Name *</label>
                <input
                  autoFocus
                  value={msName}
                  onChange={(e) => setMsName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && msName.trim() && msDue)
                      createMilestone.mutate({
                        projectId,
                        name: msName.trim(),
                        description: msDesc || undefined,
                        dueDate: new Date(msDue),
                      });
                  }}
                  placeholder="e.g. MVP Launch"
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Due Date *</label>
                <input
                  type="date"
                  value={msDue}
                  onChange={(e) => setMsDue(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Description</label>
              <input
                value={msDesc}
                onChange={(e) => setMsDesc(e.target.value)}
                placeholder="Optional details..."
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowAdd(false)}
                className="rounded-xl px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (msName.trim() && msDue)
                    createMilestone.mutate({
                      projectId,
                      name: msName.trim(),
                      description: msDesc || undefined,
                      dueDate: new Date(msDue),
                    });
                }}
                disabled={!msName.trim() || !msDue || createMilestone.isPending}
                className="flex items-center gap-1 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
              >
                {createMilestone.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{' '}
                Add
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {milestones.length === 0 && !showAdd ? (
        <EmptyState
          icon={Calendar}
          title="No milestones"
          description="Add milestones to track project progress"
        />
      ) : (
        <div className="space-y-3">
          {milestones.map((ms) => {
            const isPast = new Date(ms.dueDate) < new Date();
            const isCompleted = !!ms.completedAt;
            const isEditingThis = editingId === ms.id;

            if (isEditingThis) {
              return (
                <div
                  key={ms.id}
                  className="rounded-xl border border-primary/20 bg-card p-4 space-y-3"
                >
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-medium text-foreground mb-1">
                        Name
                      </label>
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-foreground mb-1">
                        Due Date
                      </label>
                      <input
                        type="date"
                        value={editDue}
                        onChange={(e) => setEditDue(e.target.value)}
                        className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-foreground mb-1">
                      Description
                    </label>
                    <input
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      placeholder="Optional..."
                      className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded-lg px-3 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        if (editName.trim() && editDue) {
                          updateMilestone.mutate({
                            id: ms.id,
                            name: editName.trim(),
                            description: editDesc.trim() || null,
                            dueDate: new Date(editDue),
                          });
                          setEditingId(null);
                        }
                      }}
                      disabled={!editName.trim() || !editDue}
                      className="rounded-lg bg-primary px-3 py-1 text-[11px] font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
                    >
                      Save
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={ms.id}
                className="flex items-center gap-4 rounded-xl border border-border/60 bg-card p-4 group"
              >
                {/* Toggle complete */}
                <button
                  onClick={() =>
                    updateMilestone.mutate({
                      id: ms.id,
                      completedAt: isCompleted ? null : new Date(),
                    })
                  }
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors',
                    isCompleted
                      ? 'bg-emerald-500/10 hover:bg-emerald-500/20'
                      : isPast
                        ? 'bg-red-500/10 hover:bg-red-500/20'
                        : 'bg-amber-500/10 hover:bg-amber-500/20'
                  )}
                  title={isCompleted ? 'Mark incomplete' : 'Mark complete'}
                >
                  {isCompleted ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  ) : (
                    <Clock className={cn('h-5 w-5', isPast ? 'text-red-500' : 'text-amber-500')} />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      'text-sm font-medium',
                      isCompleted ? 'text-muted-foreground line-through' : 'text-foreground'
                    )}
                  >
                    {ms.name}
                  </p>
                  {ms.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {ms.description}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-medium text-foreground">
                    {format(new Date(ms.dueDate), 'MMM d, yyyy')}
                  </p>
                  {isCompleted && ms.completedAt && (
                    <p className="text-[11px] text-emerald-500 mt-0.5">
                      Completed {format(new Date(ms.completedAt), 'MMM d')}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => {
                    setEditingId(ms.id);
                    setEditName(ms.name);
                    setEditDesc(ms.description || '');
                    setEditDue(format(new Date(ms.dueDate), 'yyyy-MM-dd'));
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover:text-muted-foreground hover:!bg-secondary hover:!text-foreground transition-all shrink-0"
                  title="Edit"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => deleteMilestone.mutate({ id: ms.id })}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-red-500 hover:!bg-red-500/10 transition-all shrink-0"
                ></button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================
   Project Team Tab — list / add / remove / role
   ============================================ */
type ProjectMemberShape = {
  user: {
    id: string;
    name: string;
    email?: string | null;
    avatar: string | null;
    title: string | null;
    department?: string;
  };
  role: string;
};

function ProjectTeamTab({
  projectId,
  members,
}: {
  projectId: string;
  members: ProjectMemberShape[];
}) {
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const userId = session?.user?.id;
  const isAdmin = session?.user?.role === 'ADMIN';

  // Caller's role on this project (for can-edit gating)
  const callerMembership = members.find((m) => m.user.id === userId);
  const canManage = isAdmin || callerMembership?.role === 'LEAD';

  const [showAdd, setShowAdd] = useState(false);
  const [picker, setPicker] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);

  const team = trpc.team.getAll.useQuery(undefined, { enabled: showAdd });

  const addMember = trpc.projects.addMember.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setPicker('');
    },
  });
  const removeMember = trpc.projects.removeMember.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id: projectId });
      setRemovingId(null);
    },
  });
  const setRole = trpc.projects.setMemberRole.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id: projectId }),
  });

  const memberIds = new Set(members.map((m) => m.user.id));
  const candidates = (team.data ?? []).filter(
    (u) =>
      !memberIds.has(u.id) &&
      (picker.trim().length === 0 ||
        u.name.toLowerCase().includes(picker.toLowerCase()) ||
        u.title?.toLowerCase().includes(picker.toLowerCase()))
  );

  const leadCount = members.filter((m) => m.role === 'LEAD').length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {members.length} member{members.length !== 1 ? 's' : ''} &middot; {leadCount} lead
          {leadCount !== 1 ? 's' : ''}
        </p>
        {canManage && (
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add Member
          </button>
        )}
      </div>

      {/* Add picker */}
      {showAdd && canManage && (
        <Card className="border-primary/20">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Add team member</h3>
              <button
                onClick={() => setShowAdd(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                autoFocus
                type="text"
                value={picker}
                onChange={(e) => setPicker(e.target.value)}
                placeholder="Search team members…"
                className="flex h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            {team.isLoading ? (
              <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
                <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading team…
              </div>
            ) : candidates.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-muted-foreground">
                {team.data && team.data.length === members.length
                  ? 'Everyone is already on this project.'
                  : 'No matching members.'}
              </p>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-card divide-y divide-border/50">
                {candidates.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => addMember.mutate({ projectId, userId: u.id, role: 'MEMBER' })}
                    disabled={addMember.isPending}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    <Avatar className="h-7 w-7">
                      <AvatarImage src={u.avatar ?? undefined} />
                      <AvatarFallback className="bg-secondary text-[10px]">
                        {u.name[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{u.name}</p>
                      {u.title && (
                        <p className="text-[10px] text-muted-foreground truncate">{u.title}</p>
                      )}
                    </div>
                    <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Members grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((m) => {
          const isLead = m.role === 'LEAD';
          const isLastLead = isLead && leadCount === 1;
          const isSelf = m.user.id === userId;
          const isConfirmingRemove = removingId === m.user.id;
          const canEditThis = canManage || isSelf;

          return (
            <Card key={m.user.id} className="group border-border/60 relative">
              <CardContent className="p-5 flex items-center gap-4">
                <Avatar className="h-11 w-11">
                  <AvatarImage src={m.user.avatar ?? undefined} />
                  <AvatarFallback className="bg-secondary text-foreground font-medium">
                    {m.user.name
                      .split(' ')
                      .map((n) => n[0])
                      .join('')}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {m.user.name}{' '}
                    {isSelf && (
                      <span className="text-[10px] font-normal text-muted-foreground">(you)</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{m.user.title}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                        isLead ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'
                      )}
                    >
                      {isLead && <Crown className="h-2.5 w-2.5" />}
                      {m.role}
                    </span>
                    {canManage && !isLastLead && (
                      <button
                        onClick={() =>
                          setRole.mutate({
                            projectId,
                            userId: m.user.id,
                            role: isLead ? 'MEMBER' : 'LEAD',
                          })
                        }
                        disabled={setRole.isPending}
                        className="text-[10px] text-muted-foreground hover:text-primary disabled:opacity-50"
                        title={isLead ? 'Demote to member' : 'Promote to lead'}
                      >
                        {isLead ? '· demote' : '· make lead'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Remove button — only for managers, or self-leave */}
                {canEditThis &&
                  !isLastLead &&
                  (isConfirmingRemove ? (
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <button
                        onClick={() => removeMember.mutate({ projectId, userId: m.user.id })}
                        disabled={removeMember.isPending}
                        className="rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                      >
                        {removeMember.isPending ? '...' : 'Remove'}
                      </button>
                      <button
                        onClick={() => setRemovingId(null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setRemovingId(m.user.id)}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover:text-muted-foreground hover:!bg-red-500/10 hover:!text-red-500 transition-all shrink-0"
                      title={isSelf ? 'Leave project' : 'Remove from project'}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ))}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {(addMember.error || removeMember.error || setRole.error) && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {addMember.error?.message || removeMember.error?.message || setRole.error?.message}
        </p>
      )}
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
      <Icon className="h-12 w-12 text-muted-foreground/20" />
      <h3 className="mt-4 font-display text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function ProjectDetailSkeleton() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <Skeleton className="h-4 w-28 mb-4" />
        <Skeleton className="h-9 w-64 mb-2" />
        <Skeleton className="h-5 w-40" />
      </div>
      <Skeleton className="h-10 w-96" />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2 border-border/60">
          <CardContent className="p-6">
            <Skeleton className="h-4 w-32 mb-4" />
            <Skeleton className="h-20 w-full mb-4" />
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="border-border/60">
              <CardContent className="p-5">
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProjectNotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-32">
      <FolderKanban className="h-16 w-16 text-muted-foreground/20" />
      <h2 className="mt-4 font-display text-xl font-semibold text-foreground">Project not found</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This project may have been deleted or you don&apos;t have access.
      </p>
      <Link href="/projects" className="mt-6 text-sm font-medium text-primary hover:underline">
        Back to Projects
      </Link>
    </div>
  );
}
