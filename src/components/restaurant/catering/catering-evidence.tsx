'use client';

import { useContext, useEffect, useRef, useState } from 'react';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

import { browserUuid } from '@/lib/browser-uuid';
import type { CateringMoneyInput } from '@/lib/restaurant/catering-money';
import { isDefinitiveMutationFailure } from '../pos/use-terminal-session';
import { CateringTerminalContext, type CateringTerminal } from './catering-terminal-boundary';
import { formatUtcInstant } from '@/lib/utc-instant';

type Disposition = inferRouterInputs<AppRouter>['restaurantCatering']['recordDisposition'];
const control =
  'min-h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm';
function units(value: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * BigInt(1000000) + BigInt(fraction.padEnd(6, '0'));
}

export function CateringEvidence({
  orderId,
  approvedQuoteRevisionId,
  receivable,
  onMoneyDirty,
  onMoneySaved,
  onMoneyUnresolved,
  cancelled,
  disabled,
  onDirty,
  onSaved,
}: {
  orderId: string;
  approvedQuoteRevisionId: string | null;
  receivable: boolean;
  onMoneyDirty: () => void;
  onMoneySaved: () => void;
  onMoneyUnresolved: (unresolved: boolean) => void;
  cancelled: boolean;
  disabled: boolean;
  onDirty: () => void;
  onSaved: () => void;
}) {
  const terminal = useContext(CateringTerminalContext);
  const [refund, setRefund] = useState<PaymentSummary['evidence'][number] | null>(null);
  const [moneyHeld, setMoneyHeld] = useState(false);
  const input = { orderId };
  const payments = trpc.restaurantCatering.paymentSummary.useQuery(input);
  const approvals = trpc.restaurantCatering.approvalHistory.useQuery(input);
  const consumption = trpc.restaurantCatering.consumptionHistory.useQuery(input);
  const utils = trpc.useUtils();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const command = useRef<{ fingerprint: string; body: Disposition } | null>(null);
  const pending = useRef(false);
  const disposition = trpc.restaurantCatering.recordDisposition.useMutation({
    onSuccess: () => {
      pending.current = false;
      command.current = null;
      setError('');
      setSaved(true);
      onSaved();
      void utils.restaurantCatering.invalidate();
    },
    onError: (failure) => {
      pending.current = false;
      setError(`${failure.message} Retry the unchanged command to retain its replay key.`);
    },
  });
  const money = (amount: string | null, currency: string | null) =>
    amount === null ? 'Unavailable' : `${currency ?? 'Currency unavailable'} ${amount}`;
  const sources = consumption.data?.movements ?? [];
  return (
    <>
      <SectionCard title="Payment evidence">
        <p className="mb-3 text-sm text-text-muted">
          Receipts are unearned payment evidence, not sales. Planned deposit remains a planning
          amount. Refunds never return inventory.
        </p>
        {payments.isLoading ? (
          <p role="status">Loading payment evidence…</p>
        ) : payments.error ? (
          <div role="alert">
            Payment evidence unavailable: {payments.error.message}{' '}
            <Button variant="outline" onClick={() => void payments.refetch()}>
              Retry payment evidence
            </Button>
          </div>
        ) : payments.data ? (
          <>
            <dl className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ['Approved quote total', payments.data.approvedQuoteTotal],
                  ['Planned deposit', payments.data.plannedDepositAmount],
                  ['Recorded receipts', payments.data.recordedReceipts],
                  ['Recorded refunds', payments.data.recordedRefunds],
                  ['Net paid', payments.data.netPaid],
                  ['Refundable balance', payments.data.refundableBalance],
                  ['Amount due', payments.data.amountDue],
                ] as const
              ).map(([label, amount]) => (
                <div key={label}>
                  <dt className="text-sm text-text-muted">{label}</dt>
                  <dd className="tabular-nums">{money(amount, payments.data.currency)}</dd>
                </div>
              ))}
            </dl>
            {!payments.data.evidence.length ? (
              <p>No recorded payment evidence.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {payments.data.evidence.map((receipt) => (
                  <li key={receipt.id} className="break-words border-t border-border-default pt-3">
                    <p>
                      {receipt.kind} · {money(receipt.amount, receipt.currency)} ·{' '}
                      {receipt.source === 'CASH'
                        ? 'Cash evidence'
                        : 'Operator-attested — not provider-verified'}
                    </p>
                    <p className="text-sm">
                      Receipt reference: {receipt.id} · Quote reference: {receipt.quoteRevisionId}
                    </p>
                    {receipt.originalEvidenceId ? (
                      <p>Original receipt: {receipt.originalEvidenceId}</p>
                    ) : null}
                    {receipt.kind !== 'REFUND' ? (
                      <Button
                        className="mt-2 min-h-11"
                        variant="outline"
                        disabled={disabled || moneyHeld || !terminal.ready}
                        onClick={() => {
                          setRefund(receipt);
                          onMoneyDirty();
                        }}
                      >
                        Refund this receipt
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p>Payment evidence unavailable.</p>
        )}
        <CateringMoneyForm
          orderId={orderId}
          approvedQuoteRevisionId={approvedQuoteRevisionId}
          receivable={receivable}
          summary={payments.data}
          disabled={disabled || Boolean(payments.error) || payments.isLoading}
          terminal={terminal}
          refund={refund}
          clearRefund={() => setRefund(null)}
          onDirty={onMoneyDirty}
          onSaved={onMoneySaved}
          onUnresolved={(held) => {
            setMoneyHeld(held);
            onMoneyUnresolved(held);
          }}
          refresh={() => utils.restaurantCatering.invalidate()}
        />
      </SectionCard>
      <SectionCard title="Approval history">
        {approvals.isLoading ? (
          <p role="status">Loading approval history…</p>
        ) : approvals.error ? (
          <div role="alert">
            Approval history unavailable: {approvals.error.message}{' '}
            <Button variant="outline" onClick={() => void approvals.refetch()}>
              Retry approval history
            </Button>
          </div>
        ) : !approvals.data?.length ? (
          <p>No recorded approvals.</p>
        ) : (
          <ul className="space-y-3">
            {approvals.data.map((approval) => (
              <li className="break-words" key={approval.id}>
                Order revision {approval.orderRevision} · Quote reference:{' '}
                {approval.quoteRevisionId} · {formatUtcInstant(approval.createdAt)}
                <p className="text-sm">
                  Approver name unavailable · Staff reference: {approval.actorStaffProfileId}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm text-text-muted">
          Historical approval does not approve the current revision.
        </p>
      </SectionCard>
      <SectionCard title="Physical disposition and history">
        <p className="mb-3 text-sm text-text-muted">
          Cancellation does not return prepared inventory or refund money. Only unused return
          restores stock; waste and no return allocate consumption without restoring stock. Requires
          catering management permission.
        </p>
        {consumption.isLoading ? (
          <p role="status">Loading consumption history…</p>
        ) : consumption.error ? (
          <div role="alert">
            Consumption history unavailable: {consumption.error.message}{' '}
            <Button variant="outline" onClick={() => void consumption.refetch()}>
              Retry consumption history
            </Button>
          </div>
        ) : (
          <>
            {consumption.data?.reconciliationRequired ? (
              <p role="alert">
                Legacy reversal requires reconciliation. New disposition is unavailable.
              </p>
            ) : null}
            {!sources.length ? (
              <p>No persisted consumption movements.</p>
            ) : (
              sources.map((source) => (
                <div
                  key={source.originalMovementId}
                  className="mb-4 break-words border-t border-border-default pt-3"
                >
                  <p>Consumption reference: {source.originalMovementId}</p>
                  <p className="text-sm">
                    Ingredient label unavailable · Stock reference: {source.stockItemId} · Location
                    reference: {source.locationId}
                  </p>
                  <p>
                    Consumed {source.consumed}; allocated {source.allocated}; remaining{' '}
                    {source.remaining ?? 'Unavailable'} {source.canonicalUnit.name} (
                    {source.canonicalUnit.abbreviation ?? source.canonicalUnit.id})
                  </p>
                  {!source.dispositions.length ? (
                    <p>No recorded disposition.</p>
                  ) : (
                    <ul>
                      {source.dispositions.map((entry) => (
                        <li key={entry.id}>
                          {entry.kind} · {entry.quantity} {source.canonicalUnit.name} ·{' '}
                          {entry.reason} · {formatUtcInstant(entry.createdAt)} · Staff reference:{' '}
                          {entry.actorStaffProfileId}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))
            )}
            {cancelled && sources.length > 0 ? (
              <form
                aria-label="Record physical disposition"
                onChange={() => {
                  onDirty();
                  setSaved(false);
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    pending.current ||
                    disabled ||
                    consumption.error ||
                    consumption.data?.reconciliationRequired
                  )
                    return;
                  const form = event.currentTarget;
                  const data = new FormData(form);
                  const originalMovementId = String(data.get('movement') ?? '');
                  const source = sources.find(
                    (item) => item.originalMovementId === originalMovementId
                  );
                  const quantity = String(data.get('quantity') ?? '').trim();
                  const amount = units(quantity);
                  const remaining = source?.remaining == null ? null : units(source.remaining);
                  const kind = String(data.get('kind'));
                  const reason = String(data.get('reason') ?? '').trim();
                  if (
                    amount === null ||
                    amount <= BigInt(0) ||
                    remaining === null ||
                    amount > remaining ||
                    !reason ||
                    reason.length > 500 ||
                    !['UNUSED_RETURN', 'WASTE', 'NO_RETURN'].includes(kind)
                  ) {
                    setError(
                      'Enter a positive canonical quantity no greater than remaining and a reason (up to 500 characters).'
                    );
                    return;
                  }
                  const body = {
                    orderId,
                    originalMovementId,
                    kind: kind as Disposition['kind'],
                    quantity,
                    reason,
                  };
                  const fingerprint = JSON.stringify(body);
                  if (command.current?.fingerprint !== fingerprint)
                    command.current = {
                      fingerprint,
                      body: { ...body, idempotencyKey: browserUuid() },
                    };
                  pending.current = true;
                  setSaved(false);
                  disposition.mutate(command.current.body, { onSuccess: () => form.reset() });
                }}
              >
                <fieldset
                  disabled={
                    disabled ||
                    disposition.isPending ||
                    consumption.data?.reconciliationRequired ||
                    !sources.some(
                      (source) =>
                        source.remaining != null &&
                        (units(source.remaining) ?? BigInt(0)) > BigInt(0)
                    )
                  }
                  className="grid gap-3 sm:grid-cols-2"
                >
                  <label>
                    Original consumption
                    <select className={control} name="movement" required defaultValue="">
                      <option value="" disabled>
                        Select consumption
                      </option>
                      {sources
                        .filter(
                          (source) =>
                            source.remaining != null &&
                            (units(source.remaining) ?? BigInt(0)) > BigInt(0)
                        )
                        .map((source) => (
                          <option key={source.originalMovementId} value={source.originalMovementId}>
                            {source.originalMovementId} · remaining {source.remaining}{' '}
                            {source.canonicalUnit.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Disposition
                    <select className={control} name="kind">
                      <option value="UNUSED_RETURN">Unused return</option>
                      <option value="WASTE">Waste</option>
                      <option value="NO_RETURN">No return</option>
                    </select>
                  </label>
                  <label>
                    Canonical quantity
                    <Input className="min-h-11" name="quantity" inputMode="decimal" required />
                  </label>
                  <label>
                    Disposition reason
                    <Input className="min-h-11" name="reason" maxLength={500} required />
                  </label>
                  <Button className="min-h-11" type="submit">
                    {disposition.isPending ? 'Recording disposition…' : 'Record disposition'}
                  </Button>
                </fieldset>
              </form>
            ) : !cancelled ? (
              <p>New disposition is available only after cancellation.</p>
            ) : null}
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
        {saved ? <p role="status">Physical disposition recorded.</p> : null}
      </SectionCard>
    </>
  );
}

type PaymentSummary = inferRouterOutputs<AppRouter>['restaurantCatering']['paymentSummary'];
type MoneyBody = Omit<CateringMoneyInput, 'idempotencyKey'>;
type MoneyIntent = { body: MoneyBody; key: string; identity: string; uncertain: boolean };
function cents(value: string) {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
}

function CateringMoneyForm({
  orderId,
  approvedQuoteRevisionId,
  receivable,
  summary,
  disabled,
  terminal,
  refund,
  clearRefund,
  onDirty,
  onSaved,
  onUnresolved,
  refresh,
}: {
  orderId: string;
  approvedQuoteRevisionId: string | null;
  receivable: boolean;
  summary: PaymentSummary | undefined;
  disabled: boolean;
  terminal: CateringTerminal;
  refund: PaymentSummary['evidence'][number] | null;
  clearRefund: () => void;
  onDirty: () => void;
  onSaved: () => void;
  onUnresolved: (held: boolean) => void;
  refresh: () => Promise<unknown>;
}) {
  const [source, setSource] = useState<'CASH' | 'OPERATOR_ATTESTED'>('OPERATOR_ATTESTED');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const command = useRef<MoneyIntent | null>(null);
  const [intentIdentity, setIntentIdentity] = useState('');
  const sending = useRef(false);
  useEffect(() => {
    if (!pending && !uncertain) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending, uncertain]);
  const changedActor = uncertain && intentIdentity !== terminal.identity;
  const canRecord = Boolean(
    refund ||
    (receivable &&
      approvedQuoteRevisionId &&
      summary?.approvedQuoteTotal != null &&
      (cents(summary.amountDue ?? '') ?? BigInt(0)) > BigInt(0))
  );
  const blocked =
    disabled ||
    !summary ||
    !terminal.ready ||
    pending ||
    changedActor ||
    (!uncertain && !canRecord);
  return (
    <form
      aria-label="Record catering money"
      className="mt-4 space-y-3"
      onChange={() => {
        onDirty();
        setSaved('');
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending.current || blocked) return;
        const form = event.currentTarget;
        let intent = command.current;
        if (!intent?.uncertain) {
          const data = new FormData(form);
          const amount = String(data.get('amount') ?? '').trim();
          const amountCents = cents(amount);
          const cap = refund ? summary?.refundableBalance : summary?.amountDue;
          const remaining = cap == null ? null : cents(cap);
          const currency = refund?.currency ?? summary?.currency;
          const quoteRevisionId = refund?.quoteRevisionId ?? approvedQuoteRevisionId;
          const drawer = String(data.get('drawer') ?? '').trim();
          const evidenceSource = String(data.get('evidenceSource') ?? '').trim();
          const reference = String(data.get('reference') ?? '').trim();
          if (
            amountCents === null ||
            amountCents <= BigInt(0) ||
            remaining === null ||
            amountCents > remaining ||
            !currency ||
            !/^[A-Z]{3}$/.test(currency) ||
            !quoteRevisionId ||
            (source === 'CASH'
              ? !drawer || drawer.length > 200
              : !evidenceSource ||
                !reference ||
                evidenceSource.length > 200 ||
                reference.length > 200)
          ) {
            setError(
              'Enter a positive amount no greater than the recorded balance and complete the payment evidence.'
            );
            return;
          }
          const body: MoneyBody = {
            cateringOrderId: orderId,
            quoteRevisionId,
            kind: refund ? 'REFUND' : data.get('kind') === 'BALANCE' ? 'BALANCE' : 'DEPOSIT',
            amount,
            currency,
            source,
            ...(refund ? { originalEvidenceId: refund.id } : {}),
            ...(source === 'CASH'
              ? { drawerSessionId: drawer }
              : { externalEvidenceSource: evidenceSource, externalEvidenceReference: reference }),
          };
          if (
            !intent ||
            intent.identity !== terminal.identity ||
            JSON.stringify(intent.body) !== JSON.stringify(body)
          )
            intent = { body, key: browserUuid(), identity: terminal.identity, uncertain: false };
          command.current = intent;
          setIntentIdentity(intent.identity);
        }
        if (!intent || intent.identity !== terminal.identity) return;
        sending.current = true;
        setPending(true);
        onUnresolved(true);
        setError('');
        setSaved('');
        try {
          const result = await terminal.request<{ evidenceId: string; replayed: boolean }>(
            '/api/restaurant/catering/money',
            {
              method: 'POST',
              body: intent.body,
              idempotencyKey: intent.key,
              intent: intent.key,
            }
          );
          if (!result || typeof result.evidenceId !== 'string')
            throw new Error('Payment response was unreadable.');
          command.current = null;
          setUncertain(false);
          onUnresolved(false);
          form.reset();
          setSource('OPERATOR_ATTESTED');
          clearRefund();
          onSaved();
          setSaved(
            result.replayed
              ? 'Previously recorded evidence confirmed.'
              : 'Payment evidence recorded.'
          );
          void refresh().catch(() =>
            setSaved('Payment evidence recorded. Refresh payment history before another command.')
          );
        } catch (failure) {
          // A later rejection cannot prove that an earlier ambiguous attempt did not commit.
          intent.uncertain = intent.uncertain || !isDefinitiveMutationFailure(failure);
          setUncertain(intent.uncertain);
          onUnresolved(intent.uncertain);
          setError(
            `${failure instanceof Error ? failure.message : 'Payment request failed.'} ${intent.uncertain ? 'Outcome unknown. Retry this exact command; do not record it again elsewhere.' : 'Inputs retained. Correct the details or retry.'}`
          );
        } finally {
          sending.current = false;
          setPending(false);
        }
      }}
    >
      <p className="text-sm text-text-muted">
        Record evidence only. Cash requires an open drawer session; other payments are
        operator-attested, not provider-verified. Refund limits remain server-authoritative.
      </p>
      {refund ? (
        <p>
          Refund original receipt {refund.id} · historical quote {refund.quoteRevisionId}. This does
          not return inventory.
        </p>
      ) : null}
      {!canRecord && !uncertain ? (
        <p>
          A current approved quote and amount due are required for receipts. Select an existing
          receipt for a refund.
        </p>
      ) : null}
      <fieldset disabled={blocked || uncertain} className="grid gap-3 sm:grid-cols-2">
        {!refund ? (
          <label>
            Receipt kind
            <select name="kind" className={control}>
              <option value="DEPOSIT">Deposit</option>
              <option value="BALANCE">Balance</option>
            </select>
          </label>
        ) : null}
        <label>
          Payment amount
          <Input
            className="min-h-11"
            name="amount"
            inputMode="decimal"
            required
            aria-invalid={Boolean(error)}
            aria-describedby="catering-money-error"
          />
        </label>
        <label>
          Evidence type
          <select
            className={control}
            value={source}
            onChange={(e) => setSource(e.target.value as typeof source)}
          >
            <option value="OPERATOR_ATTESTED">Operator-attested</option>
            <option value="CASH">Cash drawer</option>
          </select>
        </label>
        {source === 'CASH' ? (
          <label>
            Open drawer session reference
            <Input className="min-h-11" name="drawer" required maxLength={200} />
          </label>
        ) : (
          <>
            <label>
              Evidence source
              <Input className="min-h-11" name="evidenceSource" required maxLength={200} />
            </label>
            <label>
              Evidence reference
              <Input className="min-h-11" name="reference" required maxLength={200} />
            </label>
          </>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" className="min-h-11" disabled={blocked}>
          {pending
            ? 'Recording evidence…'
            : uncertain
              ? 'Retry same payment command'
              : refund
                ? 'Record refund evidence'
                : 'Record receipt evidence'}
        </Button>
        {refund ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={pending || uncertain}
            onClick={clearRefund}
          >
            Cancel refund
          </Button>
        ) : null}
      </div>
      {changedActor ? (
        <p role="alert">
          Return to the original staff account, device and operator before retrying this unresolved
          command.
        </p>
      ) : null}
      {uncertain ? (
        <p role="status">
          Keep this event open until the command is confirmed. Its original amount, quote and replay
          key are preserved.
        </p>
      ) : null}
      <p id="catering-money-error" role={error ? 'alert' : undefined}>
        {error}
      </p>
      {saved ? <p role="status">{saved}</p> : null}
    </form>
  );
}
