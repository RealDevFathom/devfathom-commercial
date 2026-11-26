'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export function TerminalWebhookKeyControl({
  branchId,
  configId,
  terminal,
}: {
  branchId: string;
  configId: string;
  terminal: string;
}) {
  const { client } = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState('');
  async function issue() {
    setPending(true);
    setMessage('');
    try {
      // Keep the one-time plaintext out of the shared mutation cache.
      const result = await client.restaurantPayments.rotateTerminalWebhookSecret.mutate({
        branchId,
        configId,
      });
      setSecret(result.secret);
    } catch {
      setMessage('Could not confirm the new signing key. Check your access and try again.');
    } finally {
      setPending(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setMessage('Signing key copied.');
    } catch {
      setMessage('Select the signing key and copy it manually.');
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        setSecret('');
        setMessage('');
      }}
    >
      <DialogTrigger render={<Button variant="outline" className="min-h-11" />}>
        Set signing key
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="motion-reduce:animate-none">
        <DialogHeader>
          <DialogTitle>
            {secret ? 'Save the signing key' : 'Set signing key'} for {terminal}
          </DialogTitle>
          <DialogDescription>
            {secret
              ? 'Save this key now. It cannot be shown again.'
              : 'This creates a new signing key. The previous terminal key works for 24 hours. Creating the first key turns off shared-key signing for all of this provider’s terminals in your business.'}
          </DialogDescription>
        </DialogHeader>
        {secret && (
          <Input
            aria-label="Signing key"
            readOnly
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
        <p role="status" className="empty:hidden text-sm text-text-muted">
          {message}
        </p>
        <DialogFooter>
          <DialogClose
            disabled={pending}
            render={<Button variant="outline" className="min-h-11" />}
          >
            {secret ? 'Done' : 'Cancel'}
          </DialogClose>
          {secret ? (
            <Button className="min-h-11" onClick={() => void copy()}>
              Copy key
            </Button>
          ) : (
            <Button className="min-h-11" disabled={pending} onClick={() => void issue()}>
              {pending ? 'Creating key…' : 'Create new key'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
