import { PageTransition } from '@/components/motion/page-transition';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

const actions = [
  ['Clock in', 'Server time records attendance and flags late arrivals.'],
  ['Start or end break', 'Only one active break is allowed during a clocked-in shift.'],
  ['Clock out', 'An active break must be ended before the shift can close.'],
  ['Request a swap', 'Managers approve a named replacement from the same branch.'],
] as const;

export default function RestaurantWorkforcePage() {
  return (
    <PageTransition className="space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Workforce"
        description="Schedule branch shifts, record attendance, and review swap requests from one branch-scoped workspace."
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <SectionCard eyebrow="Schedule" title="Today’s branch roster">
          <div className="overflow-x-auto rounded-md border border-border-subtle">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="bg-surface-sunken font-mono text-[0.6875rem] tracking-wide text-text-muted uppercase">
                <tr>
                  <th className="px-4 py-3 font-medium">Operator</th>
                  <th className="px-4 py-3 font-medium">Shift</th>
                  <th className="px-4 py-3 font-medium">Attendance</th>
                  <th className="px-4 py-3 font-medium">Swap</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-text-muted">
                    Select a branch to load its roster. No raw branch or operator IDs are required.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard eyebrow="Attendance" title="Server-timestamped actions">
          <ul className="space-y-4">
            {actions.map(([label, description]) => (
              <li
                key={label}
                className="rounded-md border border-border-subtle bg-surface-sunken p-4"
              >
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="font-medium text-text-strong">{label}</span>
                  <StatusPill status="Available on shift" tone="neutral" />
                </div>
                <p className="text-sm leading-relaxed text-text-muted">{description}</p>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      <SectionCard eyebrow="States" title="Safe operational feedback">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ['Loading', 'Roster controls remain disabled while branch data loads.'],
            ['Empty', 'A clear empty roster points managers to scheduling.'],
            ['Error', 'Failed actions preserve the shift and offer a retry.'],
            [
              'Permission denied',
              'Actors without staff management access cannot mutate attendance.',
            ],
          ].map(([state, detail]) => (
            <div key={state} className="rounded-md border border-border-subtle p-4">
              <p className="font-medium text-text-strong">{state}</p>
              <p className="mt-1 text-sm leading-relaxed text-text-muted">{detail}</p>
            </div>
          ))}
        </div>
      </SectionCard>
    </PageTransition>
  );
}
