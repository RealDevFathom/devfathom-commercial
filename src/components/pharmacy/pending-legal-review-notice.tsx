import { StatusPill } from '@/components/ui/status-pill';

export function PendingLegalReviewNotice({ provinceName }: { provinceName: string }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 sm:flex-row sm:items-center"
      role="status"
    >
      <StatusPill status="Pending legal review" tone="warning" />
      <p className="text-sm text-text-body">
        {provinceName} rules are pending legal review. Records can still be created, but these
        provincial rules are not enforced until legal sign-off.
      </p>
    </div>
  );
}
