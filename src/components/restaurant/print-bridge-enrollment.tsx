'use client';

import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';
import {
  PrinterRegistrationFields,
  printerDraftPayload,
  validPrinterDrafts,
  type PrinterDraft,
} from './printer-registration-fields';

type Branch = { id: string; name: string; active: boolean };
type Result = { ownerKey: string; enrollmentCode: string; expiresAt: Date };

export function PrintBridgeEnrollment({
  ownerKey,
  branches,
  onCreated,
}: {
  ownerKey: string;
  branches: readonly Branch[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [printers, setPrinters] = useState<PrinterDraft[]>([]);
  const busy = useRef(false);
  const [result, setResult] = useState<Result | null>(null);
  const [pendingOwner, setPendingOwner] = useState<string | null>(null);
  const pending = pendingOwner === ownerKey;
  const [failedOwner, setFailedOwner] = useState<string | null>(null);
  const failed = failedOwner === ownerKey;
  const owner = useRef(ownerKey);
  const generation = useRef(0);
  const mutation = trpc.restaurantDevices.initiatePrintBridgeEnrollment.useMutation({
    retry: false,
    gcTime: 0,
  });
  useLayoutEffect(() => {
    owner.current = ownerKey;
    return () => {
      generation.current += 1;
    };
  }, [ownerKey]);
  const changeOpen = (next: boolean) => {
    if (busy.current) return;
    generation.current += 1;
    setOpen(next);
    setName('');
    setBranchId('');
    setPrinters([]);
    setResult(null);
    mutation.reset();
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      busy.current ||
      failed ||
      !name.trim() ||
      !validPrinterDrafts(printers) ||
      !branches.some((b) => b.id === branchId && b.active)
    )
      return;
    const current = generation.current;
    busy.current = true;
    setPendingOwner(ownerKey);
    try {
      const response = await mutation.mutateAsync({
        name: name.trim(),
        branchId,
        ...(printers.length ? { printers: printerDraftPayload(printers) } : {}),
      });
      if (current === generation.current && owner.current === ownerKey) {
        setResult({ ...response, ownerKey });
        onCreated();
      }
    } catch {
      if (current === generation.current && owner.current === ownerKey) setFailedOwner(ownerKey);
    } finally {
      busy.current = false;
      mutation.reset();
      if (current === generation.current && owner.current === ownerKey) setPendingOwner(null);
    }
  };
  return (
    <>
      <Button variant="secondary" className="min-h-11" onClick={() => changeOpen(true)}>
        Enroll print bridge
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Enroll a print bridge</DialogTitle>
            <DialogDescription>
              Create a dedicated bridge for one branch. Its one-use enrollment code expires in ten
              minutes.
            </DialogDescription>
          </DialogHeader>
          {result?.ownerKey === ownerKey ? (
            <div className="space-y-3">
              <label className="block text-sm font-medium" htmlFor="bridge-enrollment-code">
                One-time enrollment code
              </label>
              <Input
                id="bridge-enrollment-code"
                readOnly
                value={result.enrollmentCode}
                autoComplete="off"
                onFocus={(event) => event.target.select()}
              />
              <p className="text-sm text-text-muted">
                Expires {new Date(result.expiresAt).toLocaleString()}. Copy it securely to the
                bridge host now; closing this dialog clears it.
              </p>
              <p className="text-sm text-text-muted">
                Use PRINT_BRIDGE_ENROLLMENT_CODE with a new absolute PRINT_BRIDGE_TOKEN_FILE on a
                supported POSIX host. Keep the code out of logs and command history.
              </p>
              <DialogFooter>
                <Button onClick={() => changeOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="bridge-name" className="block text-sm font-medium">
                  Bridge name
                </label>
                <Input
                  id="bridge-name"
                  value={name}
                  maxLength={120}
                  required
                  disabled={pending || failed}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="bridge-branch" className="block text-sm font-medium">
                  Branch
                </label>
                <select
                  id="bridge-branch"
                  className="h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  value={branchId}
                  required
                  disabled={pending || failed}
                  onChange={(event) => setBranchId(event.target.value)}
                >
                  <option value="">Select a branch</option>
                  {branches
                    .filter((b) => b.active)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                </select>
              </div>
              <PrinterRegistrationFields
                rows={printers}
                onChange={setPrinters}
                disabled={pending || failed}
              />
              {failed ? (
                <div className="space-y-2">
                  <p role="alert" className="text-sm text-destructive">
                    Enrollment could not be confirmed. Refresh the device list and ask your
                    administrator to reconcile any newly created bridge before trying again.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setFailedOwner(null);
                      setName('');
                      setBranchId('');
                      setPrinters([]);
                      mutation.reset();
                    }}
                  >
                    I have reconciled the device
                  </Button>
                </div>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => changeOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    pending ||
                    failed ||
                    !name.trim() ||
                    !validPrinterDrafts(printers) ||
                    !branches.some((b) => b.id === branchId && b.active)
                  }
                >
                  {pending ? 'Creating…' : 'Create enrollment code'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
