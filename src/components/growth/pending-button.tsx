'use client';

import type { ComponentProps } from 'react';
import { useFormStatus } from 'react-dom';

import { Button } from '@/components/ui/button';

export function PendingButton({
  pendingLabel,
  children,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button {...props} type="submit" aria-busy={pending} disabled={pending || disabled}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
