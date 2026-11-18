/**
 * DEV-913: record the branch of the record a mutation acts on (a camera, a sale
 * line, a purchase order) when its request names no branch. `recordTrpcAudit`
 * stores it as `metadata.branchId`, so the entry is filterable by branch and a
 * branch-limited administrator sees it. Call it as soon as the record is
 * loaded, so a refusal after that point is tagged as well.
 *
 * A record with no branch (a central purchase order) leaves the entry
 * workspace-wide: the owner sees it, a branch-limited administrator does not.
 * No-op outside a tRPC request.
 *
 * Kept apart from `@/server/audit` so router tests that replace that module
 * still run the real tagging.
 */
export function annotateAuditBranch(
  ctx: { audit?: { detail: { metadata?: Record<string, unknown> } } },
  branchId: string | null | undefined
): void {
  if (!branchId || !ctx?.audit) return;
  ctx.audit.detail.metadata = { ...(ctx.audit.detail.metadata ?? {}), branchId };
}
