'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { changeMembership, type MembershipFormState } from './membership-actions';

const initial: MembershipFormState = { status: 'idle', message: '' };

/**
 * DEV-764: deactivate an enrolled member, or re-enrol a deactivated one, with a written reason.
 * Deactivating keeps the points; the member neither earns nor spends until re-enrolled.
 */
export function MembershipForm({
  branchId,
  customerId,
  loyaltyActive,
}: {
  branchId: string;
  customerId: string;
  loyaltyActive: boolean;
}) {
  const [state, action, pending] = useActionState(changeMembership, initial);
  const invalid = state.status === 'error';
  return (
    <form action={action} className="space-y-4" aria-describedby="membership-status">
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="change" value={loyaltyActive ? 'deactivate' : 'enrol'} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid w-full min-w-0 gap-2 text-sm sm:flex-1">
          {loyaltyActive ? 'Reason for deactivating' : 'Reason for re-enrolling'}
          <Input
            name="reason"
            required
            minLength={3}
            maxLength={500}
            placeholder={
              loyaltyActive
                ? 'e.g. Customer asked to leave the programme'
                : 'e.g. Customer rejoined'
            }
            aria-invalid={invalid || undefined}
            className="min-h-11"
          />
        </label>
        <Button
          type="submit"
          variant={loyaltyActive ? 'destructive' : 'default'}
          className="min-h-11"
          disabled={pending}
        >
          {pending ? 'Saving…' : loyaltyActive ? 'Deactivate member' : 'Re-enrol member'}
        </Button>
      </div>
      <p
        id="membership-status"
        aria-live="polite"
        className={`text-sm ${invalid ? 'text-destructive' : 'text-text-muted'}`}
      >
        {state.message ||
          (loyaltyActive
            ? 'Owner only: this applies at every branch. A deactivated member keeps their points but earns nothing and cannot redeem or be adjusted until re-enrolled. Recorded in the audit log with your name and reason.'
            : 'Owners and branch managers. Re-enrolling needs the customer’s current loyalty consent. Recorded in the audit log with your name and reason.')}
      </p>
    </form>
  );
}
