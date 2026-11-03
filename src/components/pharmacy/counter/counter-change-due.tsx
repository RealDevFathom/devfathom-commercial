import { formatMinor } from '@/lib/pharmacy/counter-receipt';

export function CounterChangeDue({ minor }: { minor: number | null | undefined }) {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor <= 0) return null;
  return (
    <section
      aria-label="Change due"
      aria-live="polite"
      className="flex flex-wrap items-end justify-between gap-3 rounded-md border border-success/20 bg-success/10 p-4"
    >
      <p className="min-w-0 space-y-2">
        <span className="block font-mono text-xs tracking-wide text-success uppercase">
          Change due
        </span>
        <span className="block text-3xl font-semibold tracking-tight break-all tabular-nums text-text-strong">
          {formatMinor(minor)}
        </span>
      </p>
      <span className="font-mono text-xs text-success">PKR</span>
    </section>
  );
}
