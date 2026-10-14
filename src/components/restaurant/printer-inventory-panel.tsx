'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';
import { RestaurantBranchSelect } from './restaurant-branch-select';
import {
  PrinterRegistrationFields,
  printerDraftPayload,
  validPrinterDrafts,
  type PrinterDraft,
} from './printer-registration-fields';

type Outputs = inferRouterOutputs<AppRouter>;
type Directory =
  | {
      ownerKey: string;
      attempt: number;
      branches: Outputs['restaurantStaff']['listBranches'];
      error?: never;
    }
  | { ownerKey: string; attempt: number; error: true; branches?: never };
type Inventory = { ownerKey: string; branchId: string; revision: string } & (
  | { error: 'permission' | 'read'; printers?: never; devices?: never }
  | {
      error?: never;
      printers: Outputs['restaurantDevices']['listPrinters'];
      devices: Outputs['restaurantDevices']['list'];
    }
);
type Command = {
  ownerKey: string;
  branchId: string;
  bridgeId: string;
  branchName: string;
  bridgeName: string;
};
type RenameDraft = {
  commandId: string;
  ownerKey: string;
  branchId: string;
  branchName: string;
  printerId: string;
  expectedName: string;
  name: string;
  error?: string;
  review?: {
    reason: 'conflict' | 'uncertain';
    read?: 'loading' | 'failed' | 'missing';
    freshName?: string;
  };
};
function permissionError(error: unknown) {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  return code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
}

