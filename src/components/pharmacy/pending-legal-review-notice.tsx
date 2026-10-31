import { StatusPill } from '@/components/ui/status-pill';

export function PendingLegalReviewNotice({
  provinceName,
  scope = 'branch',
}: {
  provinceName: string;
  scope?: 'branch' | 'draft';
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 sm:flex-row sm:items-center"
      role="status"
    >
      <StatusPill status="Pending legal review" tone="warning" />
      <p className="text-sm text-text-body">
        {scope === 'draft' ? (
          <>
            {provinceName} rules for the new version are pending legal review. This version can be
            recorded, but it cannot permit dispensing or activation until confirmed rules and a
            valid profile are in force.
          </>
        ) : (
          <>
            {provinceName} rules are pending legal review. Regulatory profiles can still be
            recorded, but dispensing and activation remain blocked until confirmed rules and a valid
            profile are in force.
          </>
        )}
      </p>
    </div>
  );
}
