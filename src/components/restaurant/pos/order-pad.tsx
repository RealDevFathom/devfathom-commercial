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
import { ORDER_CHANNELS, type OrderChannel } from '@/lib/restaurant/order-channels';
import {
  createIndexedDbDriver,
  createMemoryDriver,
  isPosStoreSupported,
  type PosCatalogSnapshot,
} from '@/lib/restaurant/pos-client-store';
import { countQueuedCommands, type PosQueueSnapshot } from '@/lib/restaurant/pos-command-queue';
import { PosOfflineRuntime } from '@/lib/restaurant/pos-offline-runtime';

type Channel = OrderChannel;
type Runtime = {
  organizationId: string;
  branchId: string;
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
  session: {
    id: string;
    state: 'LOCKED' | 'UNLOCKED';
    activeStaffProfileId?: string | null;
    establishedAt: string;
  };
  device: {
    id: string;
    organizationId: string;
    branchId: string;
    name: string;
    branchName: string;
  };
  operator?: OperatorOption;
};
type SessionResponse = {
  session: { id: string; state: 'LOCKED' | 'UNLOCKED'; activeStaffProfileId: string | null };
};
type LocalDraftLine = AddMenuItemInput & { lineId: string; name: string; quotedUnitPrice: string };
type DeliveryCustomer = {
  customerId: string;
  displayName: string | null;
  identifiers: { masked: string }[];
};
type DeliveryAddress = { id: string; label: string; recipientName: string; isDefault: boolean };
type DeliveryZone = {
  id: string;
  name: string;
  areaPostalLabel: string | null;
  fee: string;
  minimumSubtotal: string;
  promisedMinutes: number;
};
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

