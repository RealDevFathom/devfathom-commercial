'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from 'ai';
import { Sparkles, ArrowUp, Check, X, Loader2, Wrench, Square } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useAssistant } from '@/lib/assistant-store';
import { cn } from '@/lib/utils';
import { AssistantMarkdown } from './markdown';

// Friendly labels for the read-tool status chips ("Reading the team…"). Write
// tools use the approval-card titles in describeAction() instead. Unknown tools
// fall back to a humanized form of the tool name.
const TOOL_LABELS: Record<string, string> = {
  // People / HR
  listTeam: 'the team',
  getTeamMember: 'profile',
  getLeaveOverview: 'time off',
  getHrOverview: 'the HR overview',
  listPerformanceNotes: 'performance notes',
  // Tasks
  searchTasks: 'tasks',
  listMyTasks: 'your tasks',
  findOverdueTasks: 'overdue tasks',
  getTaskDetail: 'the task',
  // Projects
  listProjects: 'projects',
  getProject: 'project',
  findProjectsBehindSchedule: 'projects behind',
  // Clients
  listClients: 'clients',
  getClient: 'client',
  // Finance
  getFinanceSummary: 'finance',
  getPnlReport: 'the P&L',
  listInvoices: 'invoices',
  getInvoice: 'the invoice',
  listTransactions: 'transactions',
  listRecurringExpenses: 'recurring expenses',
  // Chat
  listChannels: 'your channels',
  searchMessages: 'messages',
  getChannelMessages: 'the channel',
  // Notes
  searchNotes: 'notes',
  getNote: 'the note',
  // Meetings
  listMeetings: 'the schedule',
  getMeeting: 'the meeting',
  // Resignations
  getMyResignation: 'your resignation',
  listResignations: 'resignations',
  // Insights
  getRecentActivity: 'recent activity',
  getOverview: 'your briefing',
  globalSearch: 'the hub',
  getTeamWorkload: 'team workload',
  findPeopleBySkill: 'people by skill',
  getDashboardStats: 'the dashboard',
  searchAuditLog: 'the audit trail',
};

