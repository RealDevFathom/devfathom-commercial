type LabelLookup = {
  count(args: {
    where: { id: { in: string[] }; boardId: string };
  }): Promise<number>;
};

/**
 * Verify that every requested label belongs to the task's exact board.
 *
 * Keeping the board predicate in the lookup is important: checking label IDs
 * for existence alone permits a caller to attach labels from another board.
 */
export async function labelsBelongToBoard(
  label: LabelLookup,
  boardId: string,
  labelIds: string[]
): Promise<boolean> {
  const uniqueLabelIds = [...new Set(labelIds)];
  if (uniqueLabelIds.length === 0) return true;

  const found = await label.count({
    where: { id: { in: uniqueLabelIds }, boardId },
  });
  return found === uniqueLabelIds.length;
}
