import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { shiftDay } from '@/lib/pharmacy/marketing-dates';
import {
  VOUCHER_MAX_USES,
  VOUCHER_MAX_VALIDITY_DAYS,
  VOUCHER_TOTAL_VALUE_CAP_MINOR,
  VOUCHER_VALUE_CAP_MINOR,
} from '@/lib/pharmacy/voucher-controls';
import { workspaceTimezone } from '@/lib/timezone';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';
import { MarketingActionForm } from './action-form';

const control =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:bg-muted disabled:text-text-muted';

export type VoucherPanelVoucher = {
  id: string;
  code: string;
  name: string;
  discountMinor: number;
  maxUses: number;
  usedCount: number;
  validUntil: Date | string;
  active: boolean;
  revokedAt: Date | string | null;
  messages: { whatsapp: string; print: string };
};

export type VoucherApprover = { id: string; name: string; self: boolean };

type VoucherState = { status: string; label: string };

/** The voucher's state at the counter, in the order the server refuses a redemption. */
export function voucherState(voucher: VoucherPanelVoucher, now = new Date()): VoucherState {
  if (voucher.revokedAt || !voucher.active) return { status: 'cancelled', label: 'Revoked' };
  if (new Date(voucher.validUntil).getTime() <= now.getTime())
    return { status: 'overdue', label: 'Expired' };
  if (voucher.usedCount >= voucher.maxUses) return { status: 'completed', label: 'Used up' };
  return { status: 'active', label: 'Active' };
}

function lastDayLabel(validUntil: Date | string, timeZone: string) {
  // `validUntil` is the start of the day after the last valid day.
  const lastDay = new Date(new Date(validUntil).getTime() - 1);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(lastDay);
}

/**
 * DEV-780: the owner issues vouchers here and sees how many uses each has left. Every rule
 * (value caps, second approver, expiry window, use limit, non-drug items only) is enforced by
 * the server when the voucher is issued and again when a cashier redeems it.
 */
