'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import { useReducedMotion } from 'motion/react';
import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import { assistantEntry, type AssistantEntry } from './assistant-suggestions';
import {
  clearConversation,
  hasSettledToolStep,
  readConversation,
  saveConversation,
} from './assistant-history';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from 'ai';
import { Sparkles, ArrowUp, Check, X, Loader2, Wrench, Square, RotateCcw } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useAssistant } from '@/lib/assistant-store';
import { cn } from '@/lib/utils';
import { AssistantMarkdown } from './markdown';

// Friendly labels for the read-tool status chips ("Reading the team…"). Write
// tools use the approval-card titles in describeAction() instead. Unknown tools
// fall back to a humanized form of the tool name.
const TOOL_LABELS: Record<string, string> = {
  askPharmacyReports: 'pharmacy reports',
  askPharmacyBusinessInsights: 'pharmacy business insights',
  askPharmacyFinanceInsights: 'pharmacy finance insights',
  askRestaurantReports: 'restaurant reports',
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

export function AssistantPanel() {
  const entitlements = useEntitlements();
  const { data: session, status } = useSession();
  const entry = assistantEntry(entitlements, session?.user, status);
  // Match the shell's live-session identity boundary. Remount before rendering
  // another tenant/user/access context. The conversation store is keyed by the
  // same value, so another context never reads this one's messages.
  const contextKey = JSON.stringify([
    entitlements.organizationId,
    entitlements.vertical,
    [...entitlements.enabledModules].sort(),
    session?.user.id,
    session?.user.organizationId,
    session?.user.role,
    session?.user.status,
    session?.user.sessionRevoked,
    status,
    entry.canChat,
  ]);
  return (
    <AssistantConversation
      key={contextKey}
      contextKey={contextKey}
      entry={entry}
      sessionLoading={status === 'loading'}
    />
  );
}

// The transport owns a lifecycle gate read only by request/event callbacks.
// Keeping it outside React refs avoids treating constructor-time callback setup
// as a render-time ref read. Effect replay can reactivate the same conversation.
function createConversationTransport(canChat: boolean) {
  let active = true;
  return {
    isActive: () => active,
    activate: () => {
      active = true;
    },
    deactivate: () => {
      active = false;
    },
    transport: new DefaultChatTransport({
      api: '/api/assistant',
      fetch: async (url, options) => {
        if (!active || !canChat) throw new DOMException('Stopped', 'AbortError');
        const response = await fetch(url, options);
        if (response.status === 401 || response.status === 403) {
          throw new Error('ASSISTANT_PERMISSION_DENIED');
        }
        return response;
      },
    }),
  };
}

const UNAVAILABLE_COPY =
  "Ask Fathom can't answer right now. Try again in a few minutes; if it keeps happening, contact support.";
const PERMISSION_COPY =
  'Permission denied. Your session or workspace access may have changed. Reload to check your access.';
const NOTICE_COPY = {
  empty: 'No answer was returned for this question.',
  stopped: 'Response stopped. Completed actions are not undone.',
  unanswered: 'This question has not been answered yet.',
} as const;

// Touch-first screens open on the panel itself, as Base UI does for a touch
// trigger, so the on-screen keyboard does not cover the examples.
const prefersTouch = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: none) and (pointer: coarse)').matches;

