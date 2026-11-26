'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc';

export function LateControlledReviewForm({
  reviewItemId,
  onRecorded,
  onDirtyChange,
  onPendingChange,
  disabled,
}: {
  reviewItemId: string;
  onRecorded: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [saved, setSaved] = useState(false);
  const review = trpc.pharmacyDispensing.selfSignReview.useMutation();
  const locked = disabled || review.isPending || saved;
  return (
    <form
      aria-label="Record a late controlled sale entry"
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (locked || !reason.trim() || !/^\d{4,8}$/.test(pin)) return;
        onPendingChange?.(true);
        try {
          await review.mutateAsync({ reviewItemId, reason: reason.trim(), pin });
          setSaved(true);
          onDirtyChange?.(false);
          await onRecorded();
        } catch {
          // The mutation exposes the refusal below. Once saved, a read failure cannot resubmit it.
        } finally {
          setPin('');
          onPendingChange?.(false);
        }
      }}
    >
      <p className="text-sm text-text-body">
        This medicine became controlled after it was rung up. Record the original sale as a late
        entry.
      </p>
      <Label htmlFor={id + '-reason'}>Reason for the late entry</Label>
      <Textarea
        id={id + '-reason'}
        value={reason}
        required
        maxLength={500}
        disabled={locked}
        onChange={(e) => {
          setReason(e.target.value);
          onDirtyChange?.(Boolean(e.target.value || pin));
        }}
      />
      <Label htmlFor={id + '-code'}>Your PIN or authenticator code</Label>
      <Input
        id={id + '-code'}
        type="password"
        autoComplete="off"
        inputMode="numeric"
        maxLength={8}
        value={pin}
        disabled={locked}
        onChange={(e) => {
          setPin(e.target.value);
          onDirtyChange?.(Boolean(e.target.value || reason));
        }}
      />
      <Button type="submit" disabled={locked || !reason.trim() || !/^\d{4,8}$/.test(pin)}>
        Record late entry
      </Button>
      {review.error && (
        <p role="alert" className="text-sm text-destructive">
          {review.error.message}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-text-body">
          Late entry recorded.
        </p>
      )}
    </form>
  );
}
