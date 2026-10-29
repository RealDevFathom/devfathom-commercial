import type { ReactNode } from 'react';
import { AuthShell } from './auth-shell';

/** Recovery routes retain their context while sharing the product auth shell. */
export function AuthRecoveryShell({ children, context }: { children: ReactNode; context: string }) {
  return <AuthShell context={context}>{children}</AuthShell>;
}