function AssistantConversation({
  contextKey,
  entry,
  sessionLoading,
}: {
  contextKey: string;
  entry: AssistantEntry;
  sessionLoading: boolean;
}) {
  const { open, setOpen } = useAssistant();
  const [input, setInput] = useState('');
  const [emptyHint, setEmptyHint] = useState(false);
  const [requestError, setRequestError] = useState<
    'permission' | 'configuration' | 'provider' | null
  >(null);
  const [notice, setNotice] = useState<'empty' | 'stopped' | null>(null);
  // Set before the SDK reports `submitted` and held until every automatic
  // continuation settles, so a repeat Enter can never queue a second question.
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  const [conversation] = useState(() => createConversationTransport(entry.canChat));
  const [restored] = useState(() => (entry.canChat ? readConversation(contextKey) : []));

  const { messages, sendMessage, regenerate, status, stop, clearError, addToolApprovalResponse } =
    useChat({
      messages: restored,
      transport: conversation.transport,
      onError: (error) => {
        if (!conversation.isActive()) return;
        // The SDK reports provider errors through onError; sendMessage can resolve
        // on failure. The question stays in its bubble for an explicit retry.
        setRequestError(
          error.message === 'ASSISTANT_PERMISSION_DENIED'
            ? 'permission'
            : error.message === 'ASSISTANT_NOT_CONFIGURED'
              ? 'configuration'
              : 'provider'
        );
      },
      onFinish: ({ isAbort, isError, message }) => {
        if (!conversation.isActive() || isAbort || isError) return;
        const parts = message.parts as AnyPart[];
        const hasContent = parts.some(
          (part) => (part.type === 'text' && part.text?.trim()) || part.type.startsWith('tool-')
        );
        setNotice(hasContent ? null : 'empty');
      },
      // Auto-continue reads and explicit approval responses, but never a run that
      // belonged to an unmounted tenant context.
      sendAutomaticallyWhen: (opts) =>
        conversation.isActive() &&
        entry.canChat &&
        (lastAssistantMessageIsCompleteWithApprovalResponses(opts) ||
          lastAssistantMessageIsCompleteWithToolCalls(opts)),
    });

  useEffect(() => {
    conversation.activate();
    return () => {
      conversation.deactivate();
      void stop();
      // Switching Ask Fathom off ends the conversation, not only the panel.
      if (useAssistant.getState().askFathomEnabled === false) clearConversation();
    };
  }, [conversation, stop]);

  // A usable context owns the tab's conversation; an ended or unusable session
  // drops it; a session that is still loading leaves it untouched.
  useEffect(() => {
    if (entry.canChat) saveConversation(contextKey, messages);
    else if (!sessionLoading) clearConversation();
  }, [contextKey, entry.canChat, messages, sessionLoading]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  }, [messages, status, open, reducedMotion]);

  const busy = pending || status === 'submitted' || status === 'streaming';
  const failed = requestError !== null || status === 'error';
  const denied = requestError === 'permission' || requestError === 'configuration';
  const last = messages.at(-1);
  const unanswered = !busy && last?.role === 'user';
  const canRetry =
    entry.canChat &&
    !busy &&
    !denied &&
    messages.some((message) => message.role === 'user') &&
    (failed || notice === 'empty' || unanswered);

  const run = async (request: () => Promise<void>) => {
    if (inFlight.current || !conversation.isActive() || !entry.canChat) return;
    inFlight.current = true;
    setPending(true);
    setRequestError(null);
    setNotice(null);
    try {
      await request();
    } catch {
      if (conversation.isActive()) setRequestError('provider');
    } finally {
      inFlight.current = false;
      if (conversation.isActive()) setPending(false);
    }
  };

  const send = (text: string) => {
    const question = text.trim();
    if (!question) {
      setEmptyHint(true);
      inputRef.current?.focus();
      return;
    }
    if (busy || inFlight.current || denied || !entry.canChat) return;
    setInput('');
    setEmptyHint(false);
    void run(() => sendMessage({ text: question }));
  };

  // Resend the last question in place: regenerate keeps (or returns to) its
  // bubble. A reply that already recorded a tool step is continued instead, so
  // completed results are never discarded.
  const retry = () => {
    if (!canRetry) return;
    const continueTurn = last?.role === 'assistant' && hasSettledToolStep(last);
    clearError();
    inputRef.current?.focus();
    void run(() => (continueTurn ? sendMessage() : regenerate()));
  };

  const approve = (approvalId: string, approved: boolean) => {
    if (!conversation.isActive() || !entry.canChat || busy || failed) return;
    void Promise.resolve(addToolApprovalResponse({ id: approvalId, approved })).catch(() => {
      if (conversation.isActive()) setRequestError('provider');
    });
  };

  // DEV-603: open on the question box so typing never lands on Close. Focus
  // stays trapped in the dialog and returns to the launcher when it closes.
  const initialFocus = (openType: string) => {
    const box = inputRef.current;
    if (!box || box.disabled || openType === 'touch' || prefersTouch()) {
      return popupRef.current ?? true;
    }
    return box;
  };

  const hintId = 'assistant-question-hint';
  const statusText = notice ? NOTICE_COPY[notice] : unanswered ? NOTICE_COPY.unanswered : null;
  const retryButton = canRetry ? (
    <Button type="button" variant="outline" size="touch" onClick={retry}>
      <RotateCcw className="h-3.5 w-3.5" />
      Retry
    </Button>
  ) : null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        ref={popupRef}
        side="right"
        showCloseButton={false}
        initialFocus={initialFocus}
        // DEV-598: animate position and opacity only. Colours come straight from
        // the theme tokens, so a theme switch can never leave the surface
        // interpolating (or stuck) on the previous theme's paper.
        className="gap-0 p-0 transition-[opacity,translate] motion-reduce:transition-none motion-reduce:transform-none"
        style={{ width: '100%', maxWidth: 460 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <SheetTitle className="font-display text-sm font-semibold leading-none">
                Ask Fathom
              </SheetTitle>
              <SheetDescription className="mt-1 text-[11px] text-muted-foreground">
                Workspace assistant
              </SheetDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close assistant"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
          {messages.length === 0 ? (
            <EmptyState entry={entry} onPick={send} disabled={busy} />
          ) : (
            messages.map((m) => (
              <MessageBubble key={m.id} message={m} onApprove={approve} disabled={busy || failed} />
            ))
          )}
          {busy && <Thinking />}
          {failed ? (
            <div
              role="alert"
              className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <p>
                {requestError === 'permission'
                  ? PERMISSION_COPY
                  : requestError === 'configuration'
                    ? "Ask Fathom isn't set up yet, contact support."
                    : UNAVAILABLE_COPY}
              </p>
              {requestError !== 'configuration' && retryButton}
            </div>
          ) : statusText ? (
            <div role="status" className="space-y-2 text-sm text-muted-foreground">
              <p>{statusText}</p>
              {retryButton}
            </div>
          ) : null}
        </div>

        {/* Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="border-t border-border/60 p-3"
        >
          <label
            htmlFor="assistant-question"
            className="mb-2 block text-xs font-medium text-foreground"
          >
            Your question
          </label>
          <div className="flex items-end gap-2 rounded-2xl border border-border bg-background px-3 py-2 transition-shadow focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15">
            <textarea
              ref={inputRef}
              id="assistant-question"
              dir="auto"
              disabled={!entry.canChat || denied}
              readOnly={busy}
              aria-describedby={emptyHint ? hintId : undefined}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (emptyHint) setEmptyHint(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!busy) send(input);
                }
              }}
              rows={1}
              placeholder={busy ? 'Waiting for the answer…' : 'Ask about your workspace…'}
              className="max-h-32 min-h-[44px] min-w-0 flex-1 resize-none bg-transparent text-sm text-foreground outline-none [unicode-bidi:plaintext] placeholder:text-muted-foreground"
            />
            {busy ? (
              <Button
                type="button"
                onClick={() => {
                  void stop();
                  setNotice('stopped');
                }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground transition-colors hover:bg-secondary"
                variant="secondary"
                aria-label="Stop"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={!input.trim() || !entry.canChat || denied}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-none transition-all hover:bg-primary-hover active:scale-95 disabled:opacity-40"
                aria-label="Send"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
          {/* DEV-593: an empty send explains itself instead of doing nothing. */}
          <p
            id={hintId}
            role="status"
            className={cn('px-1 text-xs text-muted-foreground', emptyHint && 'mt-2')}
          >
            {emptyHint
              ? messages.length === 0 && entry.suggestions.length > 0
                ? 'Type a question first, or choose an example above.'
                : 'Type a question first.'
              : null}
          </p>
          <p className="mt-2 px-1 text-center text-[10px] text-muted-foreground">
            Access is checked for each request. Supported changes require your confirmation.
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
  approval?: { id: string; approved?: boolean };
};

/** A tool can succeed at the SDK level but return a refusal/clarification in its
 *  result (e.g. "you can't deactivate the last admin"). Pull that message out so
 *  the UI never shows a misleading "Done" for a write that didn't happen. */
function resultMessage(output: unknown): { kind: 'error' | 'clarify'; text: string } | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  if (typeof o.error === 'string') return { kind: 'error', text: o.error };
  if (typeof o.needsClarification === 'string')
    return { kind: 'clarify', text: o.needsClarification };
  if (o.kind === 'refusal' || o.kind === 'cannot_answer' || o.kind === 'unavailable') {
    return {
      kind: 'error',
      text: typeof o.message === 'string' ? o.message : 'This request could not be completed.',
    };
  }
  return null;
}