// Split a camelCase tool name into lowercase words, e.g. "getTeamMember" → "team member".
function humanizeTool(name: string): string {
  return name
    .replace(/^(get|list|find|search|global)/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

const SUGGESTIONS = [
  'Brief me on my day',
  "What is Aisha working on?",
  'Which projects are behind schedule?',
  "How's our finance this month?",
];

export function AssistantPanel() {
  const { open, setOpen } = useAssistant();
  const [input, setInput] = useState('');

  const { messages, sendMessage, status, stop, addToolApprovalResponse } = useChat({
    transport: new DefaultChatTransport({ api: '/api/assistant' }),
    // Auto-continue the run after EITHER tool results OR an approval response.
    // The approval case is essential: when the user approves a write, its tool
    // part is in state 'approval-responded', which lastAssistantMessageIsComplete-
    // WithToolCalls does NOT recognise — so without the approval helper the
    // approval is never sent to the server and the write silently never runs.
    sendAutomaticallyWhen: (opts) =>
      lastAssistantMessageIsCompleteWithApprovalResponses(opts) ||
      lastAssistantMessageIsCompleteWithToolCalls(opts),
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, status, open]);

  const busy = status === 'submitted' || status === 'streaming';

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    sendMessage({ text: t });
    setInput('');
  };

  const approve = (approvalId: string, approved: boolean) =>
    addToolApprovalResponse({ id: approvalId, approved });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 p-0"
        style={{ width: '100%', maxWidth: 460 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <p className="font-display text-sm font-semibold leading-none">Assistant</p>
              <p className="mt-1 text-[11px] text-muted-foreground">DevFathom · Groq</p>
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close assistant"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
          {messages.length === 0 ? (
            <EmptyState onPick={send} />
          ) : (
            messages.map((m) => <MessageBubble key={m.id} message={m} onApprove={approve} />)
          )}
          {status === 'submitted' && <Thinking />}
        </div>

        {/* Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="border-t border-border/60 p-3"
        >
          <div className="flex items-end gap-2 rounded-2xl border border-border bg-background px-3 py-2 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15 transition-colors">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              placeholder="Ask about projects, tasks, clients…"
              className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            {busy ? (
              <button
                type="button"
                onClick={() => stop()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground transition-colors hover:bg-secondary"
                aria-label="Stop"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-all hover:bg-[#0C2E2C] active:scale-95 disabled:opacity-40"
                aria-label="Send"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
          <p className="mt-2 px-1 text-center text-[10px] text-muted-foreground">
            The assistant can read your hub data and asks before making changes.
          </p>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- messages */

type AnyPart = {
  type: string;
  state?: string;
  text?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string };
};

/** A tool can succeed at the SDK level but return a refusal/clarification in its
 *  result (e.g. "you can't deactivate the last admin"). Pull that message out so
 *  the UI never shows a misleading "Done" for a write that didn't happen. */
function resultMessage(output: unknown): { kind: 'error' | 'clarify'; text: string } | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  if (typeof o.error === 'string') return { kind: 'error', text: o.error };
  if (typeof o.needsClarification === 'string') return { kind: 'clarify', text: o.needsClarification };
  return null;
}

function MessageBubble({
  message,
  onApprove,
}: {
  message: { id: string; role: string; parts: unknown[] };
  onApprove: (approvalId: string, approved: boolean) => void;
}) {
  const isUser = message.role === 'user';
  const parts = message.parts as AnyPart[];

  // Once a turn has any successful output, drop the transient tool errors (the
  // model retried and recovered). Otherwise collapse them to a single chip.
  const hasSuccess = parts.some(
    (p) =>
      (p.type === 'text' && !!p.text) ||
      (p.type.startsWith('tool-') && p.state === 'output-available')
  );
  const firstErrorIndex = parts.findIndex(
    (p) => p.type.startsWith('tool-') && p.state === 'output-error'
  );
  const visible = parts.filter((p, idx) => {
    const isError = p.type.startsWith('tool-') && p.state === 'output-error';
    if (!isError) return true;
    if (hasSuccess) return false;
    return idx === firstErrorIndex;
  });

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[90%] space-y-2 text-sm text-foreground',
          isUser && 'rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground'
        )}
      >
        {visible.map((part, i) => {
          if (part.type === 'text' && part.text) {
            return isUser ? (
              <p key={i} className="whitespace-pre-wrap break-words text-current">
                {part.text}
              </p>
            ) : (
              <AssistantMarkdown key={i}>{part.text}</AssistantMarkdown>
            );
          }
          if (part.type.startsWith('tool-')) {
            return (
              <ToolPart
                key={i}
                toolName={part.type.slice('tool-'.length)}
                part={part}
                onApprove={onApprove}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function ToolPart({
  toolName,
  part,
  onApprove,
}: {
  toolName: string;
  part: AnyPart;
  onApprove: (approvalId: string, approved: boolean) => void;
}) {
  const label = TOOL_LABELS[toolName] ?? humanizeTool(toolName);
  // Read tools start with a read verb; everything else changes data (and is
  // approval-gated). Keep this in sync with the tool naming convention.
  const isWrite = !/^(list|find|get|search|global)/.test(toolName);

  if (part.state === 'approval-requested' && part.approval) {
    return (
      <ApprovalCard
        toolName={toolName}
        input={part.input}
        approvalId={part.approval.id}
        onApprove={onApprove}
      />
    );
  }
  if (part.state === 'input-streaming' || part.state === 'input-available') {
    return (
      <StatusChip icon={<Loader2 className="h-3 w-3 animate-spin" />} text={`Checking ${label}…`} />
    );
  }
  if (part.state === 'output-available') {
    // A tool can return a refusal/clarification even though the call "succeeded".
    // Surface it instead of a misleading "Done"/"Read" chip.
    const msg = resultMessage(part.output);
    if (msg) {
      return (
        <StatusChip
          icon={msg.kind === 'error' ? <X className="h-3 w-3" /> : <Loader2 className="h-3 w-3" />}
          text={msg.text}
          tone={msg.kind === 'error' ? 'error' : 'muted'}
        />
      );
    }
    return (
      <StatusChip
        icon={<Check className="h-3 w-3" />}
        text={isWrite ? 'Done' : `Read ${label}`}
        tone={isWrite ? 'success' : 'muted'}
      />
    );
  }
  if (part.state === 'output-denied') {
    return <StatusChip icon={<X className="h-3 w-3" />} text="Cancelled" tone="muted" />;
  }
  if (part.state === 'output-error') {
    return (
      <StatusChip
        icon={<X className="h-3 w-3" />}
        text={part.errorText || 'Tool error'}
        tone="error"
      />
    );
  }
  return null;
}

function StatusChip({
  icon,
  text,
  tone = 'muted',
}: {
  icon: ReactNode;
  text: string;
  tone?: 'muted' | 'success' | 'error';
}) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
        tone === 'muted' && 'border-border bg-muted/50 text-muted-foreground',
        tone === 'success' && 'border-primary/30 bg-primary/10 text-primary',
        tone === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive'
      )}
    >
      {icon}
      {text}
    </div>
  );
}

function ApprovalCard({
  toolName,
  input,
  approvalId,
  onApprove,
}: {
  toolName: string;
  input: unknown;
  approvalId: string;
  onApprove: (approvalId: string, approved: boolean) => void;
}) {
  const { title, fields } = describeAction(toolName, input);
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/[0.05] p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Wrench className="h-3.5 w-3.5 text-primary" />
        {title} — needs your approval
      </div>
      <dl className="mt-2 space-y-1 rounded-lg bg-background/70 p-2.5 text-[12px]">
        {fields.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2.5 flex gap-2">
        <button
          onClick={() => onApprove(approvalId, true)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-[#0C2E2C]"
        >
          <Check className="h-3.5 w-3.5" /> Confirm &amp; run
        </button>
        <button
          onClick={() => onApprove(approvalId, false)}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Nicer titles where the camelCase→words derivation reads awkwardly. Everything
// else derives its title generically, so new tools need no entry here.
const ACTION_TITLES: Record<string, string> = {
  layOffMember: 'Lay off member',
  setMemberStatus: 'Change member status',
  setLeaveStatus: 'Review leave request',
  reviewResignation: 'Review resignation',
  updateInvoiceStatus: 'Update invoice status',
  setTaskAssignees: 'Set task assignees',
  setNoteShares: 'Share note',
  markJoined: 'Mark attendance',
  toggleChecklistItem: 'Toggle checklist item',
};

// Field key → human label. Unmapped keys are title-cased from the key.
const FIELD_LABELS: Record<string, string> = {
  name: 'Name', title: 'Title', reason: 'Reason', status: 'Status', priority: 'Priority',
  dueDate: 'Due', startDate: 'Start', endDate: 'End', startTime: 'Start', endTime: 'End',
  columnName: 'Column', column: 'Column', description: 'Notes', content: 'Content',
  message: 'Message', projectName: 'Project', clientName: 'Client', channelName: 'Channel',
  email: 'Email', role: 'Role', department: 'Department', visibility: 'Visibility',
  amount: 'Amount', type: 'Type', invoiceNumber: 'Invoice', decision: 'Decision',
  lastWorkingDay: 'Last day', proposedLastDay: 'Proposed last day', recurrence: 'Repeats',
  location: 'Location', note: 'Note', person: 'Person', assignee: 'Assignee',
  assignees: 'Assignees', members: 'Members', skills: 'Skills', category: 'Category',
  newName: 'New name', text: 'Text', label: 'Label', milestoneName: 'Milestone',
};

const spaceCamel = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function formatValue(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.join(', ');
    return `${v.length} item${v.length === 1 ? '' : 's'}`;
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = String(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

function describeAction(
  toolName: string,
  input: unknown
): { title: string; fields: [string, string][] } {
  const o = (input ?? {}) as Record<string, unknown>;
  const title = ACTION_TITLES[toolName] ?? capitalize(spaceCamel(toolName));

  const fields: [string, string][] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    // Don't surface raw record ids in the approval card — they're for chaining.
    if (/(^id$|Id$|Ids$)/.test(k)) continue;
    fields.push([FIELD_LABELS[k] ?? capitalize(spaceCamel(k)), formatValue(v)]);
  }
  return { title, fields };
}

function Thinking() {
  return (
    <div className="flex items-center gap-1.5 px-1 text-muted-foreground">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-current"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-2 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Sparkles className="h-6 w-6" />
      </div>
      <h3 className="mt-4 font-display text-base font-semibold">How can I help?</h3>
      <p className="mt-1.5 max-w-[18rem] text-xs text-muted-foreground">
        Ask about your projects, tasks, clients, team or finances — or ask me to create something.
        I&apos;ll confirm before any change.
      </p>
      <div className="mt-5 grid w-full gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-xl border border-border bg-card px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:border-primary/40 hover:bg-accent/40"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
