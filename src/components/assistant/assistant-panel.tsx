'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { Sparkles, ArrowUp, Check, X, Loader2, Wrench, Square } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useAssistant } from '@/lib/assistant-store';
import { cn } from '@/lib/utils';

const TOOL_LABELS: Record<string, string> = {
  listProjects: 'projects',
  listMyTasks: 'your tasks',
  listClients: 'clients',
  listTeam: 'the team',
  getFinanceSummary: 'finance',
  findOverdueTasks: 'overdue tasks',
  findProjectsBehindSchedule: 'projects behind',
  createTask: 'task',
  createClient: 'client',
};

const SUGGESTIONS = [
  'What tasks are assigned to me?',
  'List our active projects',
  'Add a client called Northwind',
  "How's our finance this month?",
];

export function AssistantPanel() {
  const { open, setOpen } = useAssistant();
  const [input, setInput] = useState('');

  const { messages, sendMessage, status, stop, addToolApprovalResponse } = useChat({
    transport: new DefaultChatTransport({ api: '/api/assistant' }),
    // After a tool result / approval response, automatically continue the run.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
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
  errorText?: string;
  approval?: { id: string };
};

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
            return <FormattedText key={i} text={part.text} />;
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
  const label = TOOL_LABELS[toolName] ?? toolName;
  const isWrite = toolName.startsWith('create');

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
    return (
      <StatusChip
        icon={<Check className="h-3 w-3" />}
        text={isWrite ? `Created ${label}` : `Read ${label}`}
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
          <Check className="h-3.5 w-3.5" /> Approve
        </button>
        <button
          onClick={() => onApprove(approvalId, false)}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function describeAction(
  toolName: string,
  input: unknown
): { title: string; fields: [string, string][] } {
  const o = (input ?? {}) as Record<string, unknown>;
  const row = (label: string, value: unknown): [string, string] | null =>
    value === undefined || value === null || value === '' ? null : [label, String(value)];
  const clean = (rows: ([string, string] | null)[]) =>
    rows.filter((r): r is [string, string] => !!r);

  if (toolName === 'createTask') {
    return {
      title: 'Create task',
      fields: clean([
        row('Title', o.title),
        row('Priority', o.priority ?? 'MEDIUM'),
        row('Column', o.columnName),
        row('Due', o.dueDate),
        row('Notes', o.description),
      ]),
    };
  }
  if (toolName === 'createClient') {
    return {
      title: 'Add client',
      fields: clean([
        row('Name', o.name),
        row('Industry', o.industry),
        row('Location', o.location),
        row('Website', o.website),
        row('Notes', o.notes),
      ]),
    };
  }
  return { title: toolName, fields: clean(Object.entries(o).map(([k, v]) => row(k, v))) };
}

/* ------------------------------------------------------------- formatting */

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) {
      return (
        <strong key={i} className="font-semibold">
          {p.slice(2, -2)}
        </strong>
      );
    }
    if (/^`[^`]+`$/.test(p)) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {p.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

function FormattedText({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-2 leading-relaxed">
      {blocks.map((block, bi) => {
        const lines = block.split('\n');
        const bulletLines = lines.filter((l) => /^\s*[-*]\s+/.test(l));
        if (bulletLines.length > 0 && bulletLines.length === lines.filter((l) => l.trim()).length) {
          return (
            <ul key={bi} className="list-disc space-y-0.5 pl-4">
              {bulletLines.map((l, li) => (
                <li key={li}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi} className="break-words text-current">
            {block.split('\n').map((l, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {inline(l)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
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
