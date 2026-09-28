'use client';

import { browserUuid } from '@/lib/browser-uuid';

import {
  type FormEvent,
  type ComponentProps,
  type ChangeEventHandler,
  type MouseEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { CheckoutPanel, TerminalRequest, TerminalRequestOptions } from './checkout-panel';
import type { DrawerPanel } from './drawer-panel';
import type { DayClosePanel } from './day-close-panel';
import type { MenuGrid, AddMenuItemInput, EffectiveMenu } from './menu-grid';
import type { OperatorSwitch, OperatorSwitchInput } from './operator-switch';
import type { Input } from '@/components/ui/input';
import type { StatusPill } from '@/components/ui/status-pill';
import type { RefundPanel } from './refund-panel';
import type { OrderTicketPanel, OrderDetail, VoidItemInput } from './order-ticket-panel';
import { type OrderChannel } from '@/lib/restaurant/order-channels';
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
export type PosNotice = { tone: 'success' | 'warning' | 'danger' | 'neutral'; message: string };
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

export function usePosRuntime({ demo = false }: { demo?: boolean }) {
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
  const [notice, setNotice] = useState<PosNotice | null>(null);
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
    const key = browserUuid();
    idempotencyKeys.current.set(intent, key);
    return key;
  }

  const checkoutRequest = useCallback<TerminalRequest>(
    async <T>(path: string, options: TerminalRequestOptions = {}): Promise<T> => {
      if (!runtime || runtime.state !== 'UNLOCKED') {
        throw new RequestError(401, 'An unlocked terminal session is required.');
      }
      const mutation = options.method === 'POST';
      const intent =
        options.intent ??
        `${options.method ?? 'GET'}:${path}:${JSON.stringify(options.body ?? {})}`;
      let idempotencyKey: string | null = null;
      if (mutation) {
        idempotencyKey = idempotencyKeys.current.get(intent) ?? browserUuid();
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

  const state = {
    enrollmentHeading:
      enrollmentState === 'checking'
        ? 'Checking enrollment'
        : enrollmentState === 'unrecoverable'
          ? 'Local POS recovery required'
          : demo
            ? 'Demo entry required'
            : 'Enrollment required',
    enrollmentDescription:
      enrollmentState === 'checking'
        ? 'Verifying this browser with the server.'
        : enrollmentState === 'unrecoverable'
          ? 'Local POS data could not be safely recovered.'
          : demo
            ? 'Reopen the restaurant demo to start a fresh terminal session.'
            : 'Ask an administrator to enroll this browser from Restaurant Devices.',
    enrollmentTitle:
      enrollmentState === 'checking'
        ? 'Verifying browser'
        : enrollmentState === 'unrecoverable'
          ? 'Recovery required'
          : 'Not enrolled',
    enrollmentMessage:
      enrollmentState === 'checking'
        ? 'Please wait while the terminal credential is revalidated.'
        : enrollmentState === 'unrecoverable'
          ? 'The saved offline queue was not opened. Clear site data or re-enroll this browser before continuing.'
          : demo
            ? 'This demo terminal no longer has a usable access session.'
            : 'No usable browser enrollment was found. It may be missing, expired, or revoked.',
    operatorStatus: {
      status: 'active',
      label: runtime?.operator
        ? `${runtime?.operator.displayName} · ${runtime?.operator.role}`
        : 'Operator active',
    } satisfies ComponentProps<typeof StatusPill>,
    connectionStatus: {
      status: online ? 'online' : 'offline',
      tone: online ? 'success' : 'warning',
      label: online ? 'Online' : 'Offline',
    } satisfies ComponentProps<typeof StatusPill>,
    queueStatus: {
      status:
        queue?.replay === 'PAUSED_REAUTH'
          ? 'reauth'
          : reviewDrafts.length
            ? 'needs-review'
            : queuedCount
              ? 'queued'
              : 'queue-empty',
      tone: reviewDrafts.length || queuedCount ? 'warning' : 'neutral',
      label:
        queue?.replay === 'PAUSED_REAUTH'
          ? `Reauth · ${queuedCount} queued`
          : reviewDrafts.length
            ? 'Needs review'
            : `Queued ${queuedCount}`,
    } satisfies ComponentProps<typeof StatusPill>,
    selectedDeliveryZone: deliveryZones.find((zone) => zone.id === deliveryZoneId),
    enrollmentState,
    operators,
    operatorId,
    operatorDirectoryState,
    operatorPin,
    channel,
    tableIds,
    covers,
    sectionId,
    customerQuery,
    deliveryCustomers,
    deliveryCustomer,
    deliveryAddresses,
    deliveryAddressId,
    deliveryZones,
    deliveryZoneId,
    deliveryInstructions,
    layout,
    layoutState,
    draftMenu,
    openOrders,
    order,
    draftLines,
    pending,
    notice,
    online,
    queue,
    discardedCount,
    revoked,
    queuedCount,
    reviewDrafts,
    busy,
  };
  if (!runtime) return { ...state, runtime, workspace: null, controls: null };
  // Typed bindings keep transport and event handling out of the layout.
  const workspace = {
    unlock: unlock,
    changeOperator: ((event) =>
      setOperatorId(event.target.value)) satisfies ChangeEventHandler<HTMLSelectElement>,
    retryOperators: (() =>
      void loadOperators(runtime)) satisfies MouseEventHandler<HTMLButtonElement>,
    changePin: ((event) =>
      setOperatorPin(
        event.target.value.replace(/\D/g, '')
      )) satisfies ChangeEventHandler<HTMLInputElement>,
    operatorSwitchProps: {
      activeOperatorId: runtime.operator?.staffProfileId ?? '',
      operators: operators,
      pending: busy,
      onSwitch: switchOperator,
    } satisfies ComponentProps<typeof OperatorSwitch>,
    drawerPanelProps: {
      request: checkoutRequest,
      disabled: busy || !online,
    } satisfies ComponentProps<typeof DrawerPanel>,
    dayClosePanelProps: {
      request: checkoutRequest,
      actingOperatorId: runtime.operator?.staffProfileId ?? '',
      operators: operators
        .map((operator) => ({
          id: operator.staffProfileId,
          displayName: operator.displayName,
          role: operator.role,
        }))
        .filter((operator) =>
          operators.some((source) => source.staffProfileId === operator.id && source.canApprove)
        ),
      disabled: busy || !online,
    } satisfies ComponentProps<typeof DayClosePanel>,
    refundPanelProps: {
      request: checkoutRequest,
      actingOperatorId: runtime.operator?.staffProfileId ?? '',
      demo: demo,
      operators: operators
        .filter((operator) => operator.canApprove)
        .map((operator) => ({
          id: operator.staffProfileId,
          displayName: operator.displayName,
          role: operator.role,
        })),
      disabled: busy || !online,
    } satisfies ComponentProps<typeof RefundPanel>,
    lockTerminal: (() => void lock()) satisfies MouseEventHandler<HTMLButtonElement>,
    retryQueuedOrders: (() =>
      void replayQueue(runtime).then(() => {
        // An operator can click while an automatic online replay is still folding its
        // lost response into storage. Queue one explicit pass after that single-flight
        // attempt so the stable idempotency key is actually retried.
        return replayQueue(runtime);
      })) satisfies MouseEventHandler<HTMLButtonElement>,
    sendReviewedOrder: (draft: (typeof reviewDrafts)[number]) =>
      (async () => {
        await offlineRuntime.current?.resolveReview(draft.draftId, 'REPLAY');
        syncQueue();
        await replayQueue(runtime);
      }) satisfies MouseEventHandler<HTMLButtonElement>,
    discardReviewedOrder: (draft: (typeof reviewDrafts)[number]) =>
      (async () => {
        await offlineRuntime.current?.resolveReview(draft.draftId, 'DISCARD');
        syncQueue();
      }) satisfies MouseEventHandler<HTMLButtonElement>,
    openOrder: openOrder,
    changeChannel: ((event) => {
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
        void request<{ zones: DeliveryZone[] }>('/api/restaurant/orders/delivery/zones', {
          headers: authHeaders(runtime),
        })
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
    }) satisfies ChangeEventHandler<HTMLSelectElement>,
    changeCustomerQuery: ((event) =>
      setCustomerQuery(event.target.value)) satisfies ChangeEventHandler<HTMLInputElement>,
    searchCustomers: (() => {
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
    }) satisfies MouseEventHandler<HTMLButtonElement>,
    selectCustomer: (customer: (typeof deliveryCustomers)[number]) =>
      (() => {
        stateEpoch.current += 1;
        setDeliveryCustomer(customer);
        deliveryCustomerBoundary.current = customer;
        setDeliveryAddresses([]);
        setDeliveryAddressId('');
        const boundary = captureDeliveryBoundary(runtime, customer.customerId);
        void request<{ zones: DeliveryZone[] }>('/api/restaurant/orders/delivery/zones', {
          headers: authHeaders(runtime),
        })
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
              addresses.find((address) => address.isDefault)?.id ?? addresses[0]?.id ?? ''
            );
          })
          .catch((error) => {
            if (deliveryBoundaryIsCurrent(boundary)) handleError(error);
          });
      }) satisfies MouseEventHandler<HTMLButtonElement>,
    changeDeliveryAddress: ((event) =>
      setDeliveryAddressId(event.target.value)) satisfies ChangeEventHandler<HTMLSelectElement>,
    changeDeliveryZone: ((event) =>
      setDeliveryZoneId(event.target.value)) satisfies ChangeEventHandler<HTMLSelectElement>,
    changeDeliveryInstructions: ((event) =>
      setDeliveryInstructions(event.target.value)) satisfies ChangeEventHandler<HTMLInputElement>,
    toggleTable: (table: NonNullable<TerminalLayout>['floors'][number]['tables'][number]) =>
      (() =>
        setTableIds((current) =>
          current.includes(table.id)
            ? current.filter((id) => id !== table.id)
            : [...current, table.id]
        )) satisfies ChangeEventHandler<HTMLInputElement>,
    changeCovers: ((event) =>
      setCovers(event.target.value)) satisfies ChangeEventHandler<HTMLInputElement>,
    changeSection: ((event) =>
      setSectionId(event.target.value)) satisfies ChangeEventHandler<HTMLSelectElement>,
    removeDraftLine: (line: (typeof draftLines)[number]) =>
      (() =>
        setDraftLines((current) =>
          current.filter((item) => item.lineId !== line.lineId)
        )) satisfies MouseEventHandler<HTMLButtonElement>,
    discardDraft: (() => setDraftLines([])) satisfies MouseEventHandler<HTMLButtonElement>,
    refreshOrders: (() => void loadOpenOrders()) satisfies MouseEventHandler<HTMLButtonElement>,
    selectOrder: (openOrder: (typeof openOrders)[number]) =>
      (() => void loadDetail(openOrder.id)) satisfies MouseEventHandler<HTMLButtonElement>,
    menuGridProps: {
      menu: order ? orderMenu : draftMenu,
      pending: order ? busy || !online : busy,
      onAdd: (input: AddMenuItemInput) => {
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
              lineId: browserUuid(),
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
      },
    } satisfies ComponentProps<typeof MenuGrid>,
    orderTicketPanelProps: {
      order: order,
      actingOperatorId: runtime.operator?.staffProfileId ?? '',
      operators: operators.map((operator) => ({
        id: operator.staffProfileId,
        displayName: operator.displayName,
        role: operator.role,
      })),
      pending: busy || !online,
      tables: layout?.floors.flatMap((floor) =>
        floor.tables.map((table) => ({
          id: table.id,
          label: `${floor.name} · ${table.code}`,
          occupied: table.occupied,
          activeOrderIds: table.activeOrderIds,
        }))
      ),
      onHold: (course) =>
        order && void mutate('hold', { orderId: order.id, course }, `Course ${course} held.`),
      onFire: (course) =>
        order && void mutate('fire', { orderId: order.id, course }, `Course ${course} fired.`),
      onSend: () => order && void mutate('fire', { orderId: order.id }, 'Order sent to kitchen.'),
      onReprint: (ticketId) =>
        order && void mutate('reprint-kot', { orderId: order.id, ticketId }, 'KOT reprint queued.'),
      onServed: (itemId) =>
        order && void mutate('mark-served', { orderId: order.id, itemId }, 'Item marked served.'),
      onRemake: (itemId, reason) =>
        order && void mutate('remake', { orderId: order.id, itemId, reason }, 'Remake requested.'),
      onVoid: (input: VoidItemInput) =>
        order
          ? mutate('void', { orderId: order.id, ...input }, 'Item voided.')
          : Promise.resolve(false),
      onMove: (fromTableId, toTableId) =>
        order &&
        void mutate('move-table', { orderId: order.id, fromTableId, toTableId }, 'Order moved.'),
      onMerge: (nextTableIds) =>
        order &&
        void mutate(
          'merge-tables',
          { orderId: order.id, tableIds: nextTableIds },
          'Tables merged.'
        ),
      onClose: () => void closeForPayment(),
      onCollectPayment: () => order && setCheckoutOrderId(order.id),
    } satisfies ComponentProps<typeof OrderTicketPanel>,
    checkoutPanelProps: {
      open: checkoutOrderId !== null,
      orderId: checkoutOrderId,
      request: checkoutRequest,
      connected: online,
      onClose: () => setCheckoutOrderId(null),
    } satisfies ComponentProps<typeof CheckoutPanel>,
  };
  const controls = {
    operatorIdProps: {
      id: 'operator-id',
      required: true,
      autoComplete: 'username',
      value: operatorId,
      onChange: workspace.changeOperator,
      disabled: busy || operatorDirectoryState !== 'ready' || operators.length === 0,
    } satisfies ComponentProps<'select'>,
    operatorPinProps: {
      id: 'operator-pin',
      type: 'password',
      required: true,
      inputMode: 'numeric',
      pattern: '[0-9]{4,8}',
      minLength: 4,
      maxLength: 8,
      autoComplete: 'current-password',
      value: operatorPin,
      onChange: workspace.changePin,
    } satisfies ComponentProps<typeof Input>,
    orderChannelProps: {
      id: 'order-channel',
      value: channel,
      disabled: busy,
      onChange: workspace.changeChannel,
    } satisfies ComponentProps<'select'>,
    deliveryCustomerSearchProps: {
      id: 'delivery-customer-search',
      value: customerQuery,
      onChange: workspace.changeCustomerQuery,
      placeholder: 'Search by name',
      autoComplete: 'off',
    } satisfies ComponentProps<typeof Input>,
    deliveryAddressProps: {
      id: 'delivery-address',
      value: deliveryAddressId,
      onChange: workspace.changeDeliveryAddress,
    } satisfies ComponentProps<'select'>,
    deliveryZoneProps: {
      id: 'delivery-zone',
      value: deliveryZoneId,
      onChange: workspace.changeDeliveryZone,
    } satisfies ComponentProps<'select'>,
    deliveryInstructionsProps: {
      id: 'delivery-instructions',
      value: deliveryInstructions,
      onChange: workspace.changeDeliveryInstructions,
      maxLength: 500,
      autoComplete: 'off',
    } satisfies ComponentProps<typeof Input>,
    orderCoversProps: {
      id: 'order-covers',
      type: 'number',
      min: 0,
      inputMode: 'numeric',
      value: covers,
      onChange: workspace.changeCovers,
    } satisfies ComponentProps<typeof Input>,
    orderSectionProps: {
      id: 'order-section',
      value: sectionId,
      onChange: workspace.changeSection,
      disabled: busy || layoutState !== 'ready',
    } satisfies ComponentProps<'select'>,
  };
  return { ...state, runtime, workspace, controls };
}

export type PosRuntime = ReturnType<typeof usePosRuntime>;
