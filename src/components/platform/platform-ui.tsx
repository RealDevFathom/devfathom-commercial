import { cn } from '@/lib/utils';

const statusTone: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-600',
  READY: 'bg-green-100 text-green-600',
  SUCCEEDED: 'bg-green-100 text-green-600',
  PAID: 'bg-green-100 text-green-600',
  WON: 'bg-green-100 text-green-600',
  ONBOARDING: 'bg-amber-100 text-amber-600',
  GRACE: 'bg-amber-100 text-amber-600',
  PENDING: 'bg-amber-100 text-amber-600',
  PENDING_SIGNATURE: 'bg-amber-100 text-amber-600',
  QUEUED: 'bg-amber-100 text-amber-600',
  PROVISIONING: 'bg-amber-100 text-amber-600',
  OVERDUE: 'bg-red-100 text-red-600',
  FAILED: 'bg-red-100 text-red-600',
  SUSPENDED: 'bg-red-100 text-red-600',
  TERMINATED: 'bg-red-100 text-red-600',
  PURGING: 'bg-red-100 text-red-600',
};

export function PlatformStatus({ value }: { value: string }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.1em]',
        statusTone[value] ?? 'bg-surface-sunken text-text-muted'
      )}
    >
      {value.replaceAll('_', ' ')}
    </span>
  );
}

export function PlatformPageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between gap-5 border-b border-border-default pb-7 md:flex-row md:items-end">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent-brand">
          {eyebrow}
        </p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-[-0.045em]">{title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}
