'use client';

import { type FormEvent, useState } from 'react';

import { MenuGrid, type AddMenuItemInput, type EffectiveMenu } from './menu-grid';
import {
  OrderTicketPanel,
  type OrderDetail,
  type VoidItemInput,
} from './order-ticket-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

type Channel = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
type Runtime = {
  deviceSecret: string;
  sessionToken: string;
  sessionId: string;
  state: 'LOCKED' | 'UNLOCKED';
  branchId: string;
  operatorId: string | null;
};
type OpenOrder = {
  id: string;
  orderNumber: number;
  status: string;
  channel: Channel;
  activeTableIds: string[];
  itemCount: number;
  subtotal: string;
};
type Notice = { tone: 'success' | 'warning' | 'danger' | 'neutral'; message: string };
type EstablishResponse = {
  sessionToken: string;
  session: { id: string; state: 'LOCKED'; establishedAt: string };
  device: { id: string; branchId: string };
};
type SessionResponse = {
  session: { id: string; state: 'LOCKED' | 'UNLOCKED'; activeStaffProfileId: string | null };
};

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

function authHeaders(runtime: Runtime, json = false): HeadersInit {
  return {
    Authorization: `Bearer ${runtime.deviceSecret}`,
    'X-Terminal-Session': runtime.sessionToken,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function splitIds(value: string) {
  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function OrderPad() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [deviceSecret, setDeviceSecret] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [operatorPin, setOperatorPin] = useState('');
  const [channel, setChannel] = useState<Channel>('DINE_IN');
  const [tableIds, setTableIds] = useState('');
  const [covers, setCovers] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [serverId, setServerId] = useState('');
  const [menu, setMenu] = useState<EffectiveMenu | null>(null);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  function handleError(error: unknown) {
    if (error instanceof RequestError) {
      if (error.status === 401 && /session|device/i.test(error.message)) {
        setRuntime(null);
        setMenu(null);
        setOrder(null);
        setOpenOrders([]);
      }
      setNotice({
        tone: error.status === 403 ? 'danger' : 'warning',
        message:
          error.status === 403 ? `Permission denied: ${error.message}` : error.message,
      });
      return;
    }
    setNotice({ tone: 'warning', message: 'Network request failed. No queued change was created.' });
  }

  async function loadMenu(nextChannel: Channel, activeRuntime = runtime) {
    if (!activeRuntime) return;
    setPending('menu');
    try {
      const data = await request<EffectiveMenu>(
        `/api/restaurant/orders/effective-menu?channel=${encodeURIComponent(nextChannel)}`,
        { headers: authHeaders(activeRuntime) }
      );
      setMenu(data);
      setNotice({ tone: 'success', message: `${data.menu.name} loaded.` });
    } catch (error) {
      setMenu(null);
      handleError(error);
    } finally {
      setPending(null);
    }
  }

  async function loadOpenOrders(activeRuntime = runtime) {
    if (!activeRuntime) return;
    try {
      const data = await request<{ orders: OpenOrder[] }>('/api/restaurant/orders/open-orders', {
        headers: authHeaders(activeRuntime),
      });
      setOpenOrders(data.orders);
    } catch (error) {
      handleError(error);
    }
  }

  async function loadDetail(orderId: string, activeRuntime = runtime) {
    if (!activeRuntime) return;
    setPending('detail');
    try {
      const data = await request<OrderDetail>(
        `/api/restaurant/orders/detail?orderId=${encodeURIComponent(orderId)}`,
        { headers: authHeaders(activeRuntime) }
      );
      setOrder(data);
      setNotice({ tone: 'success', message: `Order ${data.orderNumber} active.` });
    } catch (error) {
      handleError(error);
    } finally {
      setPending(null);
    }
  }

  async function establish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = deviceSecret.trim();
    if (!secret || pending) return;
    setPending('establish');
    setNotice(null);
    try {
      const data = await request<EstablishResponse>('/api/restaurant/terminal/establish', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
      });
      setRuntime({
        deviceSecret: secret,
        sessionToken: data.sessionToken,
        sessionId: data.session.id,
        state: data.session.state,
        branchId: data.device.branchId,
        operatorId: null,
      });
      setDeviceSecret('');
      setNotice({ tone: 'success', message: 'Device session established. Unlock to continue.' });
    } catch (error) {
      handleError(error);
    } finally {
      setPending(null);
    }
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runtime || !operatorId.trim() || !/^\d{4,8}$/.test(operatorPin) || pending) return;
    setPending('unlock');
    setNotice(null);
    try {
      const data = await request<SessionResponse>('/api/restaurant/terminal/unlock', {
        method: 'POST',
        headers: authHeaders(runtime, true),
        body: JSON.stringify({
          staffProfileId: operatorId.trim(),
          type: 'PIN',
          secret: operatorPin,
        }),
      });
      const unlocked: Runtime = {
        ...runtime,
        state: data.session.state,
        operatorId: data.session.activeStaffProfileId,
      };
      setRuntime(unlocked);
      setOperatorPin('');
      setNotice({ tone: 'success', message: 'Terminal unlocked.' });
      await Promise.all([loadMenu(channel, unlocked), loadOpenOrders(unlocked)]);
    } catch (error) {
      setOperatorPin('');
      handleError(error);
    } finally {
      setPending(null);
    }
  }

  async function lock() {
    if (!runtime || pending) return;
    setPending('lock');
    try {
      const data = await request<SessionResponse>('/api/restaurant/terminal/lock', {
        method: 'POST',
        headers: authHeaders(runtime),
      });
      setRuntime({ ...runtime, state: data.session.state, operatorId: null });
      setOperatorId('');
      setOperatorPin('');
      setOrder(null);
      setNotice({ tone: 'success', message: 'Terminal locked.' });
    } catch (error) {
      handleError(error);
    } finally {
      setPending(null);
    }
  }

  async function mutate(
    path: string,
    body: Record<string, unknown>,
    success: string,
    refreshOrder = true
  ) {
    if (!runtime || pending) return;
    setPending(path);
    setNotice(null);
    try {
      await request<unknown>(`/api/restaurant/orders/${path}`, {
        method: 'POST',
        headers: {
          ...authHeaders(runtime, true),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      setNotice({ tone: 'success', message: success });
      if (refreshOrder && order) await loadDetail(order.id, runtime);
      await loadOpenOrders(runtime);
    } catch (error) {
      handleError(error);
    } finally {
      setPending(null);
    }
  }

  async function openOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runtime || !menu || pending) return;
    setPending('open');
    setNotice(null);
    try {
      const data = await request<{ orderId: string; orderNumber: number }>(
        '/api/restaurant/orders/open',
        {
          method: 'POST',
          headers: {
            ...authHeaders(runtime, true),
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            channel,
            publicationId: menu.publicationId,
            ...(splitIds(tableIds).length ? { tableIds: splitIds(tableIds) } : {}),
            ...(covers ? { coverCount: Number.parseInt(covers, 10) } : {}),
            ...(sectionId.trim() ? { sectionId: sectionId.trim() } : {}),
            ...(serverId.trim() ? { serverStaffProfileId: serverId.trim() } : {}),
          }),
        }
      );
      setNotice({ tone: 'success', message: `Order ${data.orderNumber} opened.` });
      await Promise.all([loadDetail(data.orderId, runtime), loadOpenOrders(runtime)]);
    } catch (error) {
      handleError(error);
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  if (!runtime) {
    return (
      <main className="min-h-dvh overflow-x-hidden bg-surface-page px-4 py-8 text-text-body sm:px-6">
        <div className="mx-auto max-w-xl space-y-6">
          <PageHeader
            eyebrow="Restaurant POS"
            title="Establish device"
            description="Start a device-authenticated session. Secret stays only in memory."
          />
          {notice ? <Notice notice={notice} /> : null}
          <SectionCard title="Device enrollment">
            <form onSubmit={establish} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="device-secret">Bearer device secret</Label>
                <Input
                  id="device-secret"
                  type="password"
                  required
                  autoComplete="off"
                  value={deviceSecret}
                  onChange={(event) => setDeviceSecret(event.target.value)}
                  className="h-11"
                />
              </div>
              <Button type="submit" disabled={busy || !deviceSecret.trim()} className="h-11 w-full">
                {pending === 'establish' ? 'Establishing…' : 'Establish session'}
              </Button>
            </form>
          </SectionCard>
        </div>
      </main>
    );
  }

  if (runtime.state === 'LOCKED') {
    return (
      <main className="min-h-dvh overflow-x-hidden bg-surface-page px-4 py-8 text-text-body sm:px-6">
        <div className="mx-auto max-w-xl space-y-6">
          <PageHeader
            eyebrow="Restaurant POS"
            title="Terminal locked"
            description={`Device session active for branch ${runtime.branchId}.`}
          />
          {notice ? <Notice notice={notice} /> : null}
          <SectionCard title="Unlock terminal" actions={<StatusPill status="locked" tone="warning" />}>
            <form onSubmit={unlock} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="operator-id">Operator profile ID</Label>
                <Input
                  id="operator-id"
                  required
                  autoComplete="username"
                  value={operatorId}
                  onChange={(event) => setOperatorId(event.target.value)}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="operator-pin">Operator PIN</Label>
                <Input
                  id="operator-pin"
                  type="password"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{4,8}"
                  minLength={4}
                  maxLength={8}
                  autoComplete="current-password"
                  value={operatorPin}
                  onChange={(event) => setOperatorPin(event.target.value.replace(/\D/g, ''))}
                  className="h-11"
                />
              </div>
              <Button
                type="submit"
                disabled={busy || !operatorId.trim() || !/^\d{4,8}$/.test(operatorPin)}
                className="h-11 w-full"
              >
                {pending === 'unlock' ? 'Unlocking…' : 'Unlock terminal'}
              </Button>
            </form>
          </SectionCard>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh overflow-x-hidden bg-surface-page px-4 py-5 text-text-body sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <PageHeader
          eyebrow="Restaurant POS"
          title="Order pad"
          description="Live menu, open checks, kitchen pacing, and table service."
          actions={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <StatusPill status="active" label={`Operator ${runtime.operatorId}`} />
              <Button type="button" variant="outline" onClick={() => void lock()} disabled={busy} className="h-11">
                {pending === 'lock' ? 'Locking…' : 'Lock terminal'}
              </Button>
            </div>
          }
        />
        {notice ? <Notice notice={notice} /> : null}

        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(18rem,0.8fr)_minmax(0,2.2fr)]">
          <div className="min-w-0 space-y-4">
            <SectionCard eyebrow="New check" title="Open order">
              <form onSubmit={openOrder} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="order-channel">Channel</Label>
                  <select
                    id="order-channel"
                    value={channel}
                    disabled={busy}
                    onChange={(event) => {
                      const next = event.target.value as Channel;
                      setChannel(next);
                      void loadMenu(next);
                    }}
                    className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  >
                    <option value="DINE_IN">Dine in</option>
                    <option value="TAKEAWAY">Takeaway</option>
                    <option value="DELIVERY">Delivery</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="order-table-ids">Table IDs</Label>
                  <Input
                    id="order-table-ids"
                    value={tableIds}
                    onChange={(event) => setTableIds(event.target.value)}
                    disabled={channel !== 'DINE_IN'}
                    placeholder="table-id-1, table-id-2"
                    className="h-11"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="order-covers">Covers</Label>
                    <Input
                      id="order-covers"
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={covers}
                      onChange={(event) => setCovers(event.target.value)}
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="order-section">Section ID</Label>
                    <Input
                      id="order-section"
                      value={sectionId}
                      onChange={(event) => setSectionId(event.target.value)}
                      className="h-11"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="order-server">Server profile ID</Label>
                  <Input
                    id="order-server"
                    value={serverId}
                    onChange={(event) => setServerId(event.target.value)}
                    className="h-11"
                  />
                </div>
                <p className="break-all font-mono text-xs text-text-faint">
                  Publication: {menu?.publicationId ?? 'Loading current publication…'}
                </p>
                <Button
                  type="submit"
                  disabled={busy || !menu?.channelOpen}
                  className="h-11 w-full"
                >
                  {pending === 'open' ? 'Opening…' : 'Open order'}
                </Button>
              </form>
            </SectionCard>

            <SectionCard
              eyebrow="Resume"
              title="Open orders"
              actions={
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void loadOpenOrders()}
                  disabled={busy}
                  className="h-11"
                >
                  Refresh
                </Button>
              }
            >
              {openOrders.length === 0 ? (
                <p className="text-sm text-text-muted">No open orders for this branch.</p>
              ) : (
                <div className="space-y-2">
                  {openOrders.map((openOrder) => (
                    <Button
                      key={openOrder.id}
                      type="button"
                      variant={order?.id === openOrder.id ? 'default' : 'outline'}
                      aria-pressed={order?.id === openOrder.id}
                      onClick={() => void loadDetail(openOrder.id)}
                      disabled={busy}
                      className="min-h-11 h-auto w-full min-w-0 justify-between px-3 py-2"
                    >
                      <span className="truncate">#{openOrder.orderNumber} · {openOrder.itemCount} items</span>
                      <span className="shrink-0 font-mono text-xs">{openOrder.subtotal}</span>
                    </Button>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <div className="grid min-w-0 gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <MenuGrid
              menu={menu}
              pending={busy}
              onAdd={(input: AddMenuItemInput) => {
                if (!order) {
                  setNotice({ tone: 'warning', message: 'Open or resume an order before adding items.' });
                  return;
                }
                void mutate('add-item', { orderId: order.id, ...input }, 'Item added.');
              }}
            />
            <OrderTicketPanel
              order={order}
              pending={busy}
              onHold={(course) => order && void mutate('hold', { orderId: order.id, course }, `Course ${course} held.`)}
              onFire={(course) => order && void mutate('fire', { orderId: order.id, course }, `Course ${course} fired.`)}
              onSend={() => order && void mutate('fire', { orderId: order.id }, 'Order sent to kitchen.')}
              onServed={(itemId) => order && void mutate('mark-served', { orderId: order.id, itemId }, 'Item marked served.')}
              onRemake={(itemId, reason) => order && void mutate('remake', { orderId: order.id, itemId, reason }, 'Remake requested.')}
              onVoid={(input: VoidItemInput) => order && void mutate('void', { orderId: order.id, ...input }, 'Item voided.')}
              onMove={(fromTableId, toTableId) => order && void mutate('move-table', { orderId: order.id, fromTableId, toTableId }, 'Order moved.')}
              onMerge={(nextTableIds) => order && void mutate('merge-tables', { orderId: order.id, tableIds: nextTableIds }, 'Tables merged.')}
              onClose={() => order && void mutate('close', { orderId: order.id }, 'Order closed.', false)}
            />
          </div>
        </div>
      </div>
    </main>
  );
}

function Notice({ notice }: { notice: Notice }) {
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
