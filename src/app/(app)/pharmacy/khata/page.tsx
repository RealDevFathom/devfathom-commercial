import Link from 'next/link';
import { redirect, unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyKhataRouter } from './khata-router';
import { reminderOutcome } from './reminder-outcome';

export const metadata = { title: 'Khata · Pharmacy' };
const linkClass =
  'inline-flex min-h-11 items-center rounded-sm underline hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring';
const selectClass =
  'min-h-11 max-w-full rounded-sm border border-border bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring';
const money = (minor: number) => `PKR ${formatMinor(minor)}`;
/** DEV-943: a payment or due instant as the shop's own calendar day, not the UTC day. */
const day = (date: Date, timeZone: string | null | undefined) =>
  pharmacyCalendarDay(timeZone, date);

/** Result codes carried on the redirect back to the list. */
const notices: Record<string, { tone: 'status' | 'alert'; text: string }> = {
  'reminder-sent': { tone: 'status', text: 'WhatsApp reminder sent.' },
  'reminder-prepared': {
    tone: 'status',
    text: 'WhatsApp reminder prepared in sandbox mode. No message left the pharmacy.',
  },
  'reminder-sms-sent': {
    tone: 'status',
    text: 'Reminder sent by SMS because WhatsApp could not reach this payer.',
  },
  'reminder-sms-prepared': {
    tone: 'status',
    text: 'SMS reminder prepared in sandbox mode. No message left the pharmacy.',
  },
  'reminder-duplicate': {
    tone: 'status',
    text: 'This account was already reminded this week, or the customer already had a reminder today.',
  },
  'reminder-not-due': {
    tone: 'alert',
    text: 'No reminder sent: the account has no overdue balance of at least PKR 100.00.',
  },
  'reminder-no-consent': {
    tone: 'alert',
    text: 'No reminder sent: the payer has not consented to reminders or has no valid number.',
  },
  'reminder-quiet-hours': {
    tone: 'alert',
    text: 'No reminder sent: reminders go out only between 9 am and 10 pm. Try again during those hours.',
  },
  'reminder-not-configured': {
    tone: 'alert',
    text: 'No reminder sent: neither approved WhatsApp Khata templates nor an SMS sender are configured for this workspace.',
  },
  'reminder-failed': {
    tone: 'alert',
    text: 'The reminder could not be confirmed by WhatsApp. Check the message log before trying again.',
  },
  ACCOUNT_NOT_FOUND: {
    tone: 'alert',
    text: 'That Khata account is no longer active on this branch.',
  },
  FORBIDDEN: { tone: 'alert', text: 'Your role or package does not allow that action.' },
  error: { tone: 'alert', text: 'The action could not be completed. Nothing was changed; retry.' },
};

async function loadKhata(text: (key: string) => string) {
  try {
    const ctx = await createTRPCContext();
    const caller = pharmacyKhataRouter.createCaller(ctx);
    const branches = await caller.branches();
    if (!branches.length) return { state: 'empty' as const };
    const branchId = text('branchId') || branches[0]!.id;
    if (!branches.some((branch) => branch.id === branchId))
      throw new TRPCError({ code: 'NOT_FOUND' });
    const ledger = await caller.ledger({ branchId });
    // The caller's own organisation zone: dates on this screen are the shop's days.
    const timeZone = ctx.organization?.timezone ?? null;
    return { state: 'ready' as const, branches, branchId, timeZone, ...ledger };
  } catch (error) {
    unstable_rethrow(error);
    return {
      state: 'error' as const,
      denied: error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code),
    };
  }
}

function back(branchId: string, extra: Record<string, string>) {
  return `/pharmacy/khata?${new URLSearchParams({ branchId, ...extra })}`;
}

