'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Upload,
  FileJson,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Users,
  Columns3,
  StickyNote,
  Tag,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
// Avatar unused currently but will be used for member mapping enhancement
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { trelloBoardSchema } from '@/types/trello';
import type { TrelloBoard, TrelloMember } from '@/types/trello';

type Step = 'upload' | 'preview' | 'importing' | 'done';

export function TrelloImportContent() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('upload');
  const [error, setError] = useState('');
  const [trelloData, setTrelloData] = useState<TrelloBoard | null>(null);
  const [memberMapping, setMemberMapping] = useState<Record<string, string>>({});
  const [includeArchived, setIncludeArchived] = useState(false);
  // IMP-TRELLO-01: import into an existing project or spin up a brand-new one.
  const [targetMode, setTargetMode] = useState<'existing' | 'new'>('existing');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [importResult, setImportResult] = useState<{
    boardId: string;
    boardName: string;
    columnsCreated: number;
    tasksCreated: number;
    labelsCreated: number;
    // IMP-TRELLO-02: completed (dueComplete) cards routed to the Done column.
    completedCount?: number;
    // IMP-TRELLO-04: partial-failure / skipped-card reporting.
    skippedCount?: number;
    skipped?: Array<{ name: string; reason: string }>;
  } | null>(null);

  const { data: projects } = trpc.projects.getAll.useQuery();
  const { data: teamMembers } = trpc.team.getAll.useQuery();
  const importMutation = trpc.trelloImport.importBoard.useMutation({
    onSuccess: (result) => {
      setImportResult(result);
      setStep('done');
    },
    onError: (err) => {
      setError(err.message);
      setStep('preview');
    },
  });

  const handleFileUpload = useCallback((file: File) => {
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        const parsed = trelloBoardSchema.safeParse(json);
        if (!parsed.success) {
          setError(
            "This doesn't look like a Trello export. Please export your board from Trello > Menu > Print and Export > Export as JSON."
          );
          return;
        }
        setTrelloData(parsed.data);
        setStep('preview');
      } catch {
        setError('Invalid JSON file. Please upload a valid Trello board export.');
      }
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && file.type === 'application/json') handleFileUpload(file);
      else setError('Please upload a JSON file.');
    },
    [handleFileUpload]
  );

  const counts = useMemo(() => {
    if (!trelloData) return null;
    const archivedCards = trelloData.cards.filter((c) => c.closed).length;
    return {
      openLists: trelloData.lists.filter((l) => !l.closed).length,
      openCards: trelloData.cards.filter((c) => !c.closed).length,
      labels: trelloData.labels.filter((l) => l.name || l.color).length,
      members: trelloData.members.length,
      archivedCards,
      hasArchivedCards: archivedCards > 0,
    };
  }, [trelloData]);

  const canImport = !!trelloData && (targetMode === 'existing' ? !!selectedProjectId : true);

  const handleImport = () => {
    if (!trelloData || !canImport) return;
    setStep('importing');
    setError('');
    importMutation.mutate({
      trelloJson: trelloData,
      memberMapping,
      includeArchived,
      ...(targetMode === 'existing'
        ? { projectId: selectedProjectId }
        : { newProjectName: newProjectName.trim() || trelloData.name }),
    });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="space-y-4">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Projects
        </Link>
        <PageHeader
          eyebrow="WORKSPACE"
          heading="Import from Trello"
          description="Upload your Trello board JSON export to recreate it in DevFathom."
          className="mb-0"
        />
      </div>

      {/* Progress steps */}
      <div className="flex items-center gap-2">
        {(['upload', 'preview', 'importing', 'done'] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && (
              <div
                className={cn(
                  'h-px w-8',
                  step === s ||
                    ['preview', 'importing', 'done'].indexOf(step) >=
                      ['preview', 'importing', 'done'].indexOf(s)
                    ? 'bg-primary'
                    : 'bg-border'
                )}
              />
            )}
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                step === s
                  ? 'bg-primary text-white'
                  : ['upload', 'preview', 'importing', 'done'].indexOf(step) > i
                    ? 'bg-emerald-500 text-white'
                    : 'bg-secondary text-muted-foreground'
              )}
            >
              {['upload', 'preview', 'importing', 'done'].indexOf(step) > i ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                i + 1
              )}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* STEP 1: Upload */}
      {step === 'upload' && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-card py-20 px-8 transition-colors hover:border-primary/30 hover:bg-primary/[0.02]"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 mb-4">
            <Upload className="h-7 w-7 text-primary" />
          </div>
          <h3 className="font-display text-lg font-semibold text-foreground">
            Drop your Trello JSON here
          </h3>
          <p className="mt-2 text-sm text-muted-foreground text-center max-w-sm">
            Export from Trello: Menu &rarr; More &rarr; Print and Export &rarr; Export as JSON
          </p>
          <label className="mt-6 cursor-pointer rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]">
            Choose File
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file);
              }}
            />
          </label>
        </div>
      )}

      {/* STEP 2: Preview */}
      {step === 'preview' && trelloData && (
        <div className="space-y-6">
          {/* Board summary */}
          <Card className="border-border/60">
            <CardContent className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                  <FileJson className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-foreground">{trelloData.name}</h3>
                  {trelloData.desc && (
                    <p className="text-xs text-muted-foreground">{trelloData.desc}</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                <StatBadge icon={Columns3} label="Lists" value={counts?.openLists ?? 0} />
                <StatBadge icon={StickyNote} label="Cards" value={counts?.openCards ?? 0} />
                <StatBadge icon={Tag} label="Labels" value={counts?.labels ?? 0} />
                <StatBadge icon={Users} label="Members" value={counts?.members ?? 0} />
              </div>
            </CardContent>
          </Card>

          {/* Target project — existing or brand-new (IMP-TRELLO-01) */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Import to Project
            </label>
            <div className="mb-3 inline-flex rounded-xl border border-border bg-card p-1">
              {(['existing', 'new'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTargetMode(mode)}
                  className={cn(
                    'rounded-lg px-4 py-1.5 text-sm font-medium transition-colors',
                    targetMode === mode
                      ? 'bg-primary text-white'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {mode === 'existing' ? 'Existing project' : 'New project'}
                </button>
              ))}
            </div>
            {targetMode === 'existing' ? (
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="">Select a project...</option>
                {projects?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder={trelloData.name}
                  className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  A new project is created with you as its lead. Leave blank to use the board name
                  &quot;{trelloData.name}&quot;.
                </p>
              </>
            )}
          </div>

          {/* Member mapping */}
          {trelloData.members.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-3">
                Map Trello Members
              </label>
              <div className="space-y-2">
                {trelloData.members.map((member) => (
                  <MemberMappingRow
                    key={member.id}
                    trelloMember={member}
                    hubMembers={teamMembers || []}
                    value={memberMapping[member.id] || ''}
                    onChange={(hubId) =>
                      setMemberMapping((prev) => ({ ...prev, [member.id]: hubId }))
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {/* Include archived */}
          {counts?.hasArchivedCards && (
            <label className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-4 cursor-pointer">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <div>
                <p className="text-sm font-medium text-foreground">Include archived cards</p>
                <p className="text-xs text-muted-foreground">
                  {counts?.archivedCards ?? 0} archived cards will be added to an
                  &quot;Archived&quot; column
                </p>
              </div>
            </label>
          )}

          {/* Import button */}
          <button
            onClick={handleImport}
            disabled={!canImport}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
          >
            Import Board
          </button>
        </div>
      )}

      {/* STEP 3: Importing */}
      {step === 'importing' && (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="h-10 w-10 text-primary animate-spin mb-4" />
          <h3 className="font-display text-lg font-semibold text-foreground">
            Importing your board...
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Creating columns, tasks, labels, and comments. This may take a moment.
          </p>
        </div>
      )}

      {/* STEP 4: Done */}
      {step === 'done' && importResult && (
        <div className="flex flex-col items-center justify-center py-16">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 mb-5">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          </div>
          <h3 className="font-display text-xl font-bold text-foreground">Import Complete</h3>
          <p className="mt-2 text-sm text-muted-foreground text-center max-w-sm">
            <span className="font-semibold text-foreground">
              &quot;{importResult.boardName}&quot;
            </span>{' '}
            has been imported with {importResult.columnsCreated} columns,{' '}
            {importResult.tasksCreated} tasks, and {importResult.labelsCreated} labels.
            {!!importResult.completedCount && importResult.completedCount > 0 && (
              <>
                {' '}
                {importResult.completedCount} completed card
                {importResult.completedCount === 1 ? ' was' : 's were'} moved to the Done column.
              </>
            )}
          </p>
          {/* IMP-TRELLO-04: surface what was skipped instead of dropping silently. */}
          {!!importResult.skippedCount && importResult.skippedCount > 0 && (
            <div className="mt-4 w-full max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-left">
              <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                {importResult.skippedCount} card{importResult.skippedCount === 1 ? '' : 's'} skipped
              </p>
              <ul className="mt-1 space-y-0.5">
                {(importResult.skipped ?? []).slice(0, 8).map((s, i) => (
                  <li key={i} className="text-[11px] text-muted-foreground">
                    <span className="text-foreground/80">{s.name || 'Untitled'}</span> — {s.reason}
                  </li>
                ))}
                {importResult.skippedCount > 8 && (
                  <li className="text-[11px] text-muted-foreground">
                    …and {importResult.skippedCount - 8} more.
                  </li>
                )}
              </ul>
            </div>
          )}
          <button
            onClick={() => router.push(`/projects`)}
            className="mt-8 rounded-xl bg-primary px-8 py-3 text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
          >
            Go to Projects
          </button>
        </div>
      )}
    </div>
  );
}

function StatBadge({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-secondary p-3">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <div>
        <p className="font-display text-lg font-bold text-foreground leading-none">{value}</p>
        <p className="text-[11px] text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function MemberMappingRow({
  trelloMember,
  hubMembers,
  value,
  onChange,
}: {
  trelloMember: TrelloMember;
  hubMembers: Array<{ id: string; name: string; email: string; avatar: string | null }>;
  value: string;
  onChange: (hubId: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{trelloMember.fullName}</p>
        <p className="text-xs text-muted-foreground">@{trelloMember.username}</p>
      </div>
      <span className="text-xs text-muted-foreground">&rarr;</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full sm:w-44 rounded-lg border border-border bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
      >
        <option value="">Unassigned</option>
        {hubMembers.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </div>
  );
}
