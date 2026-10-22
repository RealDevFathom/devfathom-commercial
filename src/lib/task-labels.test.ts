import { describe, expect, it, vi } from 'vitest';
import { labelsBelongToBoard } from './task-labels';

describe('labelsBelongToBoard', () => {
  it('requires every label id to belong to the exact board', async () => {
    const count = vi.fn().mockResolvedValue(1);

    await expect(
      labelsBelongToBoard({ count }, 'board-a', ['label-a', 'label-from-board-b'])
    ).resolves.toBe(false);
    expect(count).toHaveBeenCalledWith({
      where: {
        id: { in: ['label-a', 'label-from-board-b'] },
        boardId: 'board-a',
      },
    });
  });

  it('deduplicates ids before comparing the board-scoped count', async () => {
    const count = vi.fn().mockResolvedValue(1);

    await expect(labelsBelongToBoard({ count }, 'board-a', ['label-a', 'label-a'])).resolves.toBe(
      true
    );
  });
});
