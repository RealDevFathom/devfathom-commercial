'use client';

import { useState, useCallback } from 'react';
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
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [importResult, setImportResult] = useState<{
    boardId: string;
    boardName: string;
    columnsCreated: number;
    tasksCreated: number;
    labelsCreated: number;
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
          setError("This doesn't look like a Trello export. Please export your board from Trello > Menu > Print and Export > Export as JSON.");
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

  const handleImport = () => {
    if (!trelloData || !selectedProjectId) return;
    setStep('importing');
    setError('');
    importMutation.mutate({
      trelloJson: trelloData,
      projectId: selectedProjectId,
      memberMapping,
      includeArchived,
    });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <Link href="/projects" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="h-4 w-4" />
          Back to Projects
        </Link>
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">Import from Trello</h1>
        <p className="text-muted-foreground mt-1.5 text-[15px]">
          Upload your Trello board JSON export to recreate it in Company Hub.
        </p>
      </div>

      {/* Progress steps */}
      <div className="flex items-center gap-2">
        {(['upload', 'preview', 'importing', 'done'] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <div className={cn('h-px w-8', step === s || (['preview', 'importing', 'done'].indexOf(step) >= ['preview', 'importing', 'done'].indexOf(s)) ? 'bg-[#FF4C29]' : 'bg-border')} />}
            <div className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors',
              step === s ? 'bg-[#FF4C29] text-white' :
              (['upload', 'preview', 'importing', 'done'].indexOf(step) > i) ? 'bg-emerald-500 text-white' :
              'bg-secondary text-muted-foreground'
            )}>
              {(['upload', 'preview', 'importing', 'done'].indexOf(step) > i) ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
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
          className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-card py-20 px-8 transition-colors hover:border-[#FF4C29]/30 hover:bg-[#FF4C29]/[0.02]"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#FF4C29]/10 mb-4">
            <Upload className="h-7 w-7 text-[#FF4C29]" />
          </div>
          <h3 className="font-display text-lg font-semibold text-foreground">Drop your Trello JSON here</h3>
          <p className="mt-2 text-sm text-muted-foreground text-center max-w-sm">
            Export from Trello: Menu &rarr; More &rarr; Print and Export &rarr; Export as JSON
          </p>
          <label className="mt-6 cursor-pointer rounded-xl bg-[#FF4C29] px-6 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#E63E1C] hover:shadow-[0_0_20px_-5px_rgba(255,76,41,0.4)] active:scale-[0.98]">
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
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#FF4C29]/10">
                  <FileJson className="h-5 w-5 text-[#FF4C29]" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-foreground">{trelloData.name}</h3>
                  {trelloData.desc && <p className="text-xs text-muted-foreground">{trelloData.desc}</p>}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatBadge icon={Columns3} label="Lists" value={trelloData.lists.filter((l) => !l.closed).length} />
                <StatBadge icon={StickyNote} label="Cards" value={trelloData.cards.filter((c) => !c.closed).length} />
                <StatBadge icon={Tag} label="Labels" value={trelloData.labels.filter((l) => l.name || l.color).length} />
                <StatBadge icon={Users} label="Members" value={trelloData.members.length} />
              </div>
            </CardContent>
          </Card>

          {/* Target project */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">Import to Project</label>
            <select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20"
            >
              <option value="">Select a project...</option>
              {projects?.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Member mapping */}
          {trelloData.members.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-3">Map Trello Members</label>
              <div className="space-y-2">
                {trelloData.members.map((member) => (
                  <MemberMappingRow
                    key={member.id}
                    trelloMember={member}
                    hubMembers={teamMembers || []}
                    value={memberMapping[member.id] || ''}
                    onChange={(hubId) => setMemberMapping((prev) => ({ ...prev, [member.id]: hubId }))}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Include archived */}
          {trelloData.cards.some((c) => c.closed) && (
            <label className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-4 cursor-pointer">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-[#FF4C29]"
              />
              <div>
                <p className="text-sm font-medium text-foreground">Include archived cards</p>
                <p className="text-xs text-muted-foreground">{trelloData.cards.filter((c) => c.closed).length} archived cards will be added to an &quot;Archived&quot; column</p>
              </div>
            </label>
          )}

          {/* Import button */}
          <button
            onClick={handleImport}
            disabled={!selectedProjectId}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#FF4C29] px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-[#E63E1C] hover:shadow-[0_0_20px_-5px_rgba(255,76,41,0.4)] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
          >
            Import Board
          </button>
        </div>
      )}

      {/* STEP 3: Importing */}
      {step === 'importing' && (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="h-10 w-10 text-[#FF4C29] animate-spin mb-4" />
          <h3 className="font-display text-lg font-semibold text-foreground">Importing your board...</h3>
          <p className="mt-2 text-sm text-muted-foreground">Creating columns, tasks, labels, and comments. This may take a moment.</p>
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
            <span className="font-semibold text-foreground">&quot;{importResult.boardName}&quot;</span> has been imported with {importResult.columnsCreated} columns, {importResult.tasksCreated} tasks, and {importResult.labelsCreated} labels.
          </p>
          <button
            onClick={() => router.push(`/projects`)}
            className="mt-8 rounded-xl bg-[#FF4C29] px-8 py-3 text-sm font-semibold text-white transition-all hover:bg-[#E63E1C] active:scale-[0.98]"
          >
            Go to Projects
          </button>
        </div>
      )}
    </div>
  );
}

function StatBadge({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number }) {
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
        className="w-44 rounded-lg border border-border bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none"
      >
        <option value="">Unassigned</option>
        {hubMembers.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    </div>
  );
}
