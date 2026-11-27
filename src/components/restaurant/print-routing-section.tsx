'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Loader2, Printer } from 'lucide-react';
import { toast } from 'sonner';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { browserUuid } from '@/lib/browser-uuid';
import { trpc } from '@/lib/trpc';
import { useEntitlements } from '@/components/entitlements-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { PrintRoute, PrintRoutingConfig } from '@/lib/restaurant/printing/contract';
import {
  normalizePrintRoutingConfig as normalized,
  samePrintRoutingConfig as same,
} from '@/lib/restaurant/printing/routing';

type Branch = {
  id: string;
  name: string;
  kitchenStations: Array<{ id: string; name: string }>;
  config: PrintRoutingConfig;
};
type BranchState = {
  branch: Branch;
  baseline: PrintRoutingConfig;
  draft?: PrintRoutingConfig;
  fresh?: PrintRoutingConfig;
  conflict?: boolean;
  uncertain?: PrintRoutingConfig;
  confirmation?: string;
  error?: string;
};
type Printers = inferRouterOutputs<AppRouter>['restaurantDevices']['listPrinters'];
type Inventory = { branchId: string; revision: number; printers?: Printers; error?: boolean };
const endpoint = '/api/restaurant/print-bridge';
const selectClass =
  'mt-1 min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const types = ['KITCHEN_TICKET', 'BAR_TICKET', 'RECEIPT'] as const;
class ReadError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
async function readBranches() {
  const response = await fetch(endpoint, { cache: 'no-store' });
  if (!response.ok)
    throw new ReadError(
      response.status,
      response.status === 403 || response.status === 401
        ? 'You do not have permission to configure printing.'
        : 'Print routing could not be loaded.'
    );
  const body = (await response.json()) as { branches?: Branch[] };
  if (!Array.isArray(body.branches)) throw new Error('Print routing could not be loaded.');
  return body.branches.map((branch) => ({ ...branch, config: normalized(branch.config) }));
}

export function PrintRoutingSection() {
  const { data: session, status } = useSession();
  const entitlements = useEntitlements();
  const owner =
    status === 'authenticated' &&
    session?.user?.id &&
    session.user.organizationId === entitlements.organizationId
      ? `${entitlements.organizationId}:${session.user.id}`
      : null;
  return owner ? (
    <PrintRoutingEditor key={owner} ownerKey={owner} />
  ) : (
    <p className="text-sm text-muted-foreground">
      Printing settings are waiting for your organization session.
    </p>
  );
}