export function VoucherPanel({
  branchId,
  vouchers,
  approvers,
  unavailable,
  timeZone,
}: {
  branchId: string;
  vouchers: VoucherPanelVoucher[] | null;
  approvers: VoucherApprover[];
  unavailable: boolean;
  timeZone?: string;
}) {
  const zone = workspaceTimezone(timeZone);
  const today = pharmacyCalendarDay(zone);
  const lastAllowedDay = shiftDay(today, VOUCHER_MAX_VALIDITY_DAYS - 1);
  const selfOnly = approvers.length > 0 && approvers.every((approver) => approver.self);
  return (
    <SectionCard title="Vouchers" titleLevel={2}>
      <div className="space-y-6">
        <p className="text-sm text-text-body">
          A voucher takes a fixed amount off one non-drug item. Cashiers enter or scan the code at
          the counter and confirm with their own PIN. Each use counts against the limit you set
          here; once it is reached, the counter refuses the voucher.
        </p>
        {unavailable && (
          <p role="alert" className="text-sm text-text-body">
            Vouchers could not be loaded. Reload before issuing or revoking one.
          </p>
        )}
        <MarketingActionForm
          branchId={branchId}
          operation="voucher-issue"
          label="Issue voucher"
          timeZone={zone}
          disabled={unavailable}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              Voucher code
              <Input
                className="mt-1 min-h-11 font-mono uppercase"
                name="code"
                required
                minLength={3}
                maxLength={40}
                pattern="[A-Za-z0-9\-]+"
                autoComplete="off"
                aria-describedby="voucher-code-help"
              />
            </label>
            <label className="block text-sm">
              Voucher name
              <Input className="mt-1 min-h-11" name="name" required maxLength={100} />
            </label>
            <label className="block text-sm">
              Value per use (Rs)
              <Input
                className="mt-1 min-h-11"
                name="discountRupees"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                required
                defaultValue={100}
              />
            </label>
            <label className="block text-sm">
              Uses allowed
              <Input
                className="mt-1 min-h-11"
                name="maxUses"
                type="number"
                inputMode="numeric"
                min={1}
                max={VOUCHER_MAX_USES}
                step={1}
                required
                defaultValue={1}
                aria-describedby="voucher-uses-help"
              />
            </label>
            <label className="block text-sm sm:col-span-2">
              Last day it can be used
              <Input
                className="mt-1 min-h-11"
                name="validUntil"
                type="date"
                required
                min={today}
                max={lastAllowedDay}
                defaultValue={shiftDay(today, 29)}
              />
            </label>
          </div>
          <p id="voucher-code-help" className="text-sm text-text-muted">
            Letters, numbers and dashes. Codes are stored in capitals and are unique in this branch.
          </p>
          <p id="voucher-uses-help" className="text-sm text-text-muted">
            The counter stops accepting the voucher after this many redemptions, even when two
            counters try it at the same moment.
          </p>
          <label className="block text-sm">
            Message for customers
            <textarea
              className={`${control} min-h-28 py-3`}
              name="body"
              required
              maxLength={1000}
              aria-describedby="voucher-copy-help"
            />
          </label>
          <p id="voucher-copy-help" className="text-sm text-text-muted">
            Use generic retail copy. Do not name medicines, conditions or patients. The required
            footer is added for print and WhatsApp.
          </p>
          <fieldset className="space-y-3 rounded-md border border-border-subtle p-4">
            <legend className="px-1 text-sm font-medium">Approval above the value cap</legend>
            <p className="text-sm text-text-muted">
              Needed when one use is worth more than Rs {formatMinor(VOUCHER_VALUE_CAP_MINOR)} or
              all uses together are worth more than Rs {formatMinor(VOUCHER_TOTAL_VALUE_CAP_MINOR)}.{' '}
              {selfOnly
                ? 'You are the only approver, so re-enter your own PIN; the approval is recorded.'
                : 'A different manager or owner approves with their own PIN.'}
            </p>
            {approvers.length ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  Approver
                  <select className={control} name="approverId" defaultValue={approvers[0]!.id}>
                    {approvers.map((approver) => (
                      <option key={approver.id} value={approver.id}>
                        {approver.name}
                        {approver.self ? ' (you)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  Approver PIN
                  <Input
                    className="mt-1 min-h-11"
                    name="approverPin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    pattern="\d{4,8}"
                    maxLength={8}
                  />
                </label>
              </div>
            ) : (
              <p className="text-sm text-text-body">
                No manager or owner has a counter PIN yet, so only vouchers within the cap can be
                issued.
              </p>
            )}
          </fieldset>
          <label className="flex items-start gap-2 text-sm">
            <input className="mt-1 size-5" type="checkbox" name="reviewed" required />I reviewed the
            code, value, use limit and message.
          </label>
        </MarketingActionForm>
        {vouchers && !vouchers.length && (
          <p className="text-sm text-text-muted">
            No vouchers yet. Issue one above, then hand out the printed or WhatsApp text.
          </p>
        )}
        {vouchers && vouchers.length > 0 && (
          <div
            role="region"
            aria-label="Issued vouchers"
            tabIndex={0}
            className="relative overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <table className="w-full text-left text-sm">
              <thead className="font-mono text-xs uppercase text-text-muted">
                <tr>
                  <th className="p-3">Code</th>
                  <th className="p-3">Name</th>
                  <th className="p-3 text-right">Value (Rs)</th>
                  <th className="p-3 text-right">Uses</th>
                  <th className="p-3">Last day</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {vouchers.map((voucher) => {
                  const state = voucherState(voucher);
                  return (
                    <tr
                      key={voucher.id}
                      className="border-t border-border-subtle align-top hover:bg-surface-sunken"
                    >
                      <td className="p-3 font-mono text-xs">{voucher.code}</td>
                      <td className="p-3">{voucher.name}</td>
                      <td className="p-3 text-right tabular-nums">
                        {formatMinor(voucher.discountMinor)}
                      </td>
                      <td className="whitespace-nowrap p-3 text-right tabular-nums">
                        {voucher.usedCount} of {voucher.maxUses}
                      </td>
                      <td className="whitespace-nowrap p-3 font-mono text-xs">
                        {lastDayLabel(voucher.validUntil, zone)}
                      </td>
                      <td className="p-3">
                        <StatusPill status={state.status} label={state.label} />
                      </td>
                      <td className="p-3 text-right">
                        <details className="text-left">
                          <summary className="inline-flex min-h-11 cursor-pointer items-center underline focus-visible:outline-2 focus-visible:outline-ring">
                            Details<span className="sr-only"> for {voucher.code}</span>
                          </summary>
                          <div className="mt-3 min-w-64 space-y-4">
                            <div>
                              <p className="font-mono text-xs uppercase text-text-muted">
                                WhatsApp text
                              </p>
                              <p className="whitespace-pre-wrap break-words">
                                {voucher.messages.whatsapp}
                              </p>
                            </div>
                            <div>
                              <p className="font-mono text-xs uppercase text-text-muted">
                                Printed text
                              </p>
                              <p className="whitespace-pre-wrap break-words">
                                {voucher.messages.print}
                              </p>
                            </div>
                            {state.label !== 'Revoked' && (
                              <MarketingActionForm
                                branchId={branchId}
                                operation="voucher-revoke"
                                label="Revoke voucher"
                              >
                                <input type="hidden" name="voucherId" value={voucher.id} />
                                <label className="block text-sm">
                                  Reason
                                  <Input
                                    className="mt-1 min-h-11"
                                    name="reason"
                                    required
                                    minLength={3}
                                    maxLength={300}
                                  />
                                </label>
                                <label className="flex items-start gap-2 text-sm">
                                  <input
                                    className="mt-1 size-5"
                                    type="checkbox"
                                    name="confirmed"
                                    required
                                  />
                                  Stop this voucher working. This cannot be undone.
                                </label>
                              </MarketingActionForm>
                            )}
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
