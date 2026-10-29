'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Mail,
  Inbox,
  Plus,
  X,
  RefreshCw,
  PenSquare,
  Loader2,
  Paperclip,
  ArrowLeft,
  Send,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

type Provider = 'GMAIL' | 'OUTLOOK';
const PROVIDER_LABEL: Record<Provider, string> = { GMAIL: 'Gmail', OUTLOOK: 'Outlook' };

export function EmailContent() {
  const utils = trpc.useUtils();
  const mailboxesQuery = trpc.email.listMailboxes.useQuery();
  const providersQuery = trpc.email.providers.useQuery();

  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [connecting, setConnecting] = useState<Provider | null>(null);
  const popupRef = useRef<Window | null>(null);

  const hasMailboxes = (mailboxesQuery.data?.length ?? 0) > 0;

  const messagesQuery = trpc.email.listMessages.useQuery(
    { mailboxId: filter },
    { enabled: hasMailboxes }
  );

  // ---- connect flow -------------------------------------------------------
  const connectStart = trpc.email.connectStart.useMutation({
    onSuccess: ({ url }) => {
      const w = window.open(url, 'df-oauth', 'width=520,height=680,menubar=no,toolbar=no');
      if (!w) {
        setConnecting(null);
        toast.error('Popup blocked. Allow popups for this site and try again.');
        return;
      }
      popupRef.current = w;
    },
    onError: (e) => {
      setConnecting(null);
      toast.error(e.message || 'Could not start the connection.');
    },
  });

  const startConnect = useCallback(
    (provider: Provider) => {
      setConnecting(provider);
      connectStart.mutate({ provider });
    },
    [connectStart]
  );

  // Listen for the callback popup's result.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; ok?: boolean; error?: string } | null;
      if (!data || data.type !== 'df-email-oauth') return;
      setConnecting(null);
      if (data.ok) {
        toast.success('Account connected. Syncing your inbox…');
        utils.email.listMailboxes.invalidate();
        utils.email.listMessages.invalidate();
      } else {
        toast.error(data.error || 'Connection failed.');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [utils]);

  // If the user closes the popup without finishing, clear the connecting state.
  useEffect(() => {
    if (!connecting) return;
    const t = setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        clearInterval(t);
        setConnecting((cur) => (cur ? null : cur));
      }
    }, 700);
    return () => clearInterval(t);
  }, [connecting]);

  // ---- account actions ----------------------------------------------------
  const disconnect = trpc.email.disconnect.useMutation({
    onSuccess: () => {
      toast.success('Account disconnected.');
      setFilter(undefined);
      setSelectedId(null);
      utils.email.listMailboxes.invalidate();
      utils.email.listMessages.invalidate();
    },
    onError: (e) => toast.error(e.message || 'Could not disconnect.'),
  });

  const refresh = trpc.email.refresh.useMutation({
    onSuccess: () => utils.email.listMessages.invalidate(),
    onError: (e) => toast.error(e.message || 'Could not refresh.'),
  });

  // ---- render -------------------------------------------------------------
  if (mailboxesQuery.isLoading) return <InboxSkeleton />;

  if (!hasMailboxes) {
    return (
      <EmptyState
        providers={providersQuery.data}
        connecting={connecting}
        onConnect={startConnect}
      />
    );
  }

  const mailboxes = mailboxesQuery.data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHeader
        eyebrow="WORKSPACE"
        heading="Inbox"
        className="mb-0 shrink-0 gap-3 pb-3 sm:items-end [&_h1]:text-[1.75rem]"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refresh.mutate({})}
              disabled={refresh.isPending}
            >
              <RefreshCw className={cn('h-4 w-4', refresh.isPending && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <AddAccountButton
              providers={providersQuery.data}
              connecting={connecting}
              onConnect={startConnect}
            />
            <Button size="sm" onClick={() => setComposeOpen(true)}>
              <PenSquare className="h-4 w-4" />
              <span className="hidden sm:inline">Compose</span>
            </Button>
          </>
        }
      />

      {/* Account filters */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setFilter(undefined)}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
            !filter
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:bg-muted'
          )}
        >
          All inboxes
        </button>

        {mailboxes.map((mb) => (
          <span
            key={mb.id}
            className={cn(
              'group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
              filter === mb.id
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted'
            )}
          >
            <button
              onClick={() => setFilter(filter === mb.id ? undefined : mb.id)}
              className="inline-flex items-center gap-1.5"
              title={`${PROVIDER_LABEL[mb.type as Provider] ?? mb.type} · ${mb.emailAddress}`}
            >
              <Mail className="h-3 w-3" />
              {mb.emailAddress}
            </button>
            <button
              onClick={() => {
                if (confirm(`Disconnect ${mb.emailAddress}?`))
                  disconnect.mutate({ mailboxId: mb.id });
              }}
              className="rounded-full p-0.5 opacity-50 hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
              title="Disconnect"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>

      {connecting && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Connecting {PROVIDER_LABEL[connecting]}… complete the consent in the popup window.
        </div>
      )}

      {/* Body: list + reading pane */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div
          className={cn(
            'flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card md:w-[380px] md:shrink-0',
            selectedId && 'hidden md:flex'
          )}
        >
          <MessageList
            isLoading={messagesQuery.isLoading}
            messages={messagesQuery.data ?? []}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRefresh={() => refresh.mutate({})}
            refreshing={refresh.isPending}
          />
        </div>

        <div
          className={cn(
            'min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-card',
            !selectedId && 'hidden md:block'
          )}
        >
          {selectedId ? (
            <MessageView id={selectedId} onBack={() => setSelectedId(null)} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted-foreground">
              <Mail className="h-10 w-10 text-muted-foreground/30" />
              <p className="mt-2 text-sm">Select a message to read it</p>
            </div>
          )}
        </div>
      </div>

      {composeOpen && (
        <ComposeDialog
          open={composeOpen}
          onOpenChange={setComposeOpen}
          mailboxes={mailboxes.map((m) => ({ id: m.id, emailAddress: m.emailAddress }))}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Empty state — the onboarding bar. Two buttons, one line of copy. Nothing else.
// ===========================================================================
function EmptyState({
  providers,
  connecting,
  onConnect,
}: {
  providers?: { GMAIL: boolean; OUTLOOK: boolean };
  connecting: Provider | null;
  onConnect: (p: Provider) => void;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border border-border-subtle bg-card p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md bg-primary/10">
          <Inbox className="h-6 w-6 text-primary" />
        </div>
        <h2 className="mt-4 text-lg font-semibold">Connect your inbox</h2>
        <p className="mx-auto mt-1.5 max-w-xs text-sm text-muted-foreground">
          Link an account and your email shows up here. One click, nothing to set up.
        </p>
        <div className="mt-6 flex flex-col gap-2.5">
          <ConnectButton
            provider="GMAIL"
            disabled={providers ? !providers.GMAIL : false}
            loading={connecting === 'GMAIL'}
            onClick={() => onConnect('GMAIL')}
          />
          <ConnectButton
            provider="OUTLOOK"
            disabled={providers ? !providers.OUTLOOK : false}
            loading={connecting === 'OUTLOOK'}
            onClick={() => onConnect('OUTLOOK')}
          />
        </div>
        {providers && (!providers.GMAIL || !providers.OUTLOOK) && (
          <p className="mt-4 text-[11px] text-muted-foreground">
            {!providers.GMAIL && !providers.OUTLOOK
              ? 'Email providers are not configured on the server yet.'
              : `${!providers.GMAIL ? 'Gmail' : 'Outlook'} is not configured on the server yet.`}
          </p>
        )}
      </div>
    </div>
  );
}

function ConnectButton({
  provider,
  disabled,
  loading,
  onClick,
}: {
  provider: Provider;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-3 text-sm font-semibold transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
      Connect {PROVIDER_LABEL[provider]}
    </button>
  );
}

function AddAccountButton({
  providers,
  connecting,
  onConnect,
}: {
  providers?: { GMAIL: boolean; OUTLOOK: boolean };
  connecting: Provider | null;
  onConnect: (p: Provider) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
        <Plus className="h-4 w-4" />
        <span className="hidden sm:inline">Add account</span>
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-md">
            {(['GMAIL', 'OUTLOOK'] as Provider[]).map((p) => (
              <button
                key={p}
                disabled={(providers ? !providers[p] : false) || connecting === p}
                onClick={() => {
                  setOpen(false);
                  onConnect(p);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <Mail className="h-4 w-4" /> Connect {PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ===========================================================================
// Message list
// ===========================================================================
type ListMessage = {
  id: string;
  fromAddr: string;
  subject: string | null;
  snippet: string | null;
  isRead: boolean;
  hasAttachments: boolean;
  sentAt: Date;
  mailbox: { emailAddress: string; type: string };
};

function MessageList({
  isLoading,
  messages,
  selectedId,
  onSelect,
  onRefresh,
  refreshing,
}: {
  isLoading: boolean;
  messages: ListMessage[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-px overflow-y-auto p-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-lg p-3">
            <Skeleton className="mb-2 h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        ))}
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <Inbox className="h-8 w-8 text-muted-foreground/30" />
        <p className="mt-2 text-sm text-muted-foreground">No messages yet</p>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} /> Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto">
      {messages.map((m) => (
        <button
          key={m.id}
          onClick={() => onSelect(m.id)}
          className={cn(
            'flex w-full flex-col gap-0.5 border-b border-border/60 px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
            selectedId === m.id && 'bg-primary/5',
            !m.isRead && 'bg-primary/[0.03]'
          )}
        >
          <div className="flex items-center gap-2">
            {!m.isRead && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-sm',
                m.isRead ? 'text-muted-foreground' : 'font-semibold text-foreground'
              )}
            >
              {displayName(m.fromAddr)}
            </span>
            {m.hasAttachments && <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />}
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {formatWhen(m.sentAt)}
            </span>
          </div>
          <span
            className={cn(
              'truncate text-xs',
              m.isRead ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {m.subject || '(no subject)'}
          </span>
          {m.snippet && (
            <span className="truncate text-[11px] text-muted-foreground/80">{m.snippet}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ===========================================================================
// Message reading pane
// ===========================================================================
function MessageView({ id, onBack }: { id: string; onBack: () => void }) {
  const utils = trpc.useUtils();
  const { data: msg, isLoading } = trpc.email.getMessage.useQuery({ id });
  const markRead = trpc.email.markRead.useMutation({
    onSuccess: () => {
      utils.email.listMessages.invalidate();
    },
  });

  // Mark read once when opened.
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (msg && !msg.isRead && markedRef.current !== msg.id) {
      markedRef.current = msg.id;
      markRead.mutate({ id: msg.id });
    }
  }, [msg, markRead]);

  if (isLoading || !msg) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-4 h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-4/6" />
      </div>
    );
  }

  const to = asArray(msg.toAddrs);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-4">
        <button
          onClick={onBack}
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground md:hidden"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <h2 className="text-base font-semibold">{msg.subject || '(no subject)'}</h2>
        <div className="mt-2 text-xs text-muted-foreground">
          <div>
            <span className="font-medium text-foreground">{displayName(msg.fromAddr)}</span>{' '}
            <span>{emailOnly(msg.fromAddr)}</span>
          </div>
          {to.length > 0 && <div className="mt-0.5">to {to.map(emailOnly).join(', ')}</div>}
          <div className="mt-0.5">{new Date(msg.sentAt).toLocaleString()}</div>
          <div className="mt-0.5 opacity-70">via {msg.mailbox.emailAddress}</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {msg.bodyHtml ? (
          // Sandboxed so message HTML/scripts can't touch the app (XSS-safe).
          <iframe
            title="message"
            sandbox=""
            className="h-full w-full bg-white"
            srcDoc={msg.bodyHtml}
          />
        ) : (
          <pre className="whitespace-pre-wrap p-5 text-sm text-foreground">
            {msg.bodyText || msg.snippet || 'No content.'}
          </pre>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Compose
// ===========================================================================
function ComposeDialog({
  open,
  onOpenChange,
  mailboxes,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mailboxes: { id: string; emailAddress: string }[];
}) {
  const [from, setFrom] = useState(mailboxes[0]?.id ?? '');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const send = trpc.email.sendMessage.useMutation({
    onSuccess: () => {
      toast.success('Message sent.');
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message || 'Could not send.'),
  });

  const recipients = splitAddrs(to);
  const canSend = !!from && recipients.length > 0 && !send.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => (send.isPending ? null : onOpenChange(v))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">From</label>
            <select
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              {mailboxes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.emailAddress}
                </option>
              ))}
            </select>
          </div>
          <Input
            placeholder="To (comma separated)"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <Input placeholder="Cc (optional)" value={cc} onChange={(e) => setCc(e.target.value)} />
          <Input
            placeholder="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          <Textarea
            rows={8}
            placeholder="Write your message…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={!canSend}
            onClick={() =>
              send.mutate({
                mailboxId: from,
                to: recipients,
                cc: splitAddrs(cc),
                subject,
                html: body.replace(/\n/g, '<br>'),
              })
            }
          >
            {send.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// helpers
// ===========================================================================
function InboxSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Skeleton className="h-8 w-48" />
      <div className="flex flex-1 gap-3">
        <div className="w-full space-y-px rounded-lg border border-border p-2 md:w-[380px]">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="p-3">
              <Skeleton className="mb-2 h-3.5 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          ))}
        </div>
        <div className="hidden flex-1 rounded-lg border border-border md:block" />
      </div>
    </div>
  );
}

function displayName(addr: string): string {
  const m = addr.match(/^\s*"?([^"<]+?)"?\s*</);
  if (m) return m[1].trim();
  return emailOnly(addr);
}
function emailOnly(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim();
}
function splitAddrs(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}
function formatWhen(d: Date): string {
  const date = new Date(d);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
