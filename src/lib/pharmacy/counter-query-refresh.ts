type CounterQueryUtilities = {
  counterCart: { cancel: () => Promise<void>; invalidate: () => Promise<void> };
  counterReceipt: { invalidate: () => Promise<void> };
};

export async function refreshCounterQueries(utils: CounterQueryUtilities): Promise<void> {
  // A new sale enables its first cart read before addLine commits. Invalidation
  // alone reuses that pending read when no cached data exists (POS-09).
  // Cancel explicitly so the post-mutation read wins, even if transport ignores abort.
  await utils.counterCart.cancel();
  await utils.counterCart.invalidate();
  await utils.counterReceipt.invalidate();
}