export function PrinterInventoryPanel({
  ownerKey,
  refreshVersion = 0,
}: {
  ownerKey: string;
  refreshVersion?: number;
}) {
  const client = trpc.useUtils().client;
  const owner = useRef(ownerKey);
  const generation = useRef(0);
  const busy = useRef(false);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [directoryRetry, setDirectoryRetry] = useState(0);
  const [branchId, setBranchId] = useState('');
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [reload, setReload] = useState(0);
  const [openOwner, setOpenOwner] = useState<string | null>(null);
  const [bridgeId, setBridgeId] = useState('');
  const [rows, setRows] = useState<PrinterDraft[]>([]);
  const [pendingOwner, setPendingOwner] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<Command | null>(null);
  const [receipt, setReceipt] = useState<{
    ownerKey: string;
    branchId: string;
    count: number;
  } | null>(null);
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null);
  const [renameOpen, setRenameOpen] = useState<string | null>(null);
  const [renameReceipt, setRenameReceipt] = useState<{
    ownerKey: string;
    branchId: string;
    name: string;
    changed: boolean;
  } | null>(null);
  const [deniedBranch, setDeniedBranch] = useState<{ ownerKey: string; branchId: string } | null>(
    null
  );
  const renameReadAttempt = useRef(0);
  const inventoryReadEpoch = useRef(0);
  const inventoryReadBranch = useRef('');
  const renderedInventoryEpoch = inventoryReadEpoch.current;
  const renameReviewGate = useRef<string | null>(null);
  const renameMutation = trpc.restaurantDevices.renamePrinter.useMutation({
    retry: false,
    gcTime: 0,
  });
  const mutation = trpc.restaurantDevices.registerPrinters.useMutation({ retry: false, gcTime: 0 });
  useLayoutEffect(() => {
    owner.current = ownerKey;
    return () => {
      owner.current = '';
      generation.current += 1;
    };
  }, [ownerKey]);
  useEffect(() => {
    let current = true;
    // Direct client reads avoid sharing a prior user's cached directory or inventory.
    void client.restaurantStaff.listBranches
      .query()
      .then((branches) => {
        if (current && owner.current === ownerKey)
          setDirectory({ ownerKey, attempt: directoryRetry, branches });
      })
      .catch(() => {
        if (current && owner.current === ownerKey)
          setDirectory({ ownerKey, attempt: directoryRetry, error: true });
      });
    return () => {
      current = false;
    };
  }, [client, ownerKey, directoryRetry]);
  const ownedDirectory =
    directory?.ownerKey === ownerKey && directory.attempt === directoryRetry ? directory : null;
  const branches = ownedDirectory?.branches ?? [];
  const activeBranch = branches.some((branch) => branch.id === branchId && branch.active);
  const revision = `${reload}:${refreshVersion}`;
  useEffect(() => {
    let current = true;
    if (!activeBranch)
      return () => {
        current = false;
      };
    const requestEpoch = ++inventoryReadEpoch.current;
    inventoryReadBranch.current = branchId;
    void Promise.all([
      client.restaurantDevices.listPrinters.query({ branchId }),
      client.restaurantDevices.list.query(),
    ])
      .then(([printers, devices]) => {
        if (current && owner.current === ownerKey && requestEpoch === inventoryReadEpoch.current) {
          setInventory({ ownerKey, branchId, revision, printers, devices });
          setDeniedBranch((prior) =>
            prior?.ownerKey === ownerKey && prior.branchId === branchId ? null : prior
          );
        }
      })
      .catch((error: unknown) => {
        if (current && owner.current === ownerKey && requestEpoch === inventoryReadEpoch.current)
          setInventory({
            ownerKey,
            branchId,
            revision,
            error: permissionError(error) ? 'permission' : 'read',
          });
      });
    return () => {
      current = false;
    };
  }, [client, ownerKey, branchId, activeBranch, revision]);
  const loaded =
    inventory?.ownerKey === ownerKey &&
    inventory.branchId === branchId &&
    inventory.revision === revision &&
    activeBranch
      ? inventory
      : null;
  const accessDenied = deniedBranch?.ownerKey === ownerKey && deniedBranch.branchId === branchId;
  const ready = loaded?.printers !== undefined && !accessDenied;
  const ownedRename = renameDraft?.ownerKey === ownerKey ? renameDraft : null;
  const renameNeedsReview = !!ownedRename?.review;
  const bridges = ready
    ? loaded.devices.filter(
        (device) =>
          device.branch.id === branchId &&
          device.kind === 'PRINT_BRIDGE' &&
          device.status === 'ACTIVE' &&
          device.revokedAt === null
      )
    : [];
  const pending = pendingOwner === ownerKey;
  const needsReconciliation = uncertain?.ownerKey === ownerKey;
  const changeBranch = (next: string) => {
    if (busy.current) return;
    setBranchId(next);
    setReload((value) => value + 1);
    setBridgeId('');
    setRows([]);
    setOpenOwner(null);
    setRenameOpen(null);
    if (!renameNeedsReview) setRenameDraft(null);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      busy.current ||
      renderedInventoryEpoch !== inventoryReadEpoch.current ||
      needsReconciliation ||
      renameReviewGate.current === ownerKey ||
      !ready ||
      !rows.length ||
      !validPrinterDrafts(rows) ||
      !bridges.some((bridge) => bridge.id === bridgeId)
    )
      return;
    const command = {
      ownerKey,
      branchId,
      bridgeId,
      branchName: branches.find((branch) => branch.id === branchId)!.name,
      bridgeName: bridges.find((bridge) => bridge.id === bridgeId)!.name,
    };
    const current = generation.current;
    busy.current = true;
    setPendingOwner(ownerKey);
    setReceipt(null);
    try {
      const result = await mutation.mutateAsync({
        branchId,
        bridgeId,
        printers: printerDraftPayload(rows),
      });
      if (current === generation.current && owner.current === command.ownerKey) {
        setReceipt({ ownerKey, branchId, count: result.registered });
        setRows([]);
        setBridgeId('');
        setOpenOwner(null);
        setReload((value) => value + 1);
      }
    } catch {
      if (current === generation.current && owner.current === command.ownerKey) {
        setUncertain(command);
        setOpenOwner(null);
        setReload((value) => value + 1);
      }
    } finally {
      busy.current = false;
      mutation.reset();
      if (current === generation.current && owner.current === command.ownerKey)
        setPendingOwner(null);
    }
  };
  const updateRename = (command: RenameDraft, change: (draft: RenameDraft) => RenameDraft) =>
    setRenameDraft((prior) =>
      prior?.commandId === command.commandId && prior.ownerKey === command.ownerKey
        ? change(prior)
        : prior
    );
  const readRenameBaseline = async (command: RenameDraft) => {
    const attempt = ++renameReadAttempt.current;
    const current = generation.current;
    updateRename(command, (draft) => ({
      ...draft,
      review: { reason: draft.review!.reason, read: 'loading' },
    }));
    try {
      // This dedicated read starts after the failed command, never reusing an older list refresh.
      const printers = await client.restaurantDevices.listPrinters.query({
        branchId: command.branchId,
      });
      if (
        owner.current !== command.ownerKey ||
        current !== generation.current ||
        attempt !== renameReadAttempt.current
      )
        return;
      const printer = printers.find(
        (item) => item.id === command.printerId && item.branchId === command.branchId
      );
      updateRename(command, (draft) => ({
        ...draft,
        review: {
          reason: draft.review!.reason,
          ...(printer ? { freshName: printer.name } : { read: 'missing' as const }),
        },
      }));
    } catch (error) {
      if (
        owner.current !== command.ownerKey ||
        current !== generation.current ||
        attempt !== renameReadAttempt.current
      )
        return;
      if (permissionError(error)) {
        if (inventoryReadBranch.current === command.branchId) inventoryReadEpoch.current += 1;
        setDeniedBranch({ ownerKey: command.ownerKey, branchId: command.branchId });
      }
      updateRename(command, (draft) => ({
        ...draft,
        review: { reason: draft.review!.reason, read: 'failed' },
      }));
    }
  };
  const openRename = (printer: Outputs['restaurantDevices']['listPrinters'][number]) => {
    if (
      busy.current ||
      renderedInventoryEpoch !== inventoryReadEpoch.current ||
      renameReviewGate.current === ownerKey ||
      needsReconciliation ||
      !ready ||
      printer.branchId !== branchId
    )
      return;
    const draft =
      ownedRename?.printerId === printer.id && ownedRename.branchId === branchId
        ? ownedRename
        : {
            commandId: crypto.randomUUID(),
            ownerKey,
            branchId,
            branchName: branches.find((branch) => branch.id === branchId)!.name,
            printerId: printer.id,
            expectedName: printer.name,
            name: printer.name,
          };
    setRenameDraft(draft);
    setRenameOpen(draft.commandId);
    setRenameReceipt(null);
    renameMutation.reset();
  };
  const abandonRename = () => {
    if (
      busy.current ||
      !ownedRename?.review ||
      (ownedRename.review.freshName === undefined && ownedRename.review.read !== 'missing')
    )
      return;
    // Release only after a successful dedicated observation, then invalidate the old table.
    inventoryReadEpoch.current += 1;
    renameReadAttempt.current += 1;
    renameReviewGate.current = null;
    setRenameDraft(null);
    setRenameOpen(null);
    setReload((value) => value + 1);
  };
  const adoptRenameBaseline = (keepDraft: boolean) => {
    if (
      busy.current ||
      !ready ||
      !ownedRename?.review ||
      ownedRename.branchId !== branchId ||
      ownedRename.review.freshName === undefined
    )
      return;
    const freshName = ownedRename.review.freshName;
    renameReadAttempt.current += 1;
    renameReviewGate.current = null;
    if (keepDraft)
      updateRename(ownedRename, (draft) => ({
        ...draft,
        expectedName: freshName,
        review: undefined,
        error: undefined,
      }));
    else {
      setRenameDraft(null);
      setRenameOpen(null);
      setReload((value) => value + 1);
    }
  };
  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      busy.current ||
      renderedInventoryEpoch !== inventoryReadEpoch.current ||
      renameReviewGate.current === ownerKey ||
      !ownedRename ||
      ownedRename.review ||
      !ready ||
      needsReconciliation ||
      ownedRename.branchId !== branchId ||
      !ownedRename.name.trim() ||
      ownedRename.name.trim().length > 120
    )
      return;
    const command = { ...ownedRename, name: ownedRename.name.trim() };
    const current = generation.current;
    busy.current = true;
    setPendingOwner(ownerKey);
    setRenameReceipt(null);
    updateRename(command, (draft) => ({ ...draft, error: undefined }));
    try {
      const result = await renameMutation.mutateAsync({
        branchId: command.branchId,
        printerId: command.printerId,
        expectedName: command.expectedName,
        name: command.name,
      });
      if (owner.current !== command.ownerKey || current !== generation.current) return;
      setRenameReceipt({
        ownerKey: command.ownerKey,
        branchId: command.branchId,
        name: result.printer.name,
        changed: result.changed,
      });
      setRenameDraft(null);
      setRenameOpen(null);
      setReload((value) => value + 1);
    } catch (error) {
      if (owner.current !== command.ownerKey || current !== generation.current) return;
      const code = (error as { data?: { code?: string } } | null)?.data?.code;
      if (code && ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'].includes(code)) {
        updateRename(command, (draft) => ({
          ...draft,
          error:
            'Name was not saved. Check your access and the current printer, then review the draft.',
        }));
        if (permissionError(error)) {
          if (inventoryReadBranch.current === command.branchId) inventoryReadEpoch.current += 1;
          setDeniedBranch({ ownerKey: command.ownerKey, branchId: command.branchId });
          setRenameOpen(null);
        }
      } else {
        renameReviewGate.current = command.ownerKey;
        updateRename(command, (draft) => ({
          ...draft,
          error: undefined,
          review: { reason: code === 'CONFLICT' ? 'conflict' : 'uncertain', read: 'loading' },
        }));
        void readRenameBaseline(command);
      }
    } finally {
      busy.current = false;
      renameMutation.reset();
      if (owner.current === command.ownerKey && current === generation.current)
        setPendingOwner(null);
    }
  };
  return (
    <SectionCard title="Printer inventory" titleLevel={2}>
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          Manage registered targets for a branch. Inventory status does not verify connectivity or
          configure print routing.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1 space-y-1">
            <label htmlFor="inventory-branch" className="block text-sm font-medium">
              Inventory branch
            </label>
            <RestaurantBranchSelect
              id="inventory-branch"
              ariaLabel="Inventory branch"
              value={branchId}
              onChange={changeBranch}
              branches={branches}
              loading={!ownedDirectory}
              error={Boolean(ownedDirectory?.error)}
              disabled={pending}
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11"
            disabled={!activeBranch || pending}
            onClick={() => {
              if (!busy.current) setReload((value) => value + 1);
            }}
          >
            Refresh printers
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={
              !ready || pending || needsReconciliation || renameNeedsReview || !bridges.length
            }
            onClick={() => {
              if (!busy.current && renameReviewGate.current !== ownerKey) {
                setBridgeId('');
                setRows([]);
                setOpenOwner(ownerKey);
                mutation.reset();
              }
            }}
          >
            Register printers
          </Button>
        </div>
        {ownedDirectory?.error ? (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>Branches could not be loaded.</p>
            <Button variant="outline" onClick={() => setDirectoryRetry((value) => value + 1)}>
              Retry branches
            </Button>
          </div>
        ) : null}
        {needsReconciliation ? (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>
              Registration could not be confirmed for {uncertain.bridgeName} in{' '}
              {uncertain.branchName}. Load that branch’s inventory and reconcile this bridge before
              trying again.
            </p>
            <Button
              type="button"
              variant="secondary"
              disabled={pending || !ready || uncertain.branchId !== branchId}
              onClick={() => {
                if (!busy.current && ready && uncertain.branchId === branchId) {
                  setUncertain(null);
                  setRows([]);
                  setBridgeId('');
                  setReload((value) => value + 1);
                }
              }}
            >
              I have reconciled the printers
            </Button>
          </div>
        ) : null}
        {receipt?.ownerKey === ownerKey && receipt.branchId === branchId ? (
          <p role="status" className="text-sm text-success">
            Registered {receipt.count} printer{receipt.count === 1 ? '' : 's'}. Registration is
            confirmed even if the list needs refreshing.
          </p>
        ) : null}
        {renameReceipt?.ownerKey === ownerKey && renameReceipt.branchId === branchId ? (
          <p role="status" className="text-sm text-success">
            {renameReceipt.changed
              ? `Renamed printer to ${renameReceipt.name}.`
              : `Printer name remains ${renameReceipt.name}.`}{' '}
            This result is confirmed even if the list needs refreshing.
          </p>
        ) : null}
        {renameNeedsReview ? (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>
              {ownedRename.review!.reason === 'conflict'
                ? 'Printer name changed before this save.'
                : 'Rename outcome is uncertain.'}{' '}
              Review {ownedRename.expectedName} in {ownedRename.branchName} before another rename.
              Closing the dialog keeps this review pending.
            </p>
            <Button
              type="button"
              variant="secondary"
              disabled={pending || !activeBranch || ownedRename.branchId !== branchId}
              onClick={() => {
                if (!busy.current) setRenameOpen(ownedRename.commandId);
              }}
            >
              Review printer name
            </Button>
          </div>
        ) : null}
        {accessDenied ? (
          <p role="alert" className="text-sm text-destructive">
            You do not have permission to manage this branch’s printer inventory. Refresh to check
            your access again.
          </p>
        ) : !branchId ? (
          <p className="text-sm text-text-muted">Select a branch to load its inventory.</p>
        ) : activeBranch && !loaded ? (
          <p role="status" className="text-sm text-text-muted">
            Loading printers…
          </p>
        ) : loaded?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {loaded.error === 'permission'
              ? 'You do not have permission to manage this branch’s printer inventory.'
              : 'Printers could not be loaded. Refresh the list to try again.'}
          </p>
        ) : ready ? (
          <>
            {!bridges.length ? (
              <p className="text-sm text-text-muted">
                No active print bridge is available in this branch. Enroll a print bridge before
                registering printers.
              </p>
            ) : null}
            {loaded.printers.length ? (
              <div className="overflow-x-auto">
                <Table className="min-w-[720px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Bridge</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Paper</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last seen</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loaded.printers.map((printer) => (
                      <TableRow key={printer.id}>
                        <TableCell>{printer.name}</TableCell>
                        <TableCell>{printer.bridge.name}</TableCell>
                        <TableCell className="font-mono text-xs">{printer.address}</TableCell>
                        <TableCell>{printer.paperWidthMm} mm</TableCell>
                        <TableCell>
                          <StatusPill
                            status={printer.lastSeenAt ? printer.status : 'Not reported'}
                            tone={
                              printer.lastSeenAt && printer.status === 'ONLINE'
                                ? 'success'
                                : 'neutral'
                            }
                          />
                        </TableCell>
                        <TableCell>
                          {printer.lastSeenAt
                            ? new Date(printer.lastSeenAt).toLocaleString()
                            : 'Not reported'}
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            aria-label={`Rename ${printer.name}`}
                            disabled={
                              pending ||
                              needsReconciliation ||
                              renameNeedsReview ||
                              printer.branchId !== branchId
                            }
                            onClick={() => openRename(printer)}
                          >
                            Rename
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-text-muted">No printers registered in this branch.</p>
            )}
          </>
        ) : null}
      </div>
      <Dialog
        open={
          !!ownedRename &&
          ownedRename.branchId === branchId &&
          renameOpen === ownedRename.commandId &&
          !accessDenied
        }
        onOpenChange={(open) => {
          if (!open && !busy.current) {
            setRenameOpen(null);
            if (!renameNeedsReview) setRenameDraft(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Rename printer</DialogTitle>
            <DialogDescription>
              Change the inventory label in {ownedRename?.branchName}. The printer target, routes
              and delivery history remain unchanged.
            </DialogDescription>
          </DialogHeader>
          {ownedRename && (
            <form onSubmit={submitRename} className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="printer-rename-name" className="text-sm font-medium">
                  Printer name
                </label>
                <Input
                  id="printer-rename-name"
                  value={ownedRename.name}
                  maxLength={120}
                  disabled={pending || renameNeedsReview}
                  onChange={(event) =>
                    updateRename(ownedRename, (draft) => ({
                      ...draft,
                      name: event.target.value,
                      error: undefined,
                    }))
                  }
                />
              </div>
              {ownedRename.error && (
                <p role="alert" className="text-sm text-destructive">
                  {ownedRename.error}
                </p>
              )}
              {ownedRename.review ? (
                <div className="space-y-3 text-sm">
                  <p>
                    {ownedRename.review.read === 'loading'
                      ? 'Checking the current name…'
                      : ownedRename.review.read === 'missing'
                        ? 'This printer is no longer available in the branch.'
                        : ownedRename.review.read === 'failed'
                          ? 'The current name could not be checked.'
                          : `Current saved name: ${ownedRename.review.freshName}`}
                  </p>
                  <p>
                    A matching name shows the current saved state; it does not confirm that the
                    earlier request completed. Reviewing does not send another save.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending || ownedRename.review.read === 'loading'}
                      onClick={() => {
                        if (!busy.current) void readRenameBaseline(ownedRename);
                      }}
                    >
                      Check current name
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={pending || !ready || ownedRename.review.freshName === undefined}
                      onClick={() => adoptRenameBaseline(true)}
                    >
                      Keep draft with current name
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={pending || !ready || ownedRename.review.freshName === undefined}
                      onClick={() => adoptRenameBaseline(false)}
                    >
                      Use current name
                    </Button>
                  </div>
                  <p>Abandoning this draft does not cancel an already sent request.</p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      pending ||
                      (ownedRename.review.freshName === undefined &&
                        ownedRename.review.read !== 'missing')
                    }
                    onClick={abandonRename}
                  >
                    Abandon draft
                  </Button>
                </div>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    if (!busy.current) {
                      setRenameOpen(null);
                      if (!renameNeedsReview) setRenameDraft(null);
                    }
                  }}
                >
                  {renameNeedsReview ? 'Close review' : 'Cancel rename'}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    pending ||
                    renameNeedsReview ||
                    !ready ||
                    needsReconciliation ||
                    !ownedRename.name.trim() ||
                    ownedRename.name.trim().length > 120
                  }
                >
                  {pending ? 'Saving name…' : 'Save printer name'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={openOwner === ownerKey}
        onOpenChange={(open) => {
          if (!busy.current && !open) setOpenOwner(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Register printers</DialogTitle>
            <DialogDescription>
              Add targets to an existing active print bridge. This does not issue or rotate its
              credentials.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="inventory-bridge" className="block text-sm font-medium">
                Print bridge
              </label>
              <select
                id="inventory-bridge"
                className="h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                value={bridgeId}
                required
                disabled={pending}
                onChange={(event) => setBridgeId(event.target.value)}
              >
                <option value="">Select a print bridge</option>
                {bridges.map((bridge) => (
                  <option key={bridge.id} value={bridge.id}>
                    {bridge.name}
                  </option>
                ))}
              </select>
            </div>
            <PrinterRegistrationFields rows={rows} onChange={setRows} disabled={pending} />
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  if (!busy.current) setOpenOwner(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  pending ||
                  needsReconciliation ||
                  !ready ||
                  !rows.length ||
                  !validPrinterDrafts(rows) ||
                  !bridges.some((bridge) => bridge.id === bridgeId)
                }
              >
                {pending ? 'Registering…' : 'Save printers'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
