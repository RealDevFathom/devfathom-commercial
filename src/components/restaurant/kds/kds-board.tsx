'use client';

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { FathomMark } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';

type DisplayStatus = 'NEW' | 'COOKING' | 'READY' | 'RECALLED';
type Runtime = { deviceSecret: string; operatorStaffProfileId: string };
type QueueItem = {
  orderItemId: string;
  name: string;
  course: number;
  seatNumber: number | null;
  quantity: number;
  itemStatus: string;
  displayStatus: DisplayStatus;
};
type QueueTicket = {
  ticketId: string;
  ticketNumber: number;
  orderId: string;
  orderNumber: number;
  createdAt: string;
  displayStatus: DisplayStatus;
  items: QueueItem[];
};
type QueuePayload = {
  stationId: string;
  businessDate: string;
  tickets: QueueTicket[];
  cursor: number;
  gap: boolean;
  hasMore: boolean;
  displayMapping: Record<string, string>;
};
type NoticeState = { tone: StatusTone; message: string };

const LANES = ['NEW', 'COOKING', 'READY', 'RECALLED'] as const;
const LANE_TONES: Record<DisplayStatus, StatusTone> = {
  NEW: 'info',
  COOKING: 'warning',
  READY: 'success',
  RECALLED: 'danger',
};
const ACTIONS = {
  NEW: { path: 'ack', label: 'Start', success: 'Item started.' },
  COOKING: { path: 'bump', label: 'Mark ready', success: 'Item marked ready.' },
  READY: { path: 'recall', label: 'Recall', success: 'Item recalled.' },
  RECALLED: { path: 'bump', label: 'Mark ready', success: 'Recalled item marked ready.' },
} as const;
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function messageFrom(body: unknown) {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string'
  ) {
    return body.error.slice(0, 240);
  }
  return 'Request failed without a safe server message.';
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new RequestError(response.status, messageFrom(body));
  return body as T;
}

function queuePath(cursor?: number) {
  const query = new URLSearchParams();
  if (cursor !== undefined) query.set('sinceCursor', String(cursor));
  query.set('limit', '50');
  return `/api/restaurant/kds/queue?${query}`;
}

