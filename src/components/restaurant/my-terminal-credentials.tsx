'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { trpc } from '@/lib/trpc';

export function MyTerminalCredentials() {
  const list = trpc.restaurantStaff.myTerminalCredentials.useQuery();
  const [selected, setSelected] = useState<string | null>(null);
  const revoke = trpc.restaurantStaff.revokeMyTerminalCredential.useMutation({
    onSuccess: () => {
      setSelected(null);
      void list.refetch();
    },
  });
  return (
    <SectionCard title="Your terminal credentials" titleLevel={2}>
      {list.isLoading ? (
        <p role="status">Loading credentials…</p>
      ) : list.isError ? (
        <p role="alert">Your terminal credentials could not be loaded.</p>
      ) : list.data?.length ? (
        <ul className="space-y-2">
          {list.data.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {row.type === 'BADGE' ? 'Badge' : 'Device PIN'} ·{' '}
                {row.device?.name ?? 'Any active device'}
              </span>
              <Button
                className="min-h-11"
                variant="outline"
                onClick={() => {
                  revoke.reset();
                  setSelected(row.id);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No active badges or device PINs.</p>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke your terminal credential?</DialogTitle>
            <DialogDescription>This credential will stop working immediately.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const currentPassword = String(
                new FormData(event.currentTarget).get('currentPassword')
              );
              event.currentTarget.reset();
              if (selected) revoke.mutate({ credentialId: selected, currentPassword });
            }}
          >
            <label className="grid gap-2">
              Your current password
              <Input
                className="h-11"
                type="password"
                autoComplete="current-password"
                name="currentPassword"
                required
              />
            </label>
            {revoke.error && (
              <p role="alert" className="text-sm text-destructive">
                {revoke.error.message}
              </p>
            )}
            <DialogFooter>
              <Button
                className="min-h-11"
                type="button"
                variant="outline"
                disabled={revoke.isPending}
                onClick={() => setSelected(null)}
              >
                Cancel
              </Button>
              <Button
                className="min-h-11"
                variant="destructive"
                type="submit"
                disabled={revoke.isPending}
              >
                {revoke.isPending ? 'Revoking…' : 'Revoke credential'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
