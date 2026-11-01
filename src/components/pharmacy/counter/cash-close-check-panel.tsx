'use client';

import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

const SEVERITY_TONE = { URGENT: 'danger', REVIEW: 'warning', NOTICE: 'info' } as const;
const SEVERITY_LABEL = { URGENT: 'Urgent', REVIEW: 'Review', NOTICE: 'Notice' } as const;

/**
 * #728 — the owner's read-only cash-close anomaly check for one branch/day.
 * It only reads: there is no action here that changes the close, a drawer or
 * the books. Rendered inside the owner-only day-close console.
 */
export function CashCloseCheckPanel({ branchId, date }: { branchId: string; date: string }) {
  const check = trpc.pharmacySales.closeAnomalyCheck.useQuery(
    { branchId, businessDate: new Date(`${date}T00:00:00.000Z`) },
    { refetchOnWindowFocus: false }
  );
  if (check.isLoading)
    return (
      <SectionCard title="Cash-close check" titleLevel={2}>
        <p role="status">Checking close variance, refunds and voids…</p>
      </SectionCard>
    );
  // A refusal (owner explicitly denied `reports:financial`, or not the owner) is
  // permanent: say so instead of offering a retry that can never succeed.
  if (check.error?.data?.code === 'FORBIDDEN')
    return (
      <SectionCard title="Cash-close check" titleLevel={2}>
        <p role="status">
          You don&apos;t have permission to view the cash-close check. The close itself is
          unaffected.
        </p>
      </SectionCard>
    );
  if (check.error || !check.data)
    return (
      <SectionCard title="Cash-close check" titleLevel={2}>
        <p role="alert">
          The cash-close check is unavailable. The close itself is unaffected.{' '}
          <Button variant="outline" onClick={() => void check.refetch()}>
            Retry check
          </Button>
        </p>
      </SectionCard>
    );
  const data = check.data;
  const [summary] = data.narrative.split('\n');
  return (
    <SectionCard
      title="Cash-close check"
      titleLevel={2}
      actions={
        <StatusPill
          status={data.findings.length ? `${data.findings.length} to review` : 'No flags'}
          tone={
            data.findings.some((finding) => finding.severity === 'URGENT')
              ? 'danger'
              : data.findings.length
                ? 'warning'
                : 'success'
          }
        />
      }
    >
      <div className="space-y-4">
        <p>{summary}</p>
        {data.findings.length > 0 && (
          <ul className="space-y-3" aria-label="Cash-close review items">
            {data.findings.map((finding, index) => (
              <li
                key={`${finding.kind}:${index}`}
                className="flex flex-wrap items-start gap-3 border-b border-border-subtle pb-3"
              >
                <StatusPill
                  status={SEVERITY_LABEL[finding.severity]}
                  tone={SEVERITY_TONE[finding.severity]}
                />
                <span className="min-w-0 flex-1">{finding.explanation}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-text-muted">
          Read-only review prompts from recorded events (policy {data.policyVersion}), not findings
          of misconduct. Nothing is posted, reopened or sent.
        </p>
      </div>
    </SectionCard>
  );
}
