'use client';

import type { ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';

type PasswordInputProps = Omit<ComponentProps<'input'>, 'type'> & {
  revealed: boolean;
  onReveal: () => void;
};

export function PasswordInput({ revealed, onReveal, className, ...props }: PasswordInputProps) {
  return (
    <div className="relative">
      <input
        {...props}
        type={revealed ? 'text' : 'password'}
        data-password-reveal
        className={cn(className, 'pe-12')}
      />
      <button
        type="button"
        onClick={onReveal}
        aria-label={revealed ? 'Hide password' : 'Show password'}
        aria-pressed={revealed}
        className="absolute end-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
