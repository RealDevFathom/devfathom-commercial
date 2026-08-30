'use client';

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { CheckoutPanel, type TerminalRequest, type TerminalRequestOptions } from './checkout-panel';
import { DrawerPanel } from './drawer-panel';
import { DayClosePanel } from './day-close-panel';
import { MenuGrid, type AddMenuItemInput, type EffectiveMenu } from './menu-grid';
import { OperatorSwitch, type OperatorSwitchInput } from './operator-switch';
import { RefundPanel } from './refund-panel';
import { OrderTicketPanel, type OrderDetail, type VoidItemInput } from './order-ticket-panel';
import { FathomMark } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { OPERATIONAL_ORDER_CHANNELS, type OrderChannel } from '@/lib/restaurant/order-channels';

type Channel = OrderChannel;
type Runtime = {
  deviceId: string;
  deviceName: string;
  sessionToken: string;
  sessionId: string;
  state: 'LOCKED' | 'UNLOCKED';
  branchName: string;
  operator: OperatorOption | null;
};
type OperatorOption = {
  staffProfileId: string;
  displayName: string;
  role: string;
  canApprove: boolean;
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
  device: { id: string; name: string; branchName: string };
};
type SessionResponse = {
  session: { id: string; state: 'LOCKED' | 'UNLOCKED'; activeStaffProfileId: string | null };
};
type LocalDraftLine = AddMenuItemInput & { lineId: string; name: string; quotedUnitPrice: string };
type TerminalLayout = {
  floors: Array<{
    id: string;
    name: string;
    tables: Array<{
      id: string;
      code: string;
      capacity: number;
      occupied: boolean;
      activeOrderIds: string[];
    }>;
  }>;
  sections: Array<{ id: string; name: string }>;
};

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function isDefinitiveMutationFailure(error: unknown) {
  return (
    error instanceof RequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
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
    credentials: 'include',
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new RequestError(response.status, messageFrom(body));
  return body as T;
}

function authHeaders(runtime: Runtime, json = false): HeadersInit {
  return {
    'X-Terminal-Session': runtime.sessionToken,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function effectiveMenuPath(channel: Channel, publicationId?: string | null) {
  const query = new URLSearchParams({ channel });
  if (publicationId) query.set('publicationId', publicationId);
  return `/api/restaurant/orders/effective-menu?${query}`;
}

export function OrderPad() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [enrollmentState, setEnrollmentState] = useState<'checking' | 'ready' | 'missing'>(
    'checking'
  );
  const [operators, setOperators] = useState<OperatorOption[]>([]);
  const [operatorId, setOperatorId] = useState('');
  const [operatorDirectoryState, setOperatorDirectoryState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [operatorPin, setOperatorPin] = useState('');
  const [channel, setChannel] = useState<Channel>('DINE_IN');
  const [tableIds, setTableIds] = useState<string[]>([]);
  const [covers, setCovers] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [layout, setLayout] = useState<TerminalLayout | null>(null);
  const [layoutState, setLayoutState] = useState<'idle' | 'loading' | 'ready' | 'error' | 'denied'>(
    'idle'
  );
  const [draftMenu, setDraftMenu] = useState<EffectiveMenu | null>(null);
  const [orderMenu, setOrderMenu] = useState<EffectiveMenu | null>(null);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [draftLines, setDraftLines] = useState<LocalDraftLine[]>([]);
  const [checkoutOrderId, setCheckoutOrderId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());
  const stateEpoch = useRef(0);

  const loadOperators = useCallback(async (activeRuntime: Runtime) => {
    setOperatorDirectoryState('loading');
    try {
      const data = await request<{ operators: OperatorOption[] }>(
        '/api/restaurant/terminal/operators',
        { headers: authHeaders(activeRuntime) }
      );
      setOperators(data.operators);
      setOperatorId((current) =>
        data.operators.some((operator) => operator.staffProfileId === current)
          ? current
          : (data.operators[0]?.staffProfileId ?? '')
      );
      setOperatorDirectoryState('ready');
    } catch {
      setOperators([]);
      setOperatorId('');
      setOperatorDirectoryState('error');
    }
  }, []);

  const loadLayout = useCallback(async (activeRuntime: Runtime) => {
    setLayoutState('loading');
    try {
      const data = await request<TerminalLayout>('/api/restaurant/terminal/layout', {
        headers: authHeaders(activeRuntime),
      });
      setLayout(data);
      setLayoutState('ready');
    } catch (error) {
      setLayout(null);
      setLayoutState(error instanceof RequestError && error.status === 403 ? 'denied' : 'error');
    }
  }, []);

  const clearTerminalState = useCallback(() => {
    stateEpoch.current += 1;
    setRuntime(null);
    setDraftMenu(null);
    setOrderMenu(null);
    setOrder(null);
    setDraftLines([]);
    setCheckoutOrderId(null);
    setOpenOrders([]);
    setOperators([]);
    setOperatorId('');
    setOperatorDirectoryState('idle');
    setLayout(null);
    setLayoutState('idle');
    idempotencyKeys.current.clear();
  }, []);

  function keyFor(intent: string) {
    const existing = idempotencyKeys.current.get(intent);
    if (existing) return existing;
    const key = crypto.randomUUID();
    idempotencyKeys.current.set(intent, key);
    return key;
  }

  const checkoutRequest = useCallback<TerminalRequest>(
    async <T,>(path: string, options: TerminalRequestOptions = {}): Promise<T> => {
      if (!runtime || runtime.state !== 'UNLOCKED') {
        throw new RequestError(401, 'An unlocked terminal session is required.');
      }
      const mutation = options.method === 'POST';
      const intent =
        options.intent ??
        `${options.method ?? 'GET'}:${path}:${JSON.stringify(options.body ?? {})}`;
      let idempotencyKey: string | null = null;
      if (mutation) {
        idempotencyKey = idempotencyKeys.current.get(intent) ?? crypto.randomUUID();
        idempotencyKeys.current.set(intent, idempotencyKey);
      }
      try {
        const data = await request<T>(path, {
          method: options.method,
          headers: {
            ...authHeaders(runtime, options.body !== undefined),
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
        if (mutation) idempotencyKeys.current.delete(intent);
        return data;
      } catch (error) {
        if (mutation && isDefinitiveMutationFailure(error)) {
          idempotencyKeys.current.delete(intent);
        }
        if (
          error instanceof RequestError &&
          ((error.status === 403 && /device.+revoked/i.test(error.message)) ||
            (error.status === 401 && /session|device/i.test(error.message)))
        ) {
          clearTerminalState();
          setNotice({ tone: 'danger', message: `Terminal access ended: ${error.message}` });
        }
        throw error;
      }
    },
    [clearTerminalState, runtime]
  );

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof RequestError) {
        const revoked = error.status === 403 && /device.+revoked/i.test(error.message);
        if (revoked) clearTerminalState();
        if (error.status === 401 && /session|device/i.test(error.message)) {
          clearTerminalState();
        }
        setNotice({
          tone: error.status === 403 ? 'danger' : 'warning',
          message: revoked
            ? `Device revoked: ${error.message}`
            : error.status === 403
              ? `Permission denied: ${error.message}`
              : error.message,
        });
        return;
      }
      setNotice({
        tone: 'warning',
        message: 'Network request failed. Retry this action.',
      });
    },
    [clearTerminalState]
  );

  async function loadMenu(nextChannel: Channel, activeRuntime = runtime, standalone = true) {
    if (!activeRuntime) return;
    const epoch = stateEpoch.current;
    if (standalone) setPending('menu');
    try {
      const data = await request<EffectiveMenu>(effectiveMenuPath(nextChannel), {
        headers: authHeaders(activeRuntime),
      });
      if (epoch !== stateEpoch.current) return;
      setDraftMenu(data);
      setNotice({ tone: 'success', message: `${data.menu.name} loaded.` });
    } catch (error) {
      if (epoch !== stateEpoch.current) return;
      setDraftMenu(null);
      handleError(error);
    } finally {
      if (standalone) setPending(null);
    }
  }

  async function loadOpenOrders(activeRuntime = runtime, standalone = true) {
    if (!activeRuntime) return;
    const epoch = stateEpoch.current;
    if (standalone) setPending('orders');
    try {
      const data = await request<{ orders: OpenOrder[] }>('/api/restaurant/orders/open-orders', {
        headers: authHeaders(activeRuntime),
      });
      if (epoch !== stateEpoch.current) return;
      setOpenOrders(data.orders);
    } catch (error) {
      if (epoch !== stateEpoch.current) return;
      handleError(error);
    } finally {
      if (standalone) setPending(null);
    }
  }

  async function loadDetail(orderId: string, activeRuntime = runtime, standalone = true) {
    if (!activeRuntime) return;
    const epoch = stateEpoch.current;
    if (standalone) setPending('detail');
    try {
      const data = await request<OrderDetail>(
        `/api/restaurant/orders/detail?orderId=${encodeURIComponent(orderId)}`,
        { headers: authHeaders(activeRuntime) }
      );
      if (epoch !== stateEpoch.current) return;
      setOrder(data);
      setOrderMenu(null);
      const activeMenu = await request<EffectiveMenu>(
        effectiveMenuPath(data.channel as Channel, data.publicationId),
        { headers: authHeaders(activeRuntime) }
      );
      if (epoch !== stateEpoch.current) return;
      setOrderMenu(activeMenu);
      setNotice({ tone: 'success', message: `Order ${data.orderNumber} active.` });
    } catch (error) {
      if (epoch !== stateEpoch.current) return;
      handleError(error);
    } finally {
      if (standalone) setPending(null);
    }
  }

  const establish = useCallback(async () => {
    if (pending) return;
    setPending('establish');
    setNotice(null);
    try {
      const data = await request<EstablishResponse>('/api/restaurant/terminal/establish', {
        method: 'POST',
      });
      const established: Runtime = {
        deviceId: data.device.id,
        deviceName: data.device.name,
        sessionToken: data.sessionToken,
        sessionId: data.session.id,
        state: data.session.state,
        branchName: data.device.branchName,
        operator: null,
      };
      setRuntime(established);
      setEnrollmentState('ready');
      setNotice({ tone: 'success', message: 'Device session established. Unlock to continue.' });
      await loadOperators(established);
    } catch (error) {
      setEnrollmentState('missing');
      handleError(error);
    } finally {
      setPending(null);
    }
  }, [handleError, loadOperators, pending]);

  useEffect(() => {
    if (enrollmentState === 'checking') queueMicrotask(() => void establish());
  }, [enrollmentState, establish]);

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
        operator:
          operators.find(
            (operator) => operator.staffProfileId === data.session.activeStaffProfileId
          ) ?? null,
      };
      setRuntime(unlocked);
      setOperatorPin('');
      setNotice({ tone: 'success', message: 'Terminal unlocked.' });
      await Promise.all([
        loadMenu(channel, unlocked, false),
        loadOpenOrders(unlocked, false),
        loadLayout(unlocked),
      ]);
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
      const locked: Runtime = { ...runtime, state: data.session.state, operator: null };
      setRuntime(locked);
      stateEpoch.current += 1;
      setOperatorId('');
      setOperators([]);
      setOperatorPin('');
      setDraftMenu(null);
      setOrderMenu(null);
      setOrder(null);
      setCheckoutOrderId(null);
      setOpenOrders([]);
      setLayout(null);
      setLayoutState('idle');
      idempotencyKeys.current.clear();
      setNotice({ tone: 'success', message: 'Terminal locked.' });
      await loadOperators(locked);
    } catch (error) {
      handleError(error);
    } finally {
      setPending(null);
    }
  }

  async function switchOperator(input: OperatorSwitchInput) {
    if (!runtime || pending) return false;
    setPending('switch');
    setNotice(null);
    try {
      const data = await request<SessionResponse>('/api/restaurant/terminal/switch', {
        method: 'POST',
        headers: authHeaders(runtime, true),
        body: JSON.stringify(input),
      });
      setRuntime({
        ...runtime,
        operator:
          operators.find(
            (operator) => operator.staffProfileId === data.session.activeStaffProfileId
          ) ?? null,
      });
      setNotice({
        tone: 'success',
        message: 'Operator switched. New actions use the incoming identity.',
      });
      return true;
    } catch (error) {
      handleError(error);
      return false;
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
    if (!runtime || pending) return false;
    const intent = `mutation:${path}:${JSON.stringify(body)}`;
    setPending(path);
    setNotice(null);
    try {
      await request<unknown>(`/api/restaurant/orders/${path}`, {
        method: 'POST',
        headers: {
          ...authHeaders(runtime, true),
          'Idempotency-Key': keyFor(intent),
        },
        body: JSON.stringify(body),
      });
      idempotencyKeys.current.delete(intent);
      setNotice({ tone: 'success', message: success });
      if (refreshOrder && order) await loadDetail(order.id, runtime, false);
      if (!refreshOrder) {
        setOrder(null);
        setOrderMenu(null);
      }
      await Promise.all([loadOpenOrders(runtime, false), loadLayout(runtime)]);
      return true;
    } catch (error) {
      if (isDefinitiveMutationFailure(error)) idempotencyKeys.current.delete(intent);
      handleError(error);
      return false;
    } finally {
      setPending(null);
    }
  }

  async function openOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runtime || !draftMenu || pending) return;
    const body = {
      channel,
      publicationId: draftMenu.publicationId,
      ...(channel === 'DINE_IN' && tableIds.length ? { tableIds } : {}),
      ...(covers ? { coverCount: Number.parseInt(covers, 10) } : {}),
      ...(channel === 'DINE_IN' && sectionId ? { sectionId } : {}),
    };
    const intent = `open:${JSON.stringify(body)}`;
    setPending('open');
    setNotice(null);
    try {
      const data = await request<{ orderId: string; orderNumber: number }>(
        '/api/restaurant/orders/open',
        {
          method: 'POST',
          headers: {
            ...authHeaders(runtime, true),
            'Idempotency-Key': keyFor(intent),
          },
          body: JSON.stringify(body),
        }
      );
      idempotencyKeys.current.delete(intent);
      for (const line of draftLines) {
        await request('/api/restaurant/orders/add-item', {
          method: 'POST',
          headers: {
            ...authHeaders(runtime, true),
            'Idempotency-Key': keyFor(`draft-line:${line.lineId}`),
          },
          body: JSON.stringify({
            orderId: data.orderId,
            menuItemId: line.menuItemId,
            quantity: line.quantity,
            course: line.course,
            seatNumber: line.seatNumber,
            modifierOptionIds: line.modifierOptionIds,
          }),
        });
        idempotencyKeys.current.delete(`draft-line:${line.lineId}`);
      }
      setDraftLines([]);
      setNotice({ tone: 'success', message: `Order ${data.orderNumber} opened.` });
      await Promise.all([
        loadDetail(data.orderId, runtime, false),
        loadOpenOrders(runtime, false),
        loadLayout(runtime),
      ]);
    } catch (error) {
      if (isDefinitiveMutationFailure(error)) idempotencyKeys.current.delete(intent);
      handleError(error);
    } finally {
      setPending(null);
    }
  }

  async function closeForPayment() {
    const activeOrder = order;
    if (!activeOrder || pending) return;
    if (activeOrder.status === 'PAYMENT_PENDING') {
      setCheckoutOrderId(activeOrder.id);
      return;
    }
    if (await mutate('close', { orderId: activeOrder.id }, 'Order ready for payment.')) {
      setCheckoutOrderId(activeOrder.id);
    }
  }

  const busy = pending !== null;

  if (!runtime) {
    return (
      <PosShell status="not enrolled" tone="neutral" busy={busy}>
        <div className="mx-auto max-w-xl space-y-6">
          <PageHeader
            eyebrow={<span className="text-text-strong">Restaurant POS</span>}
            heading={enrollmentState === 'checking' ? 'Checking enrollment' : 'Enrollment required'}
            description={
              <span className="text-text-body">
                {enrollmentState === 'checking'
                  ? 'Verifying this browser with the server.'
                  : 'Ask an administrator to enroll this browser from Restaurant Devices.'}
              </span>
            }
          />
          {notice ? <Notice notice={notice} /> : null}
          <SectionCard
            title={enrollmentState === 'checking' ? 'Verifying browser' : 'Not enrolled'}
          >
            <div className="space-y-4">
              <p className="text-sm leading-6 text-text-muted">
                {enrollmentState === 'checking'
                  ? 'Please wait while the terminal credential is revalidated.'
                  : 'No usable browser enrollment was found. It may be missing, expired, or revoked.'}
              </p>
              {enrollmentState === 'missing' ? (
                <a
                  href="/login?callbackUrl=%2Frestaurant%2Fdevices"
                  className="inline-flex h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Return to admin-assisted enrollment
                </a>
              ) : null}
            </div>
          </SectionCard>
        </div>
      </PosShell>
    );
  }

  if (runtime.state === 'LOCKED') {
    return (
      <PosShell status="locked" tone="warning" busy={busy}>
        <div className="mx-auto max-w-xl space-y-6">
          <PageHeader
            eyebrow="Restaurant POS"
            heading="Terminal locked"
            description={`${runtime.deviceName} · ${runtime.branchName}`}
          />
          {notice ? <Notice notice={notice} /> : null}
          <SectionCard
            title="Unlock terminal"
            actions={<StatusPill status="locked" tone="warning" />}
          >
            <form onSubmit={unlock} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="operator-id">Operator</Label>
                <select
                  id="operator-id"
                  required
                  autoComplete="username"
                  value={operatorId}
                  onChange={(event) => setOperatorId(event.target.value)}
                  disabled={busy || operatorDirectoryState !== 'ready' || operators.length === 0}
                  className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                >
                  <option value="">
                    {operatorDirectoryState === 'loading'
                      ? 'Loading operators…'
                      : operators.length === 0
                        ? 'No eligible operators'
                        : 'Choose an operator'}
                  </option>
                  {operators.map((operator) => (
                    <option key={operator.staffProfileId} value={operator.staffProfileId}>
                      {operator.displayName} — {operator.role}
                    </option>
                  ))}
                </select>
                {operatorDirectoryState === 'error' ? (
                  <div className="flex items-center justify-between gap-3 text-sm text-text-muted">
                    <span role="alert">Operators could not be loaded.</span>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void loadOperators(runtime)}
                      className="h-11"
                    >
                      Retry
                    </Button>
                  </div>
                ) : operatorDirectoryState === 'ready' && operators.length === 0 ? (
                  <p className="text-sm text-text-muted" role="status">
                    No active operators are assigned to this branch. Ask a manager for access.
                  </p>
                ) : null}
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
      </PosShell>
    );
  }

  return (
    <PosShell status="active" tone="success" busy={busy}>
      <div className="mx-auto max-w-[1600px] space-y-4">
        <PageHeader
          eyebrow="Restaurant POS"
          heading="Order pad"
          description="Live menu, open checks, kitchen pacing, and table service."
          actions={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <StatusPill
                status="active"
                label={
                  runtime.operator
                    ? `${runtime.operator.displayName} · ${runtime.operator.role}`
                    : 'Operator active'
                }
              />
              <OperatorSwitch
                activeOperatorId={runtime.operator?.staffProfileId ?? ''}
                operators={operators}
                pending={busy}
                onSwitch={switchOperator}
              />
              <DrawerPanel request={checkoutRequest} disabled={busy} />
              <DayClosePanel
                request={checkoutRequest}
                actingOperatorId={runtime.operator?.staffProfileId ?? ''}
                operators={operators
                  .map((operator) => ({
                    id: operator.staffProfileId,
                    displayName: operator.displayName,
                    role: operator.role,
                  }))
                  .filter((operator) =>
                    operators.some(
                      (source) => source.staffProfileId === operator.id && source.canApprove
                    )
                  )}
                disabled={busy}
              />
              <RefundPanel
                request={checkoutRequest}
                actingOperatorId={runtime.operator?.staffProfileId ?? ''}
                operators={operators
                  .filter((operator) => operator.canApprove)
                  .map((operator) => ({
                    id: operator.staffProfileId,
                    displayName: operator.displayName,
                    role: operator.role,
                  }))}
                disabled={busy}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void lock()}
                disabled={busy}
                className="h-11"
              >
                {pending === 'lock' ? 'Locking…' : 'Lock terminal'}
              </Button>
            </div>
          }
        />
        {pending ? (
          <Notice notice={{ tone: 'warning', message: 'Request pending. Controls are paused.' }} />
        ) : notice ? (
          <Notice notice={notice} />
        ) : null}

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
                      if (next !== 'DINE_IN') {
                        setTableIds([]);
                        setSectionId('');
                      }
                      void loadMenu(next);
                    }}
                    className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  >
                    {OPERATIONAL_ORDER_CHANNELS.map((value) => (
                      <option key={value} value={value}>
                        {value === 'DINE_IN' ? 'Dine in' : 'Takeaway'}
                      </option>
                    ))}
                    <option value="DELIVERY" disabled>
                      Delivery — not configured
                    </option>
                  </select>
                </div>
                {channel === 'DINE_IN' ? (
                  <div className="space-y-3">
                    {layoutState === 'loading' ? (
                      <p className="text-sm text-text-muted">Loading floor tables…</p>
                    ) : null}
                    {layoutState === 'error' ? (
                      <p role="alert" className="text-sm text-destructive">
                        Floor plan unavailable. Check the connection and retry.
                      </p>
                    ) : null}
                    {layoutState === 'denied' ? (
                      <p role="alert" className="text-sm text-destructive">
                        Permission denied for the floor plan.
                      </p>
                    ) : null}
                    {layoutState === 'ready' &&
                    layout?.floors.every((floor) => floor.tables.length === 0) ? (
                      <p className="text-sm text-text-muted">
                        No active tables are configured for this branch.
                      </p>
                    ) : null}
                    {layout?.floors.map((floor) => (
                      <fieldset
                        key={floor.id}
                        className="space-y-2 rounded-lg border border-border-subtle p-3"
                      >
                        <legend className="px-1 text-sm font-semibold text-text-strong">
                          {floor.name}
                        </legend>
                        <div className="grid grid-cols-2 gap-2">
                          {floor.tables.map((table) => (
                            <label
                              key={table.id}
                              className="flex min-h-11 items-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={tableIds.includes(table.id)}
                                disabled={busy || table.occupied}
                                onChange={() =>
                                  setTableIds((current) =>
                                    current.includes(table.id)
                                      ? current.filter((id) => id !== table.id)
                                      : [...current, table.id]
                                  )
                                }
                              />
                              <span>{table.code}</span>
                              <span className="ml-auto text-xs text-text-muted">
                                {table.occupied ? 'Occupied' : `${table.capacity} seats`}
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}
                  </div>
                ) : null}
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
                  {channel === 'DINE_IN' ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="order-section">Floor section</Label>
                      <select
                        id="order-section"
                        value={sectionId}
                        onChange={(event) => setSectionId(event.target.value)}
                        disabled={busy || layoutState !== 'ready'}
                        className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                      >
                        <option value="">No section</option>
                        {layout?.sections.map((section) => (
                          <option key={section.id} value={section.id}>
                            {section.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div />
                  )}
                </div>
                <p className="text-sm text-text-muted">
                  Server: {runtime.operator?.displayName ?? 'Active operator'}
                </p>
                <Button
                  type="submit"
                  aria-label={pending === 'open' ? 'Opening…' : 'Open order'}
                  disabled={busy || !draftMenu?.channelOpen}
                  className="h-11 w-full"
                >
                  {pending === 'open'
                    ? 'Sending…'
                    : `Send order${draftLines.length ? ` (${draftLines.length})` : ''}`}
                </Button>
              </form>
            </SectionCard>

            <SectionCard eyebrow="Local draft" title="Composed order">
              {draftLines.length === 0 ? (
                <p className="text-sm text-text-muted">
                  Tap menu items to compose. Nothing is sent until Send order.
                </p>
              ) : (
                <div className="space-y-2">
                  {draftLines.map((line) => (
                    <div
                      key={line.lineId}
                      className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border-subtle px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-sm">
                        {line.quantity} × {line.name}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9"
                        disabled={busy}
                        onClick={() =>
                          setDraftLines((current) =>
                            current.filter((item) => item.lineId !== line.lineId)
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="destructive"
                    className="h-11 w-full"
                    disabled={busy}
                    onClick={() => setDraftLines([])}
                  >
                    Discard draft
                  </Button>
                </div>
              )}
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
                      <span className="truncate">
                        #{openOrder.orderNumber} · {openOrder.itemCount} items
                      </span>
                      <span className="shrink-0 font-mono text-xs">{openOrder.subtotal}</span>
                    </Button>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <div className="grid min-w-0 gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <MenuGrid
              menu={order ? orderMenu : draftMenu}
              pending={busy}
              onAdd={(input: AddMenuItemInput) => {
                if (!order) {
                  const item = draftMenu?.sections
                    .flatMap((section) => section.items)
                    .find((candidate) => candidate.id === input.menuItemId);
                  if (!item?.price) return;
                  const quotedUnitPrice = item.price;
                  setDraftLines((current) => [
                    ...current,
                    {
                      ...input,
                      lineId: crypto.randomUUID(),
                      name: item.displayName ?? item.product.name,
                      quotedUnitPrice,
                    },
                  ]);
                  setNotice({
                    tone: 'success',
                    message: `${item.displayName ?? item.product.name} added locally. No request was sent.`,
                  });
                  return;
                }
                void mutate('add-item', { orderId: order.id, ...input }, 'Item added.');
              }}
            />
            <OrderTicketPanel
              order={order}
              actingOperatorId={runtime.operator?.staffProfileId ?? ''}
              operators={operators.map((operator) => ({
                id: operator.staffProfileId,
                displayName: operator.displayName,
                role: operator.role,
              }))}
              pending={busy}
              tables={layout?.floors.flatMap((floor) =>
                floor.tables.map((table) => ({
                  id: table.id,
                  label: `${floor.name} · ${table.code}`,
                  occupied: table.occupied,
                  activeOrderIds: table.activeOrderIds,
                }))
              )}
              onHold={(course) =>
                order &&
                void mutate('hold', { orderId: order.id, course }, `Course ${course} held.`)
              }
              onFire={(course) =>
                order &&
                void mutate('fire', { orderId: order.id, course }, `Course ${course} fired.`)
              }
              onSend={() =>
                order && void mutate('fire', { orderId: order.id }, 'Order sent to kitchen.')
              }
              onServed={(itemId) =>
                order &&
                void mutate('mark-served', { orderId: order.id, itemId }, 'Item marked served.')
              }
              onRemake={(itemId, reason) =>
                order &&
                void mutate('remake', { orderId: order.id, itemId, reason }, 'Remake requested.')
              }
              onVoid={(input: VoidItemInput) =>
                order
                  ? mutate('void', { orderId: order.id, ...input }, 'Item voided.')
                  : Promise.resolve(false)
              }
              onMove={(fromTableId, toTableId) =>
                order &&
                void mutate(
                  'move-table',
                  { orderId: order.id, fromTableId, toTableId },
                  'Order moved.'
                )
              }
              onMerge={(nextTableIds) =>
                order &&
                void mutate(
                  'merge-tables',
                  { orderId: order.id, tableIds: nextTableIds },
                  'Tables merged.'
                )
              }
              onClose={() => void closeForPayment()}
              onCollectPayment={() => order && setCheckoutOrderId(order.id)}
            />
          </div>
        </div>
      </div>
      <CheckoutPanel
        open={checkoutOrderId !== null}
        orderId={checkoutOrderId}
        request={checkoutRequest}
        onClose={() => setCheckoutOrderId(null)}
      />
    </PosShell>
  );
}

function PosShell({
  status,
  tone,
  busy,
  children,
}: {
  status: string;
  tone: 'success' | 'warning' | 'neutral';
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <div className="studio-viewport h-dvh overflow-hidden text-text-strong">
      <a
        href="#pos-main"
        className="sr-only fixed top-3 left-3 z-50 rounded-[3px] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only"
      >
        Skip to order pad
      </a>
      <div className="studio-shell flex h-full min-w-0 flex-col overflow-hidden">
        <header className="studio-topbar flex min-h-[76px] items-center gap-3 border-b border-border-subtle bg-card px-4 sm:px-6 xl:px-8">
          <FathomMark className="size-10" variant="brand" />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold tracking-[-0.03em] text-text-strong">
              DevFathom
            </p>
            <p className="truncate text-xs text-text-muted">Restaurant POS</p>
          </div>
          <div className="ml-auto shrink-0" aria-live="polite">
            <StatusPill
              status={status}
              tone={tone}
              className={tone === 'neutral' ? '!text-text-strong' : undefined}
            />
          </div>
        </header>
        <main
          id="pos-main"
          aria-busy={busy}
          className="studio-canvas relative min-h-0 flex-1 overflow-y-auto"
        >
          <div className="studio-stage mx-auto min-h-full w-full max-w-[1600px] px-4 py-5 sm:px-6 sm:py-7 xl:px-8 xl:pb-8">
            {children}
          </div>
        </main>
      </div>
    </div>
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
