import { SelectField as StudioSelect } from '@/components/ui/select-field';import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';

export type BranchOption = { id: string; name: string };

/**
 * DEV-103: the branches the accounts pages offer in their branch picker. Every accounts page
 * that takes a branch (supplier expense aging, general journal, journal entry lookup, posted cash
 * coverage, trial-balance control) is an owner finance read: its router refuses anyone who is not
 * an owner-level (ADMIN) member and any branch that is not an active branch of the signed-in
 * organization, and an owner may act at every such branch. So the picker lists exactly those, by
 * name, and nothing to anyone else. It reads only branch names; the page's router still checks
 * the chosen branch, so a branch typed into the URL that is not listed is still refused there.
 */
export async function loadBranchOptions(): Promise<BranchOption[]> {
  try {
    const actor = await resolveTenantActor();
    if (!actor) return [];
    const ctx = await createTRPCContext({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
    if (ctx.session?.user?.role !== 'ADMIN') return [];
    return await ctx.db.pharmacyBranch.findMany({
      where: { organizationId: actor.organization.id, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  } catch {
    return [];
  }
}

/**
 * The branch field of an accounts page's GET form: the listed branches by name. A branch in the
 * URL that is not listed shows the prompt, never another branch.
 */
export function BranchSelect({
  branchId,
  branches,
  describedBy,
  invalid,
  id,
  name = 'branch',
}: {
  branchId?: string | null;
  branches: BranchOption[];
  describedBy?: string;
  invalid?: boolean;
  id?: string;
  /** The query parameter the page reads the branch from. */
  name?: string;
}) {
  return (
    <StudioSelect
      id={id}
      className="min-h-11 w-full min-w-0 rounded-md border border-input bg-surface-card px-2.5 text-sm text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
      name={name}
      defaultValue={branchId ?? ''}
      required
      aria-describedby={describedBy}
      aria-invalid={invalid ? true : undefined}
    >
      {/* Not disabled: a branch in the URL that is not listed must show this prompt, never another branch. */}
      <option value="">Choose a branch</option>
      {branches.map((branch) => (
        <option key={branch.id} value={branch.id}>
          {branch.name}
        </option>
      ))}
    </StudioSelect>
  );
}
