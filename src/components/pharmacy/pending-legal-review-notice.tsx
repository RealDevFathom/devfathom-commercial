import { StatusPill } from '@/components/ui/status-pill';

export function PendingLegalReviewNotice({ provinceName }: { provinceName: string }) {
  return (
    <div
      className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-text-body"
      role="status"
    >
      <StatusPill status="Pending legal review" tone="warning" />
      <p className="mt-2">
        {provinceName} rules are provisional and await legal sign-off. Dispensing and activation
        remain blocked while these rules are unconfirmed. Recording a profile does not approve them
        for production use.
      </p>
    </div>
  );
}
