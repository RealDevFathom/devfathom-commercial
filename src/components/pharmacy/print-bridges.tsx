'use client';

import { useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';

const fieldClass = 'mt-1 min-h-11 bg-surface-raised';

type Notice = { tone: 'status' | 'alert'; text: string };

function lastSeen(value: string | null): string {
  if (!value) return 'Never connected';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : `Last seen ${date.toLocaleString()}`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * DEV-904: enrol, list and revoke the thermal print bridges of one pharmacy
 * branch. Every procedure is admin-only and branch-scoped on the server; this
 * panel is shown to administrators only to avoid a dead end for others.
 *
 * The bridge credential is returned once by `enrollBridge`. It lives only in
 * this component's state until "Done", a branch change or unmount, and the
 * mutation cache is cleared straight away.
 */
export function PharmacyPrintBridges({
  branchId,
  branchName,
}: {
  branchId: string;
  branchName: string;
}) {
  const utils = trpc.useUtils();
  const bridges = trpc.pharmacyPrinting.bridges.useQuery({ branchId }, { retry: false });
  const enroll = trpc.pharmacyPrinting.enrollBridge.useMutation({ retry: false, gcTime: 0 });
  const revoke = trpc.pharmacyPrinting.revokeBridge.useMutation({ retry: false });
  const [name, setName] = useState('');
  const [printerId, setPrinterId] = useState('');
  const [credential, setCredential] = useState<{ bridgeName: string; value: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busy = useRef(false);

  async function refresh() {
    await Promise.all([
      utils.pharmacyPrinting.bridges.invalidate({ branchId }),
      utils.pharmacyPrinting.printerStatus.invalidate({ branchId }),
    ]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !name.trim() || !printerId.trim()) return;
    busy.current = true;
    setNotice(null);
    try {
      const result = await enroll.mutateAsync({
        branchId,
        name: name.trim(),
        printerId: printerId.trim(),
      });
      if (result) {
        setCredential({ bridgeName: result.bridge.name, value: result.credential });
        setName('');
        setPrinterId('');
      }
    } catch (error) {
      setNotice({
        tone: 'alert',
        text: errorText(
          error,
          'The print bridge was not enrolled. Refresh the list, then try again.'
        ),
      });
    } finally {
      busy.current = false;
      enroll.reset();
      void refresh();
    }
  }

  async function confirmRevoke(bridgeId: string, bridgeName: string) {
    if (busy.current) return;
    busy.current = true;
    setNotice(null);
    try {
      await revoke.mutateAsync({ branchId, bridgeId });
      setNotice({
        tone: 'status',
        text: `${bridgeName} is revoked. It can no longer take print jobs for ${branchName}.`,
      });
    } catch (error) {
      setNotice({
        tone: 'alert',
        text: errorText(error, `${bridgeName} was not revoked. Refresh the list, then try again.`),
      });
    } finally {
      busy.current = false;
      setConfirming(null);
      void refresh();
    }
  }

  const list = bridges.data ?? [];
  const pending = enroll.isPending || revoke.isPending;

  return (
    <div className="space-y-6">
      <p className="max-w-prose text-sm text-text-muted">
        A print bridge is a small program on a computer next to the thermal printer. It collects
        settled receipts for {branchName} from the print queue and hands them to the printer. The
        counter shows what the bridge reports; nobody can see whether paper came out.
      </p>

      {bridges.isLoading ? (
        <p className="text-sm text-text-muted" role="status">
          Loading print bridges…
        </p>
      ) : bridges.isError ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive" role="alert">
            {errorText(bridges.error, 'Print bridges could not be loaded.')}
          </p>
          <Button
            className="min-h-11"
            type="button"
            variant="outline"
            onClick={() => void bridges.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-text-body">
          No print bridge is enrolled for {branchName}. Enrol one below to send receipts to a
          thermal printer.
        </p>
      ) : (
        <ul
          aria-label={`Print bridges for ${branchName}`}
          className="divide-y divide-border-subtle"
        >
          {list.map((bridge) => (
            <li key={bridge.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 space-y-1">
                <p className="break-words text-sm font-semibold text-text-strong">{bridge.name}</p>
                <p className="break-all font-mono text-xs text-text-muted">{bridge.printerId}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {bridge.status === 'REVOKED' ? (
                    <StatusPill status="revoked" tone="neutral" label="Revoked" />
                  ) : bridge.online ? (
                    <StatusPill status="online" tone="success" label="Online" />
                  ) : (
                    <StatusPill status="offline" tone="warning" label="Offline" />
                  )}
                  <span className="text-xs text-text-muted">{lastSeen(bridge.lastSeenAt)}</span>
                </div>
              </div>
              {bridge.status === 'ACTIVE' ? (
                confirming === bridge.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-text-body" id={`revoke-${bridge.id}`}>
                      Revoke {bridge.name}? It stops taking print jobs at once.
                    </p>
                    <Button
                      type="button"
                      variant="destructive"
                      className="min-h-11"
                      aria-describedby={`revoke-${bridge.id}`}
                      disabled={pending}
                      onClick={() => void confirmRevoke(bridge.id, bridge.name)}
                    >
                      {revoke.isPending ? 'Revoking…' : 'Confirm revoke'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={pending}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending}
                    onClick={() => {
                      setNotice(null);
                      setConfirming(bridge.id);
                    }}
                  >
                    Revoke
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {credential ? (
        <div className="space-y-3 rounded-md border border-border-default bg-surface-sunken p-4">
          <Label htmlFor="print-bridge-credential">Credential for {credential.bridgeName}</Label>
          <Input
            id="print-bridge-credential"
            className={`${fieldClass} font-mono`}
            readOnly
            autoComplete="off"
            spellCheck={false}
            value={credential.value}
            onFocus={(event) => event.target.select()}
          />
          <p className="text-sm text-text-body" role="status">
            Shown once. Copy it now into the bridge computer&apos;s owner-only token file
            (PRINT_BRIDGE_TOKEN_FILE). It is not stored here and cannot be shown again; if it is
            lost, revoke this bridge and enrol a new one.
          </p>
          <Button type="button" className="min-h-11" onClick={() => setCredential(null)}>
            Done, I have copied it
          </Button>
        </div>
      ) : (
        <form className="space-y-4 border-t border-border-subtle pt-6" onSubmit={submit}>
          <h3 className="text-base font-semibold text-text-strong">Enrol a print bridge</h3>
          <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="print-bridge-name">Bridge name</Label>
              <Input
                id="print-bridge-name"
                className={fieldClass}
                value={name}
                maxLength={80}
                required
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="print-bridge-printer">Printer address on the bridge computer</Label>
              <Input
                id="print-bridge-printer"
                className={`${fieldClass} font-mono`}
                value={printerId}
                maxLength={128}
                required
                disabled={pending}
                aria-describedby="print-bridge-printer-help"
                placeholder="queue:///Receipt_Printer"
                onChange={(event) => setPrinterId(event.target.value)}
              />
            </div>
          </div>
          <p id="print-bridge-printer-help" className="max-w-prose text-sm text-text-muted">
            Use the same address as the bridge computer&apos;s allowed printer list: queue:///name
            for a USB printer installed on the computer, tcp://address:9100 for a network printer,
            or a /dev/ path.
          </p>
          <Button
            type="submit"
            className="min-h-11"
            disabled={pending || !name.trim() || !printerId.trim()}
          >
            {enroll.isPending ? 'Enrolling…' : 'Enrol print bridge'}
          </Button>
        </form>
      )}

      {notice ? (
        <p
          role={notice.tone}
          className={
            notice.tone === 'alert' ? 'text-sm text-destructive' : 'text-sm text-text-body'
          }
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
