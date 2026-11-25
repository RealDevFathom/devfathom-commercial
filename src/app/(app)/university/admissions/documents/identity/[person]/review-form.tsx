'use client';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { reviewIdentity, type EvidenceState } from './actions';
export function ReviewForm({ person, admin }: { person: string; admin: boolean }) {
  const [state, submit, pending] = useActionState<EvidenceState, FormData>(
    reviewIdentity.bind(null, person),
    { message: '' }
  );
  return (
    <form action={submit} className="grid max-w-xl gap-3">
      <label>
        Review reason or evidence reference
        <Input name="reason" className="min-h-11" maxLength={500} required />
      </label>
      {state.review ? (
        <>
          <p className="break-words">
            {state.review.fullName} · {state.review.kind} · <bdi>{state.review.number}</bdi>
          </p>
          <input type="hidden" name="reviewId" value={state.review.id} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" name="action" value="verify" disabled={pending}>
              Verify identity
            </Button>
            <Button
              type="submit"
              name="action"
              value="correct"
              variant="outline"
              disabled={pending}
            >
              Request correction
            </Button>
          </div>
        </>
      ) : (
        <Button type="submit" name="action" value="open" disabled={pending}>
          Inspect identification
        </Button>
      )}
      {admin && (
        <details className="border-t border-border-subtle py-3">
          <summary>Link verified person to a staff account</summary>
          <label>
            Active staff email
            <Input name="email" className="min-h-11" type="email" maxLength={254} />
          </label>
          <Button type="submit" name="action" value="link" disabled={pending} variant="outline">
            Link staff account
          </Button>
        </details>
      )}
      <p role="status" aria-live="polite">
        {state.message}
      </p>
    </form>
  );
}
