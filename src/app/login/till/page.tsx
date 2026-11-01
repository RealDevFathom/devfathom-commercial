import { AuthShell } from '@/components/auth/auth-shell';
export const metadata = { title: 'Unlock this till' };
export default function TillLoginPage() {
  return (
    <AuthShell vertical="restaurant" context="Operator control">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent-brand">
        Operator control
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em]">Unlock this till</h1>
      <p className="mt-4 text-sm leading-7 text-text-muted">
        Continue to your enrolled terminal, choose your name, then enter your own PIN. PIN
        verification happens on the terminal linked to your branch.
      </p>
      <div className="mt-8 rounded-[var(--radius-md)] border border-border-default bg-surface-card p-5 text-sm leading-7">
        <h2 className="font-semibold">Use your branch’s enrolled device</h2>
        <p className="mt-2 text-text-muted">
          Open this page on your restaurant’s workspace address. A manager must enrol the device
          before a staff PIN can unlock it.
        </p>
        <a href="/pos" className="studio-auth-link mt-5 inline-block">
          Continue to terminal PIN unlock →
        </a>
      </div>
      <p className="mt-8 text-xs leading-6 text-text-muted">
        Refunds and voids may also require a manager’s PIN.
      </p>
      <a href="/login?vertical=restaurant" className="studio-auth-link mt-4 inline-block text-sm">
        Manager or owner? Sign in with email →
      </a>
    </AuthShell>
  );
}