function MessageBubble({
  message,
  onApprove,
  disabled,
}: {
  message: { id: string; role: string; parts: unknown[] };
  onApprove: (approvalId: string, approved: boolean) => void;
  disabled: boolean;
}) {
  const isUser = message.role === 'user';
  const parts = message.parts as AnyPart[];

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[90%] space-y-2 text-sm text-foreground',
          isUser && 'rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground'
        )}
      >
        {parts.map((part, i) => {
          if (part.type === 'text' && part.text) {
            return isUser ? (
              // DEV-599: each line takes its direction from its first strong
              // character, so Urdu with embedded Latin and numbers stays in order.
              <p
                key={i}
                dir="auto"
                className="whitespace-pre-wrap break-words text-current [unicode-bidi:plaintext]"
              >
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
                disabled={disabled}
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
  disabled,
}: {
  toolName: string;
  part: AnyPart;
  onApprove: (approvalId: string, approved: boolean) => void;
  disabled: boolean;
}) {
  const label = TOOL_LABELS[toolName] ?? humanizeTool(toolName);
  // Read tools start with a read verb; everything else changes data (and is
  // approval-gated). Keep this in sync with the tool naming convention.
  const isWrite =
    ![
      'askPharmacyReports',
      'askPharmacyBusinessInsights',
      'askPharmacyFinanceInsights',
      'askRestaurantReports',
    ].includes(toolName) && !/^(list|find|get|search|global)/.test(toolName);

  if (part.state === 'approval-requested' && part.approval) {
    return (
      <ApprovalCard
        toolName={toolName}
        input={part.input}
        approvalId={part.approval.id}
        onApprove={onApprove}
        disabled={disabled}
      />
    );
  }
  if (part.state === 'approval-responded') {
    return (
      <StatusChip
        icon={<Wrench className="h-3 w-3" />}
        text={part.approval?.approved ? 'Approved — awaiting result' : 'Cancellation pending'}
      />
    );
  }
  if (part.state === 'input-streaming' || part.state === 'input-available') {
    return (
      <StatusChip
        icon={<Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />}
        text={`Checking ${label}…`}
      />
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
        tone === 'success' && 'border-success/30 bg-success/10 text-success',
        tone === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive'
      )}
    >
      {icon}
      <span dir="auto">{text}</span>
    </div>
  );
}

function ApprovalCard({
  toolName,
  input,
  approvalId,
  onApprove,
  disabled,
}: {
  toolName: string;
  input: unknown;
  approvalId: string;
  onApprove: (approvalId: string, approved: boolean) => void;
  disabled: boolean;
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
            <dd dir="auto" className="min-w-0 break-words text-foreground">
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2.5 flex gap-2">
        <Button
          disabled={disabled}
          onClick={() => onApprove(approvalId, true)}
          className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-none transition-colors hover:bg-primary-hover"
        >
          <Check className="h-3.5 w-3.5" /> Confirm &amp; run
        </Button>
        <Button
          disabled={disabled}
          variant="outline"
          onClick={() => onApprove(approvalId, false)}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Cancel
        </Button>
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
  name: 'Name',
  title: 'Title',
  reason: 'Reason',
  status: 'Status',
  priority: 'Priority',
  dueDate: 'Due',
  startDate: 'Start',
  endDate: 'End',
  startTime: 'Start',
  endTime: 'End',
  columnName: 'Column',
  column: 'Column',
  description: 'Notes',
  content: 'Content',
  message: 'Message',
  projectName: 'Project',
  clientName: 'Client',
  channelName: 'Channel',
  email: 'Email',
  role: 'Role',
  department: 'Department',
  visibility: 'Visibility',
  amount: 'Amount',
  type: 'Type',
  invoiceNumber: 'Invoice',
  decision: 'Decision',
  lastWorkingDay: 'Last day',
  proposedLastDay: 'Proposed last day',
  recurrence: 'Repeats',
  location: 'Location',
  note: 'Note',
  person: 'Person',
  assignee: 'Assignee',
  assignees: 'Assignees',
  members: 'Members',
  skills: 'Skills',
  category: 'Category',
  newName: 'New name',
  text: 'Text',
  label: 'Label',
  milestoneName: 'Milestone',
};

const spaceCamel = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
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
    <div role="status" className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
      Working on your request…
    </div>
  );
}

function EmptyState({
  entry,
  onPick,
  disabled,
}: {
  entry: AssistantEntry;
  onPick: (q: string) => void;
  disabled: boolean;
}) {
  const examples = entry.canChat ? entry.suggestions : [];
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-2 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Sparkles className="h-6 w-6" />
      </div>
      <h3 className="mt-4 font-display text-base font-semibold">{entry.title}</h3>
      <p role="status" className="mt-1.5 max-w-[18rem] text-xs text-muted-foreground">
        {entry.description}
      </p>
      {examples.length > 0 && (
        <div className="mt-5 w-full text-start">
          <p
            id="assistant-examples"
            className="px-1 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted"
          >
            Try asking
          </p>
          <ul aria-labelledby="assistant-examples" className="mt-2 grid gap-2">
            {examples.map((s) => (
              <li key={s}>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onPick(s)}
                  className="h-auto min-h-11 w-full justify-start whitespace-normal rounded-xl border border-border bg-card px-3 py-2 text-start text-[13px] text-foreground"
                >
                  {s}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* DEV-584: access wording only where the role, not the workspace, narrows the examples. */}
      {entry.canChat && entry.limitedByRole && (
        <p className="mt-3 max-w-[18rem] text-xs text-muted-foreground">
          Examples match your role. Report questions need report access from your workspace
          administrator.
        </p>
      )}
    </div>
  );
}
