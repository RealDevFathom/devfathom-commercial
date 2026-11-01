import { Input } from '@/components/ui/input';

/** Shared Studio control for the explicit solo-owner exception. Never prefill a PIN. */
export function SoloApprovalPin({ required = false }: { required?: boolean }) {
  return (
    <label className="block min-w-0 space-y-1 text-sm text-text-body">
      <span>Owner PIN</span>
      <Input
        aria-label="Owner PIN"
        name="pin"
        type="password"
        inputMode="numeric"
        autoComplete="current-password"
        minLength={4}
        maxLength={8}
        pattern="[0-9]{4,8}"
        required={required}
        className="min-h-11"
      />
      <span className="block text-xs text-text-muted">
        Required for self-approval by the sole active owner. Your decision is audited.
      </span>
    </label>
  );
}