function failureCode(error: unknown) {
  if (error instanceof TRPCError) {
    if (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED') return 'FORBIDDEN';
    if (error.message in notices) return error.message;
  }
  return 'error';
}

async function sendReminder(formData: FormData) {
  'use server';
  const branchId = String(formData.get('branchId') ?? '');
  let code: string;
  try {
    const caller = pharmacyKhataRouter.createCaller(await createTRPCContext());
    const result = await caller.sendReminder({
      branchId,
      familyAccountId: String(formData.get('familyAccountId') ?? ''),
    });
    code = reminderOutcome(result);
  } catch (error) {
    unstable_rethrow(error);
    code = failureCode(error);
  }
  redirect(back(branchId, { notice: code }));
}

export default async function KhataPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const text = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  const header = (
    <PageHeader
      eyebrow="Pharmacy / customers"
      heading="Khata"
      description="See who owes what, collect payments and send WhatsApp reminders."
    />
  );
  const data = await loadKhata(text);
  if (data.state === 'error')
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard
          title={data.denied ? 'Khata access required' : 'Khata unavailable'}
          titleLevel={2}
        >
          <p role="alert">
            {data.denied
              ? 'An authorized owner and the Pharmacy counter package are required.'
              : 'The Khata ledger could not be loaded. Check the branch selection, then retry.'}
          </p>
          <Link className={linkClass} href="/pharmacy/khata">
            Reset selection and retry
          </Link>
        </SectionCard>
      </div>
    );
  if (data.state === 'empty')
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard title="No active branch" titleLevel={2}>
          <p>An owner must activate a pharmacy branch before its Khata can be viewed.</p>
        </SectionCard>
      </div>
    );

  const { branches, branchId, accounts, truncated } = data;
  const branchName = branches.find((branch) => branch.id === branchId)!.name;
  const notice = notices[text('notice')];
  const owing = accounts.filter((account) => account.balanceMinor > 0);
  const totalMinor = owing.reduce((sum, account) => sum + account.balanceMinor, 0);
  const overdueCount = owing.filter((account) => account.oldestOverdueAt).length;

  return (
    <div className="min-w-0 space-y-6">
      {header}
      {notice && (
        <p
          role={notice.tone}
          className={`rounded-md border p-4 text-sm ${
            notice.tone === 'alert'
              ? 'border-destructive/40 text-destructive'
              : 'border-success/40 text-success'
          }`}
        >
          {notice.text}
        </p>
      )}
      <SectionCard title="Branch" titleLevel={2}>
        <form action="/pharmacy/khata" method="get" className="flex flex-wrap items-end gap-3">
          <label className="grid w-full gap-2 text-sm sm:w-auto">
            Branch
            <select name="branchId" defaultValue={branchId} className={selectClass}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" className="min-h-11">
            Show branch
          </Button>
        </form>
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <Stat label="Total owed" value={money(totalMinor)} />
          <Stat label="Accounts owing" value={owing.length} />
          <Stat label="Overdue accounts" value={overdueCount} />
        </div>
      </SectionCard>

      <SectionCard title={`Who owes what · ${branchName}`} titleLevel={2}>
        {accounts.length ? (
          <div className="overflow-x-auto" role="region" aria-label="Khata accounts" tabIndex={0}>
            <table className="w-full text-sm">
              <caption className="sr-only">
                Khata balances at {branchName}, largest balance first
              </caption>
              <thead className="font-mono text-xs uppercase">
                <tr>
                  {[
                    'Account',
                    'Phone',
                    'Balance',
                    'Limit',
                    'Last payment',
                    'Status',
                    'Actions',
                  ].map((t) => (
                    <th
                      key={t}
                      scope="col"
                      className={`p-3 ${
                        ['Balance', 'Limit', 'Actions'].includes(t) ? 'text-right' : 'text-left'
                      }`}
                    >
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="border-t border-border-subtle hover:bg-surface-sunken">
                    <th scope="row" className="p-3 text-left font-normal">
                      <span className="block font-semibold break-words">{a.displayName}</span>
                      <span className="block text-xs break-words text-text-muted">
                        Payer: {a.payerName}
                      </span>
                    </th>
                    <td className="p-3 whitespace-nowrap">
                      {a.phoneLast4 ? `ending ${a.phoneLast4}` : 'Not recorded'}
                    </td>
                    <td className="p-3 text-right font-mono whitespace-nowrap tabular-nums">
                      {money(a.balanceMinor)}
                    </td>
                    <td className="p-3 text-right font-mono whitespace-nowrap tabular-nums">
                      {money(a.creditLimitMinor)}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      {a.lastPaymentAt ? (
                        <time dateTime={a.lastPaymentAt.toISOString()}>
                          {day(a.lastPaymentAt, data.timeZone)}
                        </time>
                      ) : (
                        'No payment yet'
                      )}
                    </td>
                    <td className="p-3">
                      {a.balanceMinor <= 0 ? (
                        <StatusPill status="Clear" tone="success" />
                      ) : a.oldestOverdueAt ? (
                        <StatusPill
                          status="Overdue"
                          label={`Overdue since ${day(a.oldestOverdueAt, data.timeZone)}`}
                        />
                      ) : a.balanceMinor > a.creditLimitMinor ? (
                        <StatusPill status="Over limit" tone="warning" />
                      ) : (
                        <StatusPill status="Owing" tone="info" />
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {a.balanceMinor > 0 ? (
                          <>
                            <Link
                              className={linkClass}
                              href={`/pharmacy/counter?${new URLSearchParams({ branchId })}`}
                              aria-label={`Collect payment from ${a.displayName} at the counter`}
                            >
                              Collect payment
                            </Link>
                            <form action={sendReminder}>
                              <input type="hidden" name="branchId" value={branchId} />
                              <input type="hidden" name="familyAccountId" value={a.id} />
                              <Button
                                type="submit"
                                variant="outline"
                                size="touch"
                                aria-label={`Send reminder to ${a.displayName}`}
                              >
                                Send reminder
                              </Button>
                            </form>
                          </>
                        ) : (
                          <span className="text-text-muted">Nothing owed</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p role="status">
            No Khata accounts on this branch yet. Charge a sale to Khata at the counter to open one.
          </p>
        )}
        {truncated && (
          <p role="status" className="mt-3 text-sm">
            Showing the first 500 accounts by name. Older accounts remain in the ledger.
          </p>
        )}
        <p className="mt-3 text-sm text-text-muted">
          Balances include every charge, payment, refund and dishonoured cheque on the account.
          Collect payment opens the counter, where Khata payment puts cash into that counter’s open
          drawer and records transfers with the payer’s reference. Reminders use the approved
          WhatsApp template, need the payer’s opt-in, and go at most once a week per account.
        </p>
      </SectionCard>
      <Link className={linkClass} href="/pharmacy/counter">
        Open counter
      </Link>
    </div>
  );
}
