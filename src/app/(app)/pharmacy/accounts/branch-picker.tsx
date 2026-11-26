import { canOpenPharmacyFinance, financeBranchWhere } from '@/lib/pharmacy/finance-access';
import { SelectField as StudioSelect } from '@/components/ui/select-field';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';

export type BranchOption = { id: string; name: string };

/** Active branches available to the signed-in accounts reader. The router repeats admission on use. */
export async function loadBranchOptions(): Promise<BranchOption[]> {
  try {
    const actor = await resolveTenantActor();
    if (!actor) return [];
    const ctx = await createTRPCContext({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
    if (!ctx.session?.user || !(await canOpenPharmacyFinance(ctx))) return [];
    return await ctx.db.pharmacyBranch.findMany({
      where: financeBranchWhere(actor.organization.id, ctx.session.user),
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