function formatAge(createdAt: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function KdsBoard() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [deviceSecret, setDeviceSecret] = useState('');
  const [operatorStaffProfileId, setOperatorStaffProfileId] = useState('');
  const [queue, setQueue] = useState<QueuePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const cursor = useRef<number | null>(null);
  const epoch = useRef(0);
  const queueFlight = useRef<Promise<void> | null>(null);
  const pendingMutation = useRef(false);
  const idempotencyKeys = useRef(new Map<string, string>());

  const disconnect = useCallback((message?: string) => {
    epoch.current += 1;
    cursor.current = null;
    pendingMutation.current = false;
    idempotencyKeys.current.clear();
    setRuntime(null);
    setQueue(null);
    setLoading(false);
    setQueueError(null);
    setPending(null);
    setNotice(message ? { tone: 'danger', message } : null);
  }, []);

  const loadQueue = useCallback(
    async (activeRuntime: Runtime, sinceCursor?: number) => {
      if (queueFlight.current) await queueFlight.current;
      const requestEpoch = epoch.current;
      const flight = (async () => {
        try {
          const headers = { Authorization: `Bearer ${activeRuntime.deviceSecret}` };
          let next = await request<QueuePayload>(queuePath(sinceCursor), { headers });
          if (sinceCursor !== undefined && next.gap) {
            next = await request<QueuePayload>(queuePath(), { headers });
          }
          if (requestEpoch !== epoch.current) return;
          cursor.current = next.cursor;
          setQueue(next);
          setQueueError(null);
        } catch (error) {
          if (requestEpoch !== epoch.current) return;
          if (error instanceof RequestError && (error.status === 401 || error.status === 403)) {
            disconnect('Device authorization failed. Reconnect with valid KDS credentials.');
            return;
          }
          setQueueError(
            error instanceof RequestError
              ? error.message
              : 'Queue refresh failed. Retrying automatically.'
          );
        } finally {
          if (requestEpoch === epoch.current) setLoading(false);
        }
      })();
      queueFlight.current = flight;
      try {
        await flight;
      } finally {
        if (queueFlight.current === flight) queueFlight.current = null;
      }
    },
    [disconnect]
  );

  useEffect(() => {
    if (!runtime) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await loadQueue(runtime, cursor.current ?? undefined);
      if (!stopped) timer = setTimeout(() => void poll(), 5_000);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [loadQueue, runtime]);

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = deviceSecret.trim();
    const operatorId = operatorStaffProfileId.trim();
    if (!secret || !operatorId) return;
    epoch.current += 1;
    cursor.current = null;
    setQueue(null);
    setQueueError(null);
    setNotice(null);
    setLoading(true);
    setRuntime({ deviceSecret: secret, operatorStaffProfileId: operatorId });
    setDeviceSecret('');
    setOperatorStaffProfileId('');
  }

  function keyFor(intent: string) {
    const existing = idempotencyKeys.current.get(intent);
    if (existing) return existing;
    const key = crypto.randomUUID();
    idempotencyKeys.current.set(intent, key);
    return key;
  }

  async function mutate(item: QueueItem) {
    if (!runtime || pendingMutation.current) return;
    const action = ACTIONS[item.displayStatus];
    const intent = `${action.path}:${item.orderItemId}`;
    pendingMutation.current = true;
    setPending(intent);
    setNotice(null);
    try {
      await request(`/api/restaurant/kds/${action.path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${runtime.deviceSecret}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': keyFor(intent),
        },
        body: JSON.stringify({
          orderItemId: item.orderItemId,
          operatorStaffProfileId: runtime.operatorStaffProfileId,
        }),
      });
      idempotencyKeys.current.delete(intent);
      setNotice({ tone: 'success', message: action.success });
      await loadQueue(runtime);
    } catch (error) {
      if (error instanceof RequestError) idempotencyKeys.current.delete(intent);
      if (error instanceof RequestError && (error.status === 401 || error.status === 403)) {
        disconnect('Device authorization failed. Reconnect with valid KDS credentials.');
      } else {
        setNotice({
          tone: error instanceof RequestError ? 'danger' : 'warning',
          message:
            error instanceof RequestError
              ? error.message
              : 'Network request failed. Retry this action.',
        });
      }
    } finally {
      pendingMutation.current = false;
      setPending(null);
    }
  }

  const busy = loading || pending !== null;
  const shellStatus = !runtime
    ? 'disconnected'
    : loading
      ? 'loading'
      : queueError
        ? 'error'
        : 'active';
  const shellTone: StatusTone = !runtime
    ? 'neutral'
    : loading || queueError
      ? 'warning'
      : 'success';

  if (!runtime) {
    return (
      <KdsShell status={shellStatus} tone={shellTone} busy={busy}>
        <div className="mx-auto max-w-xl space-y-6">
          <PageHeader
            eyebrow="Restaurant KDS"
            heading="Connect kitchen display"
            description="Enter this display's device secret and the acting operator. Credentials stay in memory only."
          />
          {notice ? <Notice notice={notice} /> : null}
          <SectionCard title="Display connection">
            <form onSubmit={connect} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="kds-device-secret">Bearer device secret</Label>
                <Input
                  id="kds-device-secret"
                  type="password"
                  required
                  autoComplete="off"
                  value={deviceSecret}
                  onChange={(event) => setDeviceSecret(event.target.value)}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="kds-operator-id">Acting operator profile ID</Label>
                <Input
                  id="kds-operator-id"
                  required
                  autoComplete="off"
                  value={operatorStaffProfileId}
                  onChange={(event) => setOperatorStaffProfileId(event.target.value)}
                  className="h-11"
                />
              </div>
              <Button
                type="submit"
                disabled={!deviceSecret.trim() || !operatorStaffProfileId.trim()}
                className="h-11 w-full"
              >
                Connect display
              </Button>
            </form>
          </SectionCard>
        </div>
      </KdsShell>
    );
  }

  return (
    <KdsShell status={shellStatus} tone={shellTone} busy={busy}>
      <div className="min-w-0 space-y-4">
        <PageHeader
          eyebrow="Restaurant KDS"
          heading="Kitchen floor"
          description={
            queue
              ? `Station ${queue.stationId} · business date ${queue.businessDate}`
              : 'Loading the station queue.'
          }
          actions={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <StatusPill status="active" label={`Operator ${runtime.operatorStaffProfileId}`} />
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={busy}
                onClick={() => disconnect()}
              >
                Disconnect
              </Button>
            </div>
          }
        />

        {queueError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3"
          >
            <p className="text-sm text-text-body">{queueError}</p>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={busy}
              onClick={() => void loadQueue(runtime, cursor.current ?? undefined)}
            >
              Retry now
            </Button>
          </div>
        ) : null}
        {notice ? <Notice notice={notice} /> : null}
        {queue?.hasMore ? (
          <Notice
            notice={{
              tone: 'warning',
              message:
                'Queue exceeds the bounded 50-ticket view. Showing the authoritative window.',
            }}
          />
        ) : null}

        {loading ? (
          <LoadingBoard />
        ) : queue ? (
          <>
            {queue.tickets.length === 0 ? (
              <div
                role="status"
                className="rounded-lg border border-border-subtle bg-surface-sunken p-4 text-sm text-text-muted"
              >
                Queue clear. No open kitchen tickets for this station.
              </div>
            ) : null}
            <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              {LANES.map((lane) => {
                const tickets = queue.tickets.filter((ticket) => ticket.displayStatus === lane);
                return (
                  <SectionCard
                    key={lane}
                    title={lane}
                    className="min-w-0 p-4"
                    actions={
                      <StatusPill status={lane} tone={LANE_TONES[lane]} label={tickets.length} />
                    }
                  >
                    {tickets.length === 0 ? (
                      <p className="text-sm text-text-muted">No {lane.toLowerCase()} tickets.</p>
                    ) : (
                      <div className="space-y-3">
                        {tickets.map((ticket) => (
                          <TicketCard
                            key={ticket.ticketId}
                            ticket={ticket}
                            pending={pending !== null}
                            onAction={mutate}
                          />
                        ))}
                      </div>
                    )}
                  </SectionCard>
                );
              })}
            </div>
          </>
        ) : (
          <SectionCard title="Queue unavailable">
            <p className="text-sm text-text-muted">
              No queue data is available yet. Automatic polling will retry.
            </p>
          </SectionCard>
        )}
      </div>
    </KdsShell>
  );
}

function TicketCard({
  ticket,
  pending,
  onAction,
}: {
  ticket: QueueTicket;
  pending: boolean;
  onAction: (item: QueueItem) => void;
}) {
  const createdAt = new Date(ticket.createdAt);
  return (
    <article className="min-w-0 rounded-md border border-border-subtle bg-surface-raised p-3">
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle pb-3">
        <div className="min-w-0">
          <h4 className="truncate font-display text-lg font-semibold tracking-tight text-text-strong">
            Ticket {ticket.ticketNumber}
          </h4>
          <p className="font-mono text-xs text-text-muted">Order #{ticket.orderNumber}</p>
        </div>
        <div className="shrink-0 text-right font-mono text-xs tabular-nums text-text-muted">
          <time dateTime={ticket.createdAt} title={createdAt.toLocaleString()}>
            {formatAge(ticket.createdAt)}
          </time>
          <p>{TIME_FORMATTER.format(createdAt)}</p>
        </div>
      </div>
      <div className="divide-y divide-border-subtle">
        {ticket.items.map((item) => {
          const action = ACTIONS[item.displayStatus];
          return (
            <div key={item.orderItemId} className="min-w-0 space-y-3 py-3 last:pb-0">
              <div className="flex min-w-0 items-start gap-3">
                <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-text-strong">
                  {item.quantity}×
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-semibold text-text-strong">{item.name}</p>
                  <p className="font-mono text-[0.6875rem] text-text-muted">
                    Course {item.course}
                    {item.seatNumber === null ? '' : ` · Seat ${item.seatNumber}`}
                  </p>
                </div>
                <StatusPill
                  status={item.displayStatus}
                  tone={LANE_TONES[item.displayStatus]}
                  className="shrink-0"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full"
                disabled={pending}
                aria-label={`${action.label} ${item.name} for order ${ticket.orderNumber}`}
                onClick={() => onAction(item)}
              >
                {action.label}
              </Button>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function LoadingBoard() {
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
      aria-label="Loading kitchen queue"
    >
      {LANES.map((lane) => (
        <SectionCard key={lane} title={lane} className="min-w-0 p-4">
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

function KdsShell({
  status,
  tone,
  busy,
  children,
}: {
  status: string;
  tone: StatusTone;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <div className="studio-viewport h-dvh overflow-hidden text-text-strong">
      <a
        href="#kds-main"
        className="sr-only fixed top-3 left-3 z-50 rounded-[3px] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only"
      >
        Skip to kitchen display
      </a>
      <div className="studio-shell flex h-full min-w-0 flex-col overflow-hidden">
        <header className="studio-topbar flex min-h-[76px] items-center gap-3 border-b border-border-subtle bg-card px-4 sm:px-6 xl:px-8">
          <FathomMark className="size-10" variant="brand" />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold tracking-[-0.03em] text-text-strong">
              DevFathom
            </p>
            <p className="truncate text-xs text-text-muted">Restaurant KDS</p>
          </div>
          <div className="ml-auto shrink-0" aria-live="polite">
            <StatusPill status={status} tone={tone} />
          </div>
        </header>
        <main
          id="kds-main"
          aria-busy={busy}
          className="studio-canvas relative min-h-0 flex-1 overflow-y-auto"
        >
          <div className="studio-stage mx-auto min-h-full w-full max-w-[1800px] px-4 py-5 sm:px-6 sm:py-7 xl:px-8 xl:pb-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function Notice({ notice }: { notice: NoticeState }) {
  return (
    <div
      role={notice.tone === 'success' ? 'status' : 'alert'}
      aria-live="polite"
      className={`flex items-center gap-3 rounded-lg border p-3 ${
        notice.tone === 'danger'
          ? 'border-destructive/30 bg-destructive/10'
          : notice.tone === 'warning'
            ? 'border-warning/30 bg-warning/10'
            : notice.tone === 'success'
              ? 'border-success/30 bg-success/10'
              : 'border-border-subtle bg-surface-sunken'
      }`}
    >
      <StatusPill status={notice.tone} tone={notice.tone} />
      <p className="min-w-0 text-sm text-text-body">{notice.message}</p>
    </div>
  );
}
