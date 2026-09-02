import {
  ReadinessChecklist,
  type ReadinessChecklistRow,
} from '@/components/onboarding/readiness-checklist';
import type { SetupChecklist } from '@/lib/onboarding/setup-evaluator';

const state: Record<SetupChecklist['items'][number]['status'], ReadinessChecklistRow['state']> = {
  Done: 'DONE',
  'Needs you': 'NEEDS_YOU',
  Optional: 'OPTIONAL',
};

export function FirstRunChecklist({ checklist }: { checklist: SetupChecklist }) {
  if (checklist.complete) return null;

  const rows: ReadinessChecklistRow[] = checklist.items.map((item, index) => ({
    key: item.key,
    step: index + 1,
    label: item.label,
    state: state[item.status],
    why: item.why,
    href: item.href,
    linkLabel: item.actionLabel,
  }));

  return (
    <div className="mb-5" data-testid="first-run-checklist">
      <ReadinessChecklist
        rows={rows}
        eyebrow="First run"
        title="Open for your first sale"
        description="Follow these links in order. Progress updates automatically from your workspace data."
      />
    </div>
  );
}