function PrintRoutingEditor({ ownerKey }: { ownerKey: string }) {
  const client = trpc.useUtils().client;
  const alive = useRef(false);
  const busy = useRef(false);
  const currentBranch = useRef('');
  const readGeneration = useRef(0);
  const attempts = useRef(new Map<string, { key: string }>());
  const [records, setRecords] = useState<Record<string, BranchState> | null>(null);
  const [branchId, setBranchId] = useState('');
  const [revision, setRevision] = useState(0);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loadError, setLoadError] = useState('');
  const [denied, setDenied] = useState(false);
  const [action, setAction] = useState<'save' | 'test' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [testStatus, setTestStatus] = useState('');
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readGeneration.current += 1;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void readBranches()
      .then((branches) => {
        if (!active || !alive.current) return;
        setRecords(
          Object.fromEntries(
            branches.map((branch) => [branch.id, { branch, baseline: branch.config }])
          )
        );
        currentBranch.current = branches[0]?.id ?? '';
        setBranchId(currentBranch.current);
      })
      .catch((error: unknown) => {
        if (!active || !alive.current) return;
        setLoadError(
          error instanceof ReadError ? error.message : 'Print routing could not be loaded.'
        );
        setRecords({});
        if (error instanceof ReadError && [401, 403].includes(error.status)) setDenied(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (!branchId || denied)
      return () => {
        active = false;
      };
    void client.restaurantDevices.listPrinters
      .query({ branchId })
      .then((printers) => {
        if (active && alive.current) setInventory({ branchId, revision, printers });
      })
      .catch(() => {
        if (active && alive.current) setInventory({ branchId, revision, error: true });
      });
    return () => {
      active = false;
    };
  }, [client, branchId, revision, denied]);
  const record = records?.[branchId];
  const selected = record?.draft ?? record?.baseline;
  const blocked = denied || !!record?.uncertain || !!record?.conflict;
  const unsaved = !!record && !!selected && !same(record.baseline, selected);
  const loadedInventory =
    inventory?.branchId === branchId && inventory.revision === revision ? inventory : null;
  const printers = (loadedInventory?.printers ?? []).filter(
    (printer) =>
      printer.branchId === branchId &&
      printer.bridge.kind === 'PRINT_BRIDGE' &&
      printer.bridge.status === 'ACTIVE' &&
      printer.bridge.revokedAt === null
  );
  const updateRecord = (id: string, change: (value: BranchState) => BranchState) =>
    setRecords((prior) => (prior?.[id] ? { ...prior, [id]: change(prior[id]) } : prior));
  const mergeFresh = (id: string, branch: Branch, confirmed?: PrintRoutingConfig) =>
    updateRecord(id, (prior) => {
      if (prior.uncertain || prior.conflict)
        return { ...prior, branch, fresh: branch.config, error: undefined };
      const dirty = !!prior.draft && !same(prior.draft, prior.baseline);
      if (
        (confirmed && !same(confirmed, branch.config)) ||
        (dirty && !same(prior.baseline, branch.config))
      )
        return {
          ...prior,
          branch,
          fresh: branch.config,
          conflict: true,
          error: 'Saved routes changed. Review the refreshed routes before another save.',
        };
      return {
        ...prior,
        branch,
        baseline: branch.config,
        draft: dirty ? prior.draft : undefined,
        error: undefined,
      };
    });
  const refresh = async (id: string, confirmed?: PrintRoutingConfig) => {
    const generation = ++readGeneration.current;
    setRefreshing(true);
    setRevision((value) => value + 1);
    try {
      const branches = await readBranches();
      if (!alive.current || generation !== readGeneration.current || currentBranch.current !== id)
        return;
      const branch = branches.find((item) => item.id === id);
      if (!branch) {
        updateRecord(id, (prior) => ({
          ...prior,
          conflict: true,
          fresh: undefined,
          error: 'This branch is no longer available. Existing drafts have been retained.',
        }));
        return;
      }
      mergeFresh(id, branch, confirmed);
    } catch (error) {
      if (!alive.current || generation !== readGeneration.current || currentBranch.current !== id)
        return;
      updateRecord(id, (prior) => ({
        ...prior,
        error:
          'Saved routes could not be refreshed. Existing drafts and confirmations are retained.',
      }));
      if (error instanceof ReadError && [401, 403].includes(error.status)) setDenied(true);
    } finally {
      if (alive.current && generation === readGeneration.current) setRefreshing(false);
    }
  };
  const changeBranch = (id: string) => {
    if (busy.current) return;
    currentBranch.current = id;
    setBranchId(id);
    setTestStatus('');
    void refresh(id);
  };
  const routeFor = (type: PrintRoute['documentType']): PrintRoute =>
    selected?.routes.find((route) => route.documentType === type) ?? {
      documentType: type,
      stationId: null,
      printerId: '',
      registeredPrinterId: null,
      enabled: false,
    };
  const updateRoute = (type: PrintRoute['documentType'], patch: Partial<PrintRoute>) => {
    if (busy.current || blocked || !selected) return;
    updateRecord(branchId, (prior) => {
      const config = prior.draft ?? prior.baseline;
      const routes = [...config.routes];
      const index = routes.findIndex((route) => route.documentType === type);
      if (index < 0)
        routes.push({
          documentType: type,
          stationId: null,
          printerId: '',
          registeredPrinterId: null,
          enabled: false,
          ...patch,
        });
      else routes[index] = { ...routes[index], ...patch };
      return { ...prior, draft: { ...config, routes }, confirmation: undefined, error: undefined };
    });
    setTestStatus('');
  };
  const removeRoute = (type: PrintRoute['documentType']) => {
    if (busy.current || blocked) return;
    updateRecord(branchId, (prior) => {
      const config = prior.draft ?? prior.baseline;
      const index = config.routes.findIndex((route) => route.documentType === type);
      return {
        ...prior,
        draft: { ...config, routes: config.routes.filter((_, i) => i !== index) },
        confirmation: undefined,
      };
    });
    setTestStatus('');
  };
  const reconcile = (keepDraft: boolean) => {
    if (busy.current || !record?.fresh) return;
    updateRecord(branchId, (prior) => ({
      ...prior,
      baseline: prior.fresh!,
      draft: keepDraft ? (prior.draft ?? prior.uncertain) : undefined,
      fresh: undefined,
      uncertain: undefined,
      conflict: false,
      error: undefined,
      confirmation: 'Refreshed routes reviewed. No save was repeated.',
    }));
    setTestStatus('');
  };
  const save = async () => {
    if (busy.current || refreshing || blocked || !record || !selected) return;
    const id = branchId;
    const payload = normalized(selected);
    const baseline = record.baseline;
    if (payload.routes.some((route) => !route.printerId.trim() || route.printerId.length > 128)) {
      updateRecord(id, (prior) => ({
        ...prior,
        error: 'Enter a printer address for every route, or remove its displayed route.',
      }));
      return;
    }
    busy.current = true;
    setAction('save');
    setTestStatus('');
    let sent = false;
    updateRecord(id, (prior) => ({ ...prior, error: undefined, confirmation: undefined }));
    try {
      const latest = (await readBranches()).find((branch) => branch.id === id);
      if (!alive.current) return;
      if (!latest || !same(latest.config, baseline)) {
        updateRecord(id, (prior) => ({
          ...prior,
          conflict: true,
          fresh: latest?.config,
          error: 'Saved routes changed. Review the refreshed routes before saving your draft.',
        }));
        return;
      }
      sent = true;
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, expectedConfig: baseline }),
      });
      if (!alive.current) return;
      if (!response.ok) {
        if ([400, 401, 403, 409, 422].includes(response.status)) {
          if ([401, 403].includes(response.status)) setDenied(true);
          updateRecord(id, (prior) => ({
            ...prior,
            conflict: response.status === 409,
            fresh: undefined,
            error:
              response.status === 409
                ? 'Refresh saved routes before reviewing this draft again.'
                : 'Print routing was not saved. Check your access and route values.',
          }));
          return;
        }
        throw new Error('Uncertain save');
      }
      updateRecord(id, (prior) => ({
        ...prior,
        baseline: payload,
        draft: undefined,
        error: undefined,
        confirmation: 'Print routes saved. This save is confirmed even if refreshing fails.',
      }));
      toast.success('Print routes saved.');
      await refresh(id, payload);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ReadError && [401, 403].includes(error.status)) setDenied(true);
      updateRecord(id, (prior) => ({
        ...prior,
        uncertain: sent ? payload : undefined,
        fresh: undefined,
        error: sent
          ? 'Save outcome is uncertain. Refresh saved routes and review before another save.'
          : 'Saved routes could not be checked. Your draft has been retained; no save was sent.',
      }));
    } finally {
      busy.current = false;
      if (alive.current) setAction(null);
    }
  };
  const savedReceipt = record?.baseline.routes.find(
    (route) => route.documentType === 'RECEIPT' && route.enabled && route.stationId === null
  );
  const testReceipt = async () => {
    if (busy.current || refreshing || blocked || unsaved || !record || !savedReceipt) return;
    const saved = record.branch;
    const route = savedReceipt;
    const baseline = record.baseline;
    busy.current = true;
    setAction('test');
    setTestStatus('');
    let sent = false;
    try {
      const latest = (await readBranches()).find((branch) => branch.id === saved.id);
      if (!alive.current) return;
      if (!latest || !same(latest.config, baseline)) {
        updateRecord(saved.id, (prior) => ({
          ...prior,
          conflict: true,
          fresh: latest?.config,
          error: 'Saved routes changed. Review the refreshed routes before testing the printer.',
        }));
        return;
      }
      const destination = JSON.stringify([
        ownerKey,
        saved.id,
        route.registeredPrinterId ?? null,
        route.printerId,
      ]);
      let attempt = attempts.current.get(destination);
      if (!attempt) {
        attempt = { key: `receipt-test:${browserUuid()}` };
        attempts.current.set(destination, attempt);
      }
      sent = true;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          branchId: saved.id,
          idempotencyKey: attempt.key,
          expectedDestination: {
            printerId: route.printerId,
            registeredPrinterId: route.registeredPrinterId ?? null,
          },
        }),
      });
      const body = (await response.json()) as {
        code?: string;
        result?: { status: string; printerId?: string };
      };
      if (!alive.current) return;
      if (response.status === 409 && body.code === 'REFRESH_REQUIRED') {
        updateRecord(saved.id, (prior) => ({
          ...prior,
          conflict: true,
          fresh: undefined,
          error:
            'Saved printer destination changed. Refresh and review the saved routes before testing again.',
        }));
        setTestStatus(
          'Receipt test was rejected. Refresh and review the saved routes before continuing.'
        );
        return;
      }
      if (!response.ok) throw new Error('Receipt test could not be queued.');
      setTestStatus(
        `${saved.name} · ${body.result?.printerId ?? route.printerId}: ${body.result?.status === 'PRINTED' ? 'Bridge acknowledged delivery' : 'Test request accepted; delivery may still be pending or unavailable'}. Paper output is not confirmed. Repeating this test reuses the same request.`
      );
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ReadError && [401, 403].includes(error.status)) setDenied(true);
      setTestStatus(
        sent
          ? 'Receipt test could not be confirmed. Delivery may be uncertain. Retry uses the same request.'
          : 'Saved routes could not be checked. No receipt test was sent.'
      );
    } finally {
      busy.current = false;
      if (alive.current) setAction(null);
    }
  };

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
          <Printer className="h-4 w-4 text-warning" />
          Printing
        </CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          A kitchen printer (KOT) prints paper tickets; a kitchen display (KDS) shows the same
          station queue on screen, and each station may use either, both, or neither.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError && (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        )}
        {denied ? (
          <p role="alert" className="text-sm text-destructive">
            You do not have permission to configure printing.
          </p>
        ) : records === null ? (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            Loading print routes…
          </p>
        ) : !Object.keys(records).length ? (
          <p className="text-sm text-muted-foreground">
            No active restaurant branches are available.
          </p>
        ) : (
          <>
            <label className="block text-xs font-medium text-foreground">
              Branch
              <StudioSelect
                value={branchId}
                onChange={(event) => changeBranch(event.target.value)}
                disabled={!!action}
                className={selectClass}
              >
                {Object.values(records).map(({ branch }) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </StudioSelect>
            </label>
            {record?.error && (
              <p role="alert" className="text-sm text-destructive">
                {record.error}
              </p>
            )}
            {record?.confirmation && (
              <p role="status" className="text-sm text-success">
                {record.confirmation}
              </p>
            )}
            {record?.uncertain || record?.conflict ? (
              <div className="space-y-2 rounded-xl border border-border p-3">
                <p className="text-sm">
                  {record.fresh
                    ? record.uncertain && same(record.fresh, record.uncertain)
                      ? 'Saved routes match your submission. Review this state before continuing.'
                      : 'Fresh saved routes are available. Choose whether to keep your draft or use the saved routes.'
                    : 'Refresh the original branch to reconcile its saved routes.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={!record.fresh || refreshing || !!action}
                    onClick={() => reconcile(true)}
                  >
                    Keep draft with refreshed baseline
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!record.fresh || refreshing || !!action}
                    onClick={() => reconcile(false)}
                  >
                    Use saved routes
                  </Button>
                </div>
                {record.fresh && (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {record.fresh.routes
                      .map(
                        (route) =>
                          `${route.documentType} · ${route.stationId ?? 'Any station'} · ${route.registeredPrinterId ?? 'Manual'} · ${route.printerId} · ${route.enabled ? 'Enabled' : 'Disabled'}`
                      )
                      .join('\n') || 'No saved routes.'}
                  </pre>
                )}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {!loadedInventory
                ? 'Loading printer inventory…'
                : loadedInventory.error
                  ? 'Printer inventory is unavailable. Existing bindings are preserved; manual addresses remain editable.'
                  : 'Choose an available registered printer or enter a manual address. Inventory status does not confirm connectivity.'}
            </p>
            {types.map((type) => {
              const route = routeFor(type);
              const label =
                type === 'KITCHEN_TICKET'
                  ? 'Kitchen printer (KOT)'
                  : type === 'BAR_TICKET'
                    ? 'Bar tickets'
                    : 'Receipts';
              const available = printers.some(
                (printer) =>
                  printer.id === route.registeredPrinterId && printer.address === route.printerId
              );
              return (
                <fieldset
                  key={type}
                  disabled={!!action || blocked}
                  className="rounded-2xl border border-border/60 p-4"
                >
                  <legend className="px-1 text-sm font-semibold text-foreground">{label}</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-xs font-medium text-foreground">
                      Station
                      <StudioSelect
                        aria-label={`${label} station`}
                        value={route.stationId ?? ''}
                        onChange={(event) =>
                          updateRoute(type, { stationId: event.target.value || null })
                        }
                        className={selectClass}
                      >
                        <option value="">Any station</option>
                        {record?.branch.kitchenStations.map((station) => (
                          <option key={station.id} value={station.id}>
                            {station.name}
                          </option>
                        ))}
                      </StudioSelect>
                    </label>
                    <label className="text-xs font-medium text-foreground">
                      Destination
                      <StudioSelect
                        aria-label={`${label} destination`}
                        value={route.registeredPrinterId ?? ''}
                        onChange={(event) => {
                          const printer = printers.find((item) => item.id === event.target.value);
                          if (!event.target.value) updateRoute(type, { registeredPrinterId: null });
                          else if (printer)
                            updateRoute(type, {
                              registeredPrinterId: printer.id,
                              printerId: printer.address,
                            });
                        }}
                        className={selectClass}
                      >
                        <option value="">Manual address (legacy)</option>
                        {route.registeredPrinterId && !available && (
                          <option value={route.registeredPrinterId}>
                            Saved binding unavailable · {route.registeredPrinterId}
                          </option>
                        )}
                        {printers
                          .filter(
                            (printer) => printer.id !== route.registeredPrinterId || available
                          )
                          .map((printer) => (
                            <option key={printer.id} value={printer.id}>
                              {printer.name} · {printer.bridge.name} · {printer.address}
                            </option>
                          ))}
                      </StudioSelect>
                    </label>
                    <label className="text-xs font-medium text-foreground">
                      Printer ID
                      <Input
                        aria-label={`${label} printer ID`}
                        value={route.printerId}
                        readOnly={!!route.registeredPrinterId}
                        maxLength={128}
                        onChange={(event) => updateRoute(type, { printerId: event.target.value })}
                        placeholder="tcp://192.168.1.50:9100"
                        className="mt-1 min-h-11"
                      />
                    </label>
                    <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-foreground">
                      <Switch
                        checked={route.enabled}
                        onCheckedChange={(enabled) => updateRoute(type, { enabled })}
                        aria-label={`Enable ${label.toLowerCase()}`}
                      />
                      Enabled
                    </label>
                  </div>
                  {selected?.routes.some((item) => item.documentType === type) && (
                    <Button
                      variant="ghost"
                      className="mt-2 min-h-11"
                      onClick={() => removeRoute(type)}
                    >
                      Remove displayed {label.toLowerCase()} route
                    </Button>
                  )}
                </fieldset>
              );
            })}
            <p className="text-sm text-muted-foreground">
              POS receipts use the enabled Receipts route with Any station for the selected branch.
              Printer IDs must match an explicitly configured destination on the bridge host. Save
              changes before testing. Additional station routes are preserved.
            </p>
            <p className="text-xs text-muted-foreground">
              Use a supported modern Windows or macOS host. Windows 98, Vista, and 7 cannot run the
              modern browser/Node stack; use a supported host and a printer driver or connection
              validated for that host.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                disabled={!!action || refreshing}
                onClick={() => void refresh(branchId)}
              >
                {refreshing ? 'Refreshing…' : 'Refresh saved routes'}
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => void testReceipt()}
                disabled={!!action || refreshing || blocked || unsaved || !savedReceipt}
              >
                {action === 'test' ? 'Requesting test…' : 'Test receipt printer'}
              </Button>
              <Button
                className="min-h-11"
                onClick={() => void save()}
                disabled={!!action || refreshing || blocked || !selected}
              >
                {action === 'save' && <Loader2 className="h-4 w-4 animate-spin" />}Save print routes
              </Button>
            </div>
            {testStatus && (
              <p role="status" className="break-words text-sm text-foreground">
                {testStatus}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
