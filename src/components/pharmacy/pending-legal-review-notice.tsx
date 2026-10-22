import { StatusPill } from '@/components/ui/status-pill';

export function PendingLegalReviewNotice({ message }: { message: string }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-text-body sm:flex-row sm:items-center"
      role="status"
    >
      <StatusPill status="Pending legal review" tone="warning" />
      <p>{message}</p>
    </div>
  );
}
