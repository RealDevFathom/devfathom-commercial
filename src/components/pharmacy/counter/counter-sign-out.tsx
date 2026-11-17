'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { signOutEverything } from '@/lib/auth/sign-out';

/**
 * DEV-41: one-click sign-out from the counter. Confirms only while a sale is
 * open; signing out never completes or cancels that sale.
 */
export function CounterSignOut({ hasOpenSale }: { hasOpenSale: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);

  async function leave() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      await signOutEverything();
    } catch {
      setError('Sign-out failed. Please try again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <Button
        ref={buttonRef}
        variant="outline"
        size="touch"
        disabled={pending}
        onClick={() => (hasOpenSale ? setConfirming(true) : void leave())}
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </Button>
      {!confirming && error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          className="pharmacy-workspace [&_[data-slot=dialog-close]]:min-h-11 [&_[data-slot=dialog-close]]:min-w-11"
          finalFocus={buttonRef}
        >
          <DialogTitle>Sign out with an open sale?</DialogTitle>
          <DialogDescription>
            A sale is still open. Signing out will not complete or cancel it. Check any unfinished
            payment before taking more money when you return.
          </DialogDescription>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="touch" />}>
              Keep working
            </DialogClose>
            <Button size="touch" disabled={pending} onClick={() => void leave()}>
              {pending ? 'Signing out…' : 'Sign out'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