function isDemoAccessExpiredError(error: unknown) {
  return (
    error instanceof RequestError &&
    error.status === 401 &&
    /^Demo access has expired(?:[.;]|$)/i.test(error.message)
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

function cachedMenu(catalog: PosCatalogSnapshot): EffectiveMenu {
  return {
    version: catalog.version,
    publicationId: catalog.publicationId,
    channelOpen: catalog.channelOpen,
    menu: { id: catalog.menuId, name: catalog.menuName },
    sections: catalog.sections.map((section) => ({
      id: section.sectionId,
      name: section.name,
      items: section.items.map((item) => ({
        id: item.menuItemId,
        displayName: item.name,
        product: { name: item.name },
        price: item.price,
        available: item.available,
      })),
    })),
  };
}

export function OrderPad({ demo = false }: { demo?: boolean }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [enrollmentState, setEnrollmentState] = useState<
    'checking' | 'ready' | 'missing' | 'unrecoverable'
  >('checking');
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
  const [customerQuery, setCustomerQuery] = useState('');
  const [deliveryCustomers, setDeliveryCustomers] = useState<DeliveryCustomer[]>([]);
  const [deliveryCustomer, setDeliveryCustomer] = useState<DeliveryCustomer | null>(null);
  const [deliveryAddresses, setDeliveryAddresses] = useState<DeliveryAddress[]>([]);
  const [deliveryAddressId, setDeliveryAddressId] = useState('');
  const [deliveryZones, setDeliveryZones] = useState<DeliveryZone[]>([]);
  const [deliveryZoneId, setDeliveryZoneId] = useState('');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
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
  const establishing = useRef(false);
  const idempotencyKeys = useRef(new Map<string, string>());
  const stateEpoch = useRef(0);
  const runtimeBoundary = useRef<Runtime | null>(null);
  const deliveryCustomerBoundary = useRef<DeliveryCustomer | null>(null);
  const offlineRuntime = useRef<PosOfflineRuntime | null>(null);
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<PosQueueSnapshot | null>(null);
  const [discardedCount, setDiscardedCount] = useState(0);
  const [revoked, setRevoked] = useState(false);
  const queuedCount = queue ? countQueuedCommands(queue) : 0;
  const reviewDrafts =
    queue?.drafts.filter(
      (draft) => draft.status === 'NEEDS_REVIEW' || draft.status === 'QUARANTINED'
    ) ?? [];

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

  const clearDeliveryState = useCallback((advanceEpoch = true) => {
    if (advanceEpoch) stateEpoch.current += 1;
    setCustomerQuery('');
    setDeliveryCustomers([]);
    setDeliveryCustomer(null);
    deliveryCustomerBoundary.current = null;
    setDeliveryAddresses([]);
    setDeliveryAddressId('');
    setDeliveryZones([]);
    setDeliveryZoneId('');
    setDeliveryInstructions('');
  }, []);

  const clearTerminalState = useCallback(() => {
    stateEpoch.current += 1;
    runtimeBoundary.current = null;
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
    clearDeliveryState(false);
    idempotencyKeys.current.clear();
  }, [clearDeliveryState]);

  const captureDeliveryBoundary = useCallback(
    (activeRuntime: Runtime, customerId: string | null) => ({
      epoch: stateEpoch.current,
      organizationId: activeRuntime.organizationId,
      branchId: activeRuntime.branchId,
      deviceId: activeRuntime.deviceId,
      sessionId: activeRuntime.sessionId,
      operatorId: activeRuntime.operator?.staffProfileId ?? null,
      customerId,
    }),
    []
  );

  const deliveryBoundaryIsCurrent = useCallback(
    (boundary: ReturnType<typeof captureDeliveryBoundary>) => {
      const current = runtimeBoundary.current;
      return (
        boundary.epoch === stateEpoch.current &&
        current?.organizationId === boundary.organizationId &&
        current.branchId === boundary.branchId &&
        current.deviceId === boundary.deviceId &&
        current.sessionId === boundary.sessionId &&
        (current.operator?.staffProfileId ?? null) === boundary.operatorId &&
        (deliveryCustomerBoundary.current?.customerId ?? null) === boundary.customerId
      );
    },
    []
  );

  const syncQueue = useCallback(() => {
    setQueue(offlineRuntime.current?.snapshot().queue ?? null);
  }, []);

  const replayQueue = useCallback(
    async (activeRuntime: Runtime) => {
      const local = offlineRuntime.current;
      if (!local || !navigator.onLine || activeRuntime.state !== 'UNLOCKED') return;
      const result = await local.replay(async (queued) => {
        try {
          const response = await fetch(queued.path, {
            method: queued.method,
            cache: 'no-store',
            credentials: 'include',
            headers: { ...authHeaders(activeRuntime, true), ...queued.headers },
            body: JSON.stringify(queued.body),
            signal: AbortSignal.timeout(10_000),
          });
          const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
          return {
            status: response.status,
            serverMessage: body ? messageFrom(body) : undefined,
            retryAfter: response.headers.get('retry-after'),
            serverRef:
              typeof body?.orderId === 'string'
                ? body.orderId
                : typeof body?.itemId === 'string'
                  ? body.itemId
                  : null,
          };
        } catch {
          return { status: 0 };
        }
      });
      syncQueue();
      if (result.state === 'PAUSED' && local.snapshot().queue?.replay === 'PAUSED_REAUTH') {
        const locked = { ...activeRuntime, state: 'LOCKED' as const, operator: null };
        setRuntime(locked);
        runtimeBoundary.current = locked;
        clearDeliveryState();
        setOperatorPin('');
        setNotice({
          tone: 'warning',
          message: 'Queued orders are paused. Reauthenticate to resume replay.',
        });
      }
      if (result.discarded) {
        setDiscardedCount(result.discarded.drafts);
        setRevoked(true);
        clearTerminalState();
        setNotice({
          tone: 'danger',
          message: `Device revoked. ${result.discarded.drafts} queued order(s) were discarded.`,
        });
      }
    },
    [clearDeliveryState, clearTerminalState, syncQueue]
  );

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
        if (demo && isDemoAccessExpiredError(error)) {
          clearTerminalState();
          setEnrollmentState('missing');
          setNotice({
            tone: 'danger',
            message: 'Demo access expired. Reopen the restaurant demo.',
          });
        } else if (
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
    [clearTerminalState, demo, runtime]
  );

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof RequestError) {
        if (demo && isDemoAccessExpiredError(error)) {
          clearTerminalState();
          setEnrollmentState('missing');
          setNotice({
            tone: 'danger',
            message: 'Demo access expired. Reopen the restaurant demo.',
          });
          return;
        }
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
    [clearTerminalState, demo]
  );

  const loadMenu = useCallback(
    async (nextChannel: Channel, activeRuntime = runtime, standalone = true) => {
      if (!activeRuntime) return;
      const epoch = stateEpoch.current;
      if (standalone) setPending('menu');
      try {
        const data = await request<EffectiveMenu>(effectiveMenuPath(nextChannel), {
          headers: authHeaders(activeRuntime),
        });
        if (epoch !== stateEpoch.current) return;
        setDraftMenu(data);
        await offlineRuntime.current?.cacheCatalog(data, new Date().toISOString());
        syncQueue();
        setNotice({ tone: 'success', message: `${data.menu.name} loaded.` });
      } catch (error) {
        if (epoch !== stateEpoch.current) return;
        const catalog = offlineRuntime.current?.snapshot().catalog;
        if (catalog?.channel === nextChannel) {
          setDraftMenu(cachedMenu(catalog));
          setNotice({ tone: 'warning', message: 'Using the cached catalog while offline.' });
        } else {
          setDraftMenu(null);
          handleError(error);
        }
      } finally {
        if (standalone) setPending(null);
      }
    },
    [handleError, runtime, syncQueue]
  );

  const loadOpenOrders = useCallback(
    async (activeRuntime = runtime, standalone = true) => {
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
    },
    [handleError, runtime]
  );

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
      if (standalone) setNotice({ tone: 'success', message: `Order ${data.orderNumber} active.` });
    } catch (error) {
      if (epoch !== stateEpoch.current) return;
      handleError(error);
    } finally {
      if (standalone) setPending(null);
    }
  }

  const loadUnlockedWorkspace = useCallback(
    async (activeRuntime: Runtime) => {
      await Promise.all([
        loadMenu(channel, activeRuntime, false),
        loadOpenOrders(activeRuntime, false),
        loadLayout(activeRuntime),
      ]);
      await replayQueue(activeRuntime);
    },
    [channel, loadLayout, loadMenu, loadOpenOrders, replayQueue]
  );

  const establish = useCallback(async () => {
    if (establishing.current || pending) return;
    establishing.current = true;
    setPending('establish');
    setNotice(null);
    try {
      const data = await request<EstablishResponse>(
        demo ? '/demo/restaurants/device-session' : '/api/restaurant/terminal/establish',
        {
          method: 'POST',
          ...(demo
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'POS' }),
              }
            : {}),
        }
      );
      const established: Runtime = {
        organizationId: data.device.organizationId,
        branchId: data.device.branchId,
        deviceId: data.device.id,
        deviceName: data.device.name,
        sessionToken: data.sessionToken,
        sessionId: data.session.id,
        state: data.session.state,
        branchName: data.device.branchName,
        operator: data.operator ?? null,
      };
      offlineRuntime.current?.close();
      const local = new PosOfflineRuntime(
        {
          organizationId: established.organizationId,
          branchId: established.branchId,
          deviceId: established.deviceId,
        },
        isPosStoreSupported() ? createIndexedDbDriver() : createMemoryDriver()
      );
      offlineRuntime.current = local;
      const hydration = await local.hydrate();
      if (hydration === 'unrecoverable') {
        local.close();
        offlineRuntime.current = null;
        setEnrollmentState('unrecoverable');
        setNotice({
          tone: 'danger',
          message:
            'Local POS data could not be recovered. Re-enroll or clear site data to continue.',
        });
        return;
      }
      syncQueue();
      setRuntime(established);
      runtimeBoundary.current = established;
      setEnrollmentState('ready');
      setNotice({
        tone: 'success',
        message: data.operator
          ? `Demo terminal ready as ${data.operator.displayName}.`
          : 'Device session established. Unlock to continue.',
      });
      await loadOperators(established);
      if (established.state === 'UNLOCKED') await loadUnlockedWorkspace(established);
    } catch (error) {
      setEnrollmentState('missing');
      handleError(error);
    } finally {
      establishing.current = false;
      setPending(null);
    }
  }, [demo, handleError, loadOperators, loadUnlockedWorkspace, pending, syncQueue]);

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
      runtimeBoundary.current = unlocked;
      await offlineRuntime.current?.resume();
      setOperatorPin('');
      setNotice({ tone: 'success', message: 'Terminal unlocked.' });
      await loadUnlockedWorkspace(unlocked);
    } catch (error) {
      setOperatorPin('');
      handleError(error);
    } finally {
      setPending(null);
    }
  }

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine && runtime?.state === 'UNLOCKED') void replayQueue(runtime);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') update();
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [replayQueue, runtime]);

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
      runtimeBoundary.current = locked;
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
      clearDeliveryState();
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
      const switched: Runtime = {
        ...runtime,
        operator:
          operators.find(
            (operator) => operator.staffProfileId === data.session.activeStaffProfileId
          ) ?? null,
      };
      setRuntime(switched);
      runtimeBoundary.current = switched;
      clearDeliveryState();
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
      ...(channel === 'DELIVERY' && deliveryCustomer
        ? { customerId: deliveryCustomer.customerId }
        : {}),
      ...(channel === 'DINE_IN' && tableIds.length ? { tableIds } : {}),
      ...(covers ? { coverCount: Number.parseInt(covers, 10) } : {}),
      ...(channel === 'DINE_IN' && sectionId ? { sectionId } : {}),
    };
    setPending('open');
    setNotice(null);
    try {
      if (channel === 'DELIVERY') {
        if (!navigator.onLine)
          throw new Error('Delivery orders require a connection and cannot be saved offline.');
        if (!deliveryCustomer || !deliveryAddressId || !deliveryZoneId)
          throw new Error('Select a customer, saved address, and active delivery zone.');
        if (draftLines.length === 0)
          throw new Error('Add at least one item before sending delivery.');
        const intent = `delivery-open:${JSON.stringify(body)}`;
        const opened = await request<{ orderId: string; orderNumber: number }>(
          '/api/restaurant/orders/open',
          {
            method: 'POST',
            headers: { ...authHeaders(runtime, true), 'Idempotency-Key': keyFor(intent) },
            body: JSON.stringify(body),
          }
        );
        for (const line of draftLines) {
          const lineBody = {
            orderId: opened.orderId,
            menuItemId: line.menuItemId,
            quantity: line.quantity,
            course: line.course,
            seatNumber: line.seatNumber,
            modifierOptionIds: line.modifierOptionIds,
          };
          await request('/api/restaurant/orders/add-item', {
            method: 'POST',
            headers: {
              ...authHeaders(runtime, true),
              'Idempotency-Key': keyFor(`delivery-line:${opened.orderId}:${line.lineId}`),
            },
            body: JSON.stringify(lineBody),
          });
        }
        await request('/api/restaurant/orders/delivery/attach', {
          method: 'POST',
          headers: {
            ...authHeaders(runtime, true),
            'Idempotency-Key': keyFor(`delivery-attach:${opened.orderId}`),
          },
          body: JSON.stringify({
            orderId: opened.orderId,
            customerId: deliveryCustomer.customerId,
            addressId: deliveryAddressId,
            zoneId: deliveryZoneId,
            ...(deliveryInstructions.trim() ? { instructions: deliveryInstructions.trim() } : {}),
          }),
        });
        idempotencyKeys.current.delete(intent);
        setDraftLines([]);
        clearDeliveryState();
        setNotice({
          tone: 'success',
          message: `Delivery order ${opened.orderNumber} opened and fulfillment attached.`,
        });
        await Promise.all([
          loadDetail(opened.orderId, runtime, false),
          loadOpenOrders(runtime, false),
        ]);
        return;
      }
      if (draftLines.length === 0 && navigator.onLine) {
        const intent = `open:${JSON.stringify(body)}`;
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
        setNotice({ tone: 'success', message: `Order ${data.orderNumber} opened.` });
        await Promise.all([
          loadDetail(data.orderId, runtime, false),
          loadOpenOrders(runtime, false),
          loadLayout(runtime),
        ]);
        return;
      }
      const local = offlineRuntime.current;
      if (!local) throw new Error('Local POS storage is unavailable.');
      const enqueued = await local.enqueue({
        deviceId: runtime.deviceId,
        catalogVersion: draftMenu.version ?? '',
        clientOriginAt: new Date().toISOString(),
        open: body,
        lines: draftLines.map((line) => ({
          menuItemId: line.menuItemId,
          quantity: line.quantity,
          course: line.course,
          seatNumber: line.seatNumber,
          modifierOptionIds: line.modifierOptionIds,
          quotedUnitPrice: line.quotedUnitPrice,
        })),
      });
      if (!enqueued.ok) throw new Error(enqueued.message);
      setDraftLines([]);
      syncQueue();
      setNotice({ tone: 'success', message: 'Order saved to the queue.' });
      await replayQueue(runtime);
      if (navigator.onLine)
        await Promise.all([loadOpenOrders(runtime, false), loadLayout(runtime)]);
    } catch (error) {
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
      <PosShell
        status={revoked ? 'Revoked' : 'not enrolled'}
        tone={revoked ? 'warning' : 'neutral'}
        busy={busy}
      >
        <div className="mx-auto max-w-xl space-y-6">
          <PageHeader
            eyebrow={<span className="text-text-strong">Restaurant POS</span>}
            heading={
              enrollmentState === 'checking'
                ? 'Checking enrollment'
                : enrollmentState === 'unrecoverable'
                  ? 'Local POS recovery required'
                  : demo
                    ? 'Demo entry required'
                    : 'Enrollment required'
            }
            description={
              <span className="text-text-body">
                {enrollmentState === 'checking'
                  ? 'Verifying this browser with the server.'
                  : enrollmentState === 'unrecoverable'
                    ? 'Local POS data could not be safely recovered.'
                    : demo
                      ? 'Reopen the restaurant demo to start a fresh terminal session.'
                      : 'Ask an administrator to enroll this browser from Restaurant Devices.'}
              </span>
            }
          />
          {notice ? <Notice notice={notice} /> : null}
          <SectionCard
            title={
              enrollmentState === 'checking'
                ? 'Verifying browser'
                : enrollmentState === 'unrecoverable'
                  ? 'Recovery required'
                  : 'Not enrolled'
            }
            titleLevel={2}
          >
            <div className="space-y-4">
              <p className="text-sm leading-6 text-text-muted">
                {enrollmentState === 'checking'
                  ? 'Please wait while the terminal credential is revalidated.'
                  : enrollmentState === 'unrecoverable'
                    ? 'The saved offline queue was not opened. Clear site data or re-enroll this browser before continuing.'
                    : demo
                      ? 'This demo terminal no longer has a usable access session.'
                      : 'No usable browser enrollment was found. It may be missing, expired, or revoked.'}
              </p>
              {enrollmentState === 'missing' || enrollmentState === 'unrecoverable' ? (
                <a
                  href={demo ? '/demo/restaurants' : '/login?callbackUrl=%2Frestaurant%2Fdevices'}
                  className="inline-flex h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {demo ? 'Reopen restaurant demo' : 'Return to admin-assisted enrollment'}
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
            titleLevel={2}
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
    <PosShell
      status={online ? 'Online' : 'Offline'}
      tone={online ? 'success' : 'warning'}
      busy={busy}
    >
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
              <StatusPill
                status={online ? 'online' : 'offline'}
                tone={online ? 'success' : 'warning'}
                label={online ? 'Online' : 'Offline'}
              />
              <StatusPill
                status={
                  queue?.replay === 'PAUSED_REAUTH'
                    ? 'reauth'
                    : reviewDrafts.length
                      ? 'needs-review'
                      : queuedCount
                        ? 'queued'
                        : 'queue-empty'
                }
                tone={reviewDrafts.length || queuedCount ? 'warning' : 'neutral'}
                label={
                  queue?.replay === 'PAUSED_REAUTH'
                    ? `Reauth · ${queuedCount} queued`
                    : reviewDrafts.length
                      ? 'Needs review'
                      : `Queued ${queuedCount}`
                }
              />
              <OperatorSwitch
                activeOperatorId={runtime.operator?.staffProfileId ?? ''}
                operators={operators}
                pending={busy}
                onSwitch={switchOperator}
              />
              <DrawerPanel request={checkoutRequest} disabled={busy || !online} />
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
                disabled={busy || !online}
              />
              <RefundPanel
                request={checkoutRequest}
                actingOperatorId={runtime.operator?.staffProfileId ?? ''}
                demo={demo}
                operators={operators
                  .filter((operator) => operator.canApprove)
                  .map((operator) => ({
                    id: operator.staffProfileId,
                    displayName: operator.displayName,
                    role: operator.role,
                  }))}
                disabled={busy || !online}
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

        {!online || queuedCount > 0 || reviewDrafts.length > 0 || discardedCount > 0 ? (
          <SectionCard eyebrow="Offline queue" title="Saved new orders">
            <div className="space-y-3 text-sm text-text-body">
              <p>
                {online
                  ? `${queuedCount} command(s) are waiting to replay.`
                  : 'New-order composition remains available from the cached catalog. Checkout, tenders, refunds, drawers, close, loyalty, customers, and existing-order edits require a connection.'}
              </p>
              {discardedCount > 0 ? (
                <p role="alert">Revoked · {discardedCount} queued order(s) discarded.</p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={!online || busy || queuedCount === 0}
                onClick={() =>
                  void replayQueue(runtime).then(() => {
                    // An operator can click while an automatic online replay is still folding its
                    // lost response into storage. Queue one explicit pass after that single-flight
                    // attempt so the stable idempotency key is actually retried.
                    return replayQueue(runtime);
                  })
                }
              >
                Retry queued orders
              </Button>
              {reviewDrafts.map((draft) => (
                <div
                  key={draft.draftId}
                  className="rounded-md border border-warning/30 bg-warning/10 p-3"
                >
                  <p className="font-medium">Needs review · {draft.review?.message}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!online || busy}
                      onClick={async () => {
                        await offlineRuntime.current?.resolveReview(draft.draftId, 'REPLAY');
                        syncQueue();
                        await replayQueue(runtime);
                      }}
                    >
                      Send deliberately
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={async () => {
                        await offlineRuntime.current?.resolveReview(draft.draftId, 'DISCARD');
                        syncQueue();
                      }}
                    >
                      Discard queued order
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
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
                      if (next === 'DELIVERY' && runtime) {
                        setDeliveryCustomers([]);
                        const boundary = captureDeliveryBoundary(
                          runtime,
                          deliveryCustomerBoundary.current?.customerId ?? null
                        );
                        void request<{ zones: DeliveryZone[] }>(
                          '/api/restaurant/orders/delivery/zones',
                          { headers: authHeaders(runtime) }
                        )
                          .then(({ zones }) => {
                            if (!deliveryBoundaryIsCurrent(boundary)) return;
                            setDeliveryZones(zones);
                            setDeliveryZoneId(zones[0]?.id ?? '');
                          })
                          .catch((error) => {
                            if (deliveryBoundaryIsCurrent(boundary)) handleError(error);
                          });
                      }
                      void loadMenu(next);
                    }}
                    className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  >
                    {ORDER_CHANNELS.map((value) => (
                      <option key={value} value={value}>
                        {value === 'DINE_IN'
                          ? 'Dine in'
                          : value === 'TAKEAWAY'
                            ? 'Takeaway'
                            : 'Delivery'}
                      </option>
                    ))}
                  </select>
                </div>
                {channel === 'DELIVERY' ? (
                  <fieldset
                    className="space-y-3 rounded-lg border border-border-subtle p-3"
                    disabled={busy || !online}
                  >
                    <legend className="px-1 text-sm font-semibold text-text-strong">
                      Delivery details
                    </legend>
                    {!online ? (
                      <p role="alert" className="text-sm text-warning">
                        Delivery is connected-only. Reconnect to continue; no delivery details are
                        stored locally.
                      </p>
                    ) : null}
                    <div className="space-y-1.5">
                      <Label htmlFor="delivery-customer-search">Customer name</Label>
                      <div className="flex gap-2">
                        <Input
                          id="delivery-customer-search"
                          value={customerQuery}
                          onChange={(event) => setCustomerQuery(event.target.value)}
                          placeholder="Search by name"
                          autoComplete="off"
                          className="h-11"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            !online ||
                            customerQuery.trim().length < 2 ||
                            /[@+\d]{3}/.test(customerQuery)
                          }
                          onClick={() => {
                            const query = customerQuery.trim();
                            const boundary = captureDeliveryBoundary(
                              runtime,
                              deliveryCustomerBoundary.current?.customerId ?? null
                            );
                            void request<{ customers: DeliveryCustomer[] }>(
                              `/api/restaurant/orders/customer/search?query=${encodeURIComponent(query)}`,
                              { headers: authHeaders(runtime) }
                            )
                              .then(({ customers }) => {
                                if (deliveryBoundaryIsCurrent(boundary)) {
                                  setDeliveryCustomers(customers);
                                }
                              })
                              .catch((error) => {
                                if (deliveryBoundaryIsCurrent(boundary)) handleError(error);
                              });
                          }}
                        >
                          Search
                        </Button>
                      </div>
                      {deliveryCustomers.map((customer) => (
                        <Button
                          key={customer.customerId}
                          type="button"
                          variant={
                            deliveryCustomer?.customerId === customer.customerId
                              ? 'default'
                              : 'outline'
                          }
                          className="h-11 w-full justify-start"
                          onClick={() => {
                            stateEpoch.current += 1;
                            setDeliveryCustomer(customer);
                            deliveryCustomerBoundary.current = customer;
                            setDeliveryAddresses([]);
                            setDeliveryAddressId('');
                            const boundary = captureDeliveryBoundary(runtime, customer.customerId);
                            void request<{ zones: DeliveryZone[] }>(
                              '/api/restaurant/orders/delivery/zones',
                              { headers: authHeaders(runtime) }
                            )
                              .then(({ zones }) => {
                                if (!deliveryBoundaryIsCurrent(boundary)) return;
                                setDeliveryZones(zones);
                                setDeliveryZoneId(zones[0]?.id ?? '');
                              })
                              .catch((error) => {
                                if (deliveryBoundaryIsCurrent(boundary)) handleError(error);
                              });
                            void request<{ addresses: DeliveryAddress[] }>(
                              `/api/restaurant/orders/delivery/addresses?customerId=${encodeURIComponent(customer.customerId)}`,
                              { headers: authHeaders(runtime) }
                            )
                              .then(({ addresses }) => {
                                if (!deliveryBoundaryIsCurrent(boundary)) return;
                                setDeliveryAddresses(addresses);
                                setDeliveryAddressId(
                                  addresses.find((address) => address.isDefault)?.id ??
                                    addresses[0]?.id ??
                                    ''
                                );
                              })
                              .catch((error) => {
                                if (deliveryBoundaryIsCurrent(boundary)) handleError(error);
                              });
                          }}
                        >
                          {customer.displayName ?? 'Unnamed customer'}
                          {customer.identifiers[0]?.masked
                            ? ` · ${customer.identifiers[0].masked}`
                            : ''}
                        </Button>
                      ))}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="delivery-address">Saved address</Label>
                      <select
                        id="delivery-address"
                        value={deliveryAddressId}
                        onChange={(event) => setDeliveryAddressId(event.target.value)}
                        className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <option value="">Select saved address</option>
                        {deliveryAddresses.map((address) => (
                          <option key={address.id} value={address.id}>
                            {address.label} · {address.recipientName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="delivery-zone">Delivery zone</Label>
                      <select
                        id="delivery-zone"
                        value={deliveryZoneId}
                        onChange={(event) => setDeliveryZoneId(event.target.value)}
                        className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <option value="">Select active zone</option>
                        {deliveryZones.map((zone) => (
                          <option key={zone.id} value={zone.id}>
                            {zone.name}
                          </option>
                        ))}
                      </select>
                      {deliveryZones.find((zone) => zone.id === deliveryZoneId) ? (
                        <p className="text-sm text-text-muted">
                          Minimum{' '}
                          {
                            deliveryZones.find((zone) => zone.id === deliveryZoneId)!
                              .minimumSubtotal
                          }{' '}
                          · Fee {deliveryZones.find((zone) => zone.id === deliveryZoneId)!.fee}{' '}
                          (non-taxable) · Promise{' '}
                          {
                            deliveryZones.find((zone) => zone.id === deliveryZoneId)!
                              .promisedMinutes
                          }{' '}
                          min
                        </p>
                      ) : null}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="delivery-instructions">Delivery instructions</Label>
                      <Input
                        id="delivery-instructions"
                        value={deliveryInstructions}
                        onChange={(event) => setDeliveryInstructions(event.target.value)}
                        maxLength={500}
                        autoComplete="off"
                        className="h-11"
                      />
                    </div>
                  </fieldset>
                ) : null}
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
                  disabled={
                    busy ||
                    !draftMenu?.channelOpen ||
                    (channel === 'DELIVERY' &&
                      (!online ||
                        !deliveryCustomer ||
                        !deliveryAddressId ||
                        !deliveryZoneId ||
                        draftLines.length === 0))
                  }
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
                        #{openOrder.orderNumber} · {openOrder.itemCount}{' '}
                        {openOrder.itemCount === 1 ? 'item' : 'items'}
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
              pending={order ? busy || !online : busy}
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
              pending={busy || !online}
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
              onReprint={(ticketId) =>
                order &&
                void mutate('reprint-kot', { orderId: order.id, ticketId }, 'KOT reprint queued.')
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
        connected={online}
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
