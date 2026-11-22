'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { SelectField } from '@/components/ui/select-field';
import { StatusPill } from '@/components/ui/status-pill';
import { useApprovalSecretKind } from '@/components/pharmacy/own-approval-copy';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { parseMajorToMinor } from '@/lib/pharmacy/khata-payment-slip';
import type { BranchOption } from '../branch-picker';

type Row = {
  id: string;
  attemptKey: string;
  reference: string | null;
  kind: string;
  amountMinor: number | null;
  remainingMinor: number | null;
  actorId: string;
  originalActorId: string;
  createdAt: Date;
  refundId: string | null;
  terminalConfirmed: boolean;
  historical: boolean;
};
type Action = 'SETTLED' | 'OWED' | 'DECLINED' | 'BOOK_HISTORICAL';
const actions: Record<Action, string> = {
  SETTLED: 'Record provider settlement',
  OWED: 'Correct to refund owed',
  DECLINED: 'Correct to no refund owed',
  BOOK_HISTORICAL: 'Book historical refund',
};
const money = (value: number | null) =>
  value === null ? 'Verify statement amount' : 'PKR ' + formatMinor(value);
const date = (value: Date) => new Date(value).toISOString().slice(0, 10);
function status(row: Row) {
  if (row.historical) return 'Historical review';
  if (row.kind === 'DECLINED') return row.refundId ? 'Tender refund reversed' : 'No refund owed';
  if (row.kind === 'SETTLED') return row.remainingMinor ? 'Partially settled' : 'Settled';
  return 'Refund owed';
}
export function RefundBranchPicker() {
  const branches = trpc.pharmacySales.counterBranches.useQuery(undefined, { retry: false });
  if (branches.isPending) return <p role="status">Loading your branches…</p>;
  if (branches.error)
    return (
      <p role="alert">
        Unable to load your branches. Check your pharmacy counter access and try again.
      </p>
    );
  return branches.data?.branches.length ? (
    <RefundWorkspace branches={branches.data.branches} />
  ) : (
    <SectionCard title="Branch access" titleLevel={2}>
      <p>Active branch access is required to view card provider refunds.</p>
    </SectionCard>
  );
}
export function RefundWorkspace({ branches }: { branches: BranchOption[] }) {
  const [branch, setBranch] = useState(branches.length === 1 ? branches[0].id : '');
  return (
    <>
      <SectionCard title="Branch" titleLevel={2}>
        <div className="grid gap-2">
          <Label htmlFor="refund-branch">Refund branch</Label>
          <SelectField
            id="refund-branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="">Choose a branch</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
        </div>
      </SectionCard>
      {branch && <BranchRefunds key={branch} branchId={branch} />}
    </>
  );
}
function BranchRefunds({ branchId }: { branchId: string }) {
  const utils = trpc.useUtils();
  const list = trpc.pharmacyCardTerminal.providerRefunds.useQuery({ branchId }, { retry: false });
  const [asOf] = useState(() => Date.now());
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  if (list.isPending) return <p role="status">Loading branch refunds…</p>;
  if (!list.data)
    return (
      <p role="alert">
        {list.error?.data?.code === 'FORBIDDEN'
          ? 'Finance read access, card-review permission and counter access at this branch are required.'
          : 'Could not load branch refunds. Please try again.'}
      </p>
    );
  const data = list.data;
  const rows: Row[] = [
    ...data.records.map((r) => ({ ...r, historical: false })),
    ...data.historical.map((r) => ({
      ...r,
      historical: true,
      kind: r.status === 'REVERSED' ? 'OWED' : 'DECLINED',
      remainingMinor: r.status === 'REVERSED' ? r.amountMinor : 0,
      actorId: r.originalActorId,
      refundId: null,
      terminalConfirmed: false,
    })),
  ];
  const row = rows.find((r) => r.id === selected);
  const needsPeer = row && (row.actorId === data.actorId || row.originalActorId === data.actorId);
  const correctable =
    row &&
    (row.kind === 'OWED'
      ? !!row.refundId || !row.terminalConfirmed
      : row.kind === 'DECLINED' && !row.refundId);
  const correction: Action = row?.kind === 'OWED' ? 'DECLINED' : 'OWED';
  return (
    <div className="space-y-6">
      <SectionCard title="Refunds and review decisions" titleLevel={2}>
        {rows.length === 0 ? (
          <p>No card provider refunds or completed reviews at this branch.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="break-all font-medium">{r.reference || 'Terminal review'}</p>
                  <p className="text-sm text-text-muted">
                    {money(r.remainingMinor)} outstanding ·{' '}
                    {Math.max(0, Math.floor((asOf - new Date(r.createdAt).getTime()) / 86400000))}{' '}
                    days since recorded
                  </p>
                  <StatusPill status={r.remainingMinor ? 'pending' : 'paid'} label={status(r)} />
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    setSelected(r.id);
                    setMessage('');
                    setAction(null);
                  }}
                  aria-label={'View ' + (r.reference || 'terminal review')}
                >
                  View details
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      {message && <p role="status">{message}</p>}
      {row && (
        <>
          <SectionCard title="Refund actions" titleLevel={2}>
            <p className="mb-3 break-all">
              {row.reference || 'Terminal review'} · {status(row)} · {money(row.remainingMinor)}{' '}
              outstanding
            </p>
            {!data.canWrite ? (
              <p>
                Finance management access is required along with accounts administration rights to
                record a settlement or correction.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {row.kind !== 'DECLINED' && row.remainingMinor !== 0 && (
                  <Button onClick={() => setAction(row.historical ? 'BOOK_HISTORICAL' : 'SETTLED')}>
                    {actions[row.historical ? 'BOOK_HISTORICAL' : 'SETTLED']}
                  </Button>
                )}
                {correctable && (
                  <Button variant="outline" onClick={() => setAction(correction)}>
                    {row.refundId ? 'Reverse mistaken tender refund' : 'Correct a review decision'}
                  </Button>
                )}
                {!correctable && !row.remainingMinor && (
                  <p>This decision has no outstanding balance or available correction.</p>
                )}
              </div>
            )}
            {action && data.canWrite && (
              <RefundForm
                key={row.id + action}
                {...{ row, action, branchId }}
                peers={data.peers}
                owner={data.owner}
                today={data.today}
                needsPeer={!!needsPeer && (action === 'OWED' || action === 'DECLINED')}
                onSaved={async () => {
                  setAction(null);
                  await Promise.all([
                    list.refetch(),
                    utils.pharmacyCardTerminal.reviewHistory.invalidate({
                      branchId,
                      attemptKey: row.attemptKey,
                    }),
                  ]);
                  setSelected('');
                  setMessage(
                    'Refund entry recorded. The branch balances and history have been refreshed.'
                  );
                }}
              />
            )}
          </SectionCard>
          <History key={row.attemptKey} branchId={branchId} attemptKey={row.attemptKey} />
        </>
      )}
    </div>
  );
}
function RefundForm({
  row,
  action,
  branchId,
  peers,
  owner,
  today,
  needsPeer,
  onSaved,
}: {
  row: Row;
  action: Action;
  branchId: string;
  peers: { id: string; name: string | null }[];
  owner: boolean;
  today: string;
  needsPeer: boolean;
  onSaved: () => Promise<void>;
}) {
  const secret = useApprovalSecretKind() === 'CODE' ? 'authenticator code' : 'PIN';
  const [error, setError] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const mutation = trpc.pharmacyCardTerminal.recordRefundAction.useMutation();
  const solo = needsPeer && owner;
  if (needsPeer && !peers.length && !solo)
    return (
      <p role="alert">
        Another eligible card reviewer must approve your correction. Ask the owner to arrange
        independent approval.
      </p>
    );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mutation.isPending) return;
    const form = new FormData(e.currentTarget);
    const val = (name: string) => String(form.get(name) ?? '').trim();
    const amount = val('amount') ? parseMajorToMinor(val('amount')) : undefined;
    if (
      amount !== undefined &&
      (!Number.isSafeInteger(amount) ||
        amount <= 0 ||
        amount > 2147483647 ||
        (action === 'SETTLED' && amount > (row.remainingMinor ?? 0)))
    ) {
      setError(
        'Enter a positive amount within the outstanding balance, with up to two decimal places.'
      );
      return;
    }
    setError('');
    try {
      const result = await mutation.mutateAsync({
        branchId,
        previousId: row.id,
        kind: action,
        commandKey: key,
        resolutionReason: val('reason'),
        slipRef: val('reference'),
        managerPin: val('secret'),
        settlementAmountMinor: action === 'SETTLED' ? amount : undefined,
        settledOn: action === 'SETTLED' ? val('date') : undefined,
        verifiedAmountMinor: action !== 'SETTLED' ? amount : undefined,
        declareSelfApproval: solo && val('signoff') ? true : undefined,
        secondApproval:
          needsPeer && !solo ? { userId: val('peer'), managerPin: val('peerSecret') } : undefined,
      });
      if ('blocked' in result) {
        setError('Approval was refused. Check the approval credential and try again.');
        return;
      }
      await onSaved();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to record this entry. Please try again.'
      );
    }
  }
  return (
    <form
      onSubmit={submit}
      onChange={() => {
        setKey(crypto.randomUUID());
        setError('');
      }}
      className="mt-4 grid max-w-xl gap-3"
    >
      <h3 className="font-semibold">{actions[action]}</h3>
      {(action === 'SETTLED' || row.amountMinor === null || action === 'OWED') && (
        <Label className="grid gap-1">
          Amount (PKR)
          <Input
            required
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            max={formatMinor(action === 'SETTLED' ? (row.remainingMinor ?? 0) : 2147483647)}
            defaultValue={
              action === 'SETTLED'
                ? formatMinor(row.remainingMinor ?? 0)
                : row.amountMinor === null
                  ? ''
                  : formatMinor(row.amountMinor)
            }
          />
        </Label>
      )}
      {action === 'SETTLED' && (
        <Label className="grid gap-1">
          Settlement date
          <Input required name="date" type="date" max={today} />
        </Label>
      )}
      <Label className="grid gap-1">
        Provider reference
        <Input name="reference" required maxLength={64} />
      </Label>
      <Label className="grid gap-1">
        Reason
        <Input name="reason" required minLength={3} maxLength={200} />
      </Label>
      <Label className="grid gap-1">
        Your {secret}
        <Input
          name="secret"
          type="password"
          autoComplete="off"
          inputMode="numeric"
          pattern="[0-9]{4,8}"
          required
        />
      </Label>
      {solo && (
        <Label>
          <Checkbox name="signoff" required />I sign off as sole owner because no other eligible
          reviewer is available.
        </Label>
      )}
      {needsPeer && !solo && (
        <>
          <Label htmlFor="refund-peer">Independent approver</Label>
          <SelectField id="refund-peer" name="peer" required defaultValue="">
            <option value="">Choose a reviewer</option>
            {peers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || 'Unnamed reviewer'}
              </option>
            ))}
          </SelectField>
          <Label className="grid gap-1">
            Approver’s {secret}
            <Input
              type="password"
              autoComplete="off"
              inputMode="numeric"
              name="peerSecret"
              pattern="[0-9]{4,8}"
              required
            />
          </Label>
        </>
      )}
      {(action === 'DECLINED' || action === 'OWED') && (
        <p>
          This records a linked correction to the previous decision. Check the statement and reason
          before confirming.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button disabled={mutation.isPending} type="submit">
        {mutation.isPending
          ? 'Saving…'
          : action === 'DECLINED' || action === 'OWED'
            ? 'Confirm correction'
            : 'Save entry'}
      </Button>
    </form>
  );
}
function History({ branchId, attemptKey }: { branchId: string; attemptKey: string }) {
  const history = trpc.pharmacyCardTerminal.reviewHistory.useQuery(
    { branchId, attemptKey },
    { retry: false }
  );
  return (
    <SectionCard title="Linked history" titleLevel={2}>
      {history.isPending ? (
        <p role="status">Loading history…</p>
      ) : !history.data ? (
        <p role="alert">Branch card-review and finance read access are required to load history.</p>
      ) : (
        <>
          <p>Original terminal status: {history.data.attempt.status}</p>
          {history.data.attempt.reviewerName && (
            <p>Reviewed by {history.data.attempt.reviewerName}</p>
          )}
          {history.data.attempt.resolutionReason && <p>{history.data.attempt.resolutionReason}</p>}
          <ol className="divide-y divide-border">
            {history.data.events.map((e) => {
              const postingTime = new Date(e.settledOn ?? e.createdAt).getTime();
              const query = new URLSearchParams({
                branchId,
                entryId: e.journalId ?? '',
                fromDate: date(new Date(postingTime - 86400000)),
                toDate: date(new Date(postingTime + 86400000)),
                fromTime: '00:00',
                toTime: '23:59:59',
              });
              return (
                <li key={e.id} id={'entry-' + e.id} className="space-y-1 break-words py-3">
                  <p className="font-medium">
                    {e.kind === 'OWED'
                      ? 'Refund owed'
                      : e.kind === 'SETTLED'
                        ? 'Provider settlement'
                        : 'No refund owed'}{' '}
                    · {money(e.amountMinor)}
                  </p>
                  <p>
                    {date(e.createdAt)} · {e.actorName} · {e.reason}
                  </p>
                  <p>
                    Provider reference {e.slipRef}
                    {e.settledOn ? ' · Settled ' + date(e.settledOn) : ''}
                  </p>
                  {e.selfApproved && <p>Self-approved by sole owner.</p>}
                  {e.secondApproverName && <p>Approved by {e.secondApproverName}</p>}
                  <div className="flex flex-wrap gap-4">
                    {e.previousId && (
                      <a className="underline" href={'#entry-' + e.previousId}>
                        Previous entry
                      </a>
                    )}
                    {e.journalId && (
                      <Link
                        className="underline"
                        href={'/pharmacy/accounts/journal-entry-lookup?' + query}
                      >
                        View journal entry
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </SectionCard>
  );
}
