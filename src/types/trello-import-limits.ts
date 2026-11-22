// The wire limit includes the tRPC envelope and, for a batch, the other calls.
export const MAX_TRELLO_REQUEST_BYTES = 16 * 1024 * 1024;
export const TRELLO_LIMIT_MESSAGE =
  'This Trello export exceeds the 16 MiB limit. Split the board and try again.';

export const TRELLO_IMPORT_LIMITS = {
  cards: 5_000,
  lists: 500,
  checklistItems: 50_000,
  comments: 100_000,
  cardName: 16_384,
  work: 2_000_000,
} as const;

const MAX_WORK = TRELLO_IMPORT_LIMITS.work;
const MAX_DEPTH = 16;
const MAX_OBJECT_KEYS = 1_000;
const MAX_KEY_LENGTH = 256;
const MAX_STRING_LENGTH = 32_768;
const MAX_ARRAY_LENGTH = 10_000;

const arrayLimits = new Map([
  ['labels', 500],
  ['members', 1_000],
  ['checklists', 3_000],
  ['checkItems', 500],
  ['idMembers', 500],
  ['attachments', 100],
  ['customFields', 250],
  ['customFieldItems', 100],
  ['options', 250],
]);

const stringLimits = new Map([
  ['id', 256],
  ['idCard', 256],
  ['idList', 256],
  ['idAttachment', 256],
  ['idCustomField', 256],
  ['idValue', 256],
  ['idMembers', 256],
  ['projectId', 256],
  ['name', 512],
  ['newProjectName', 512],
  ['fullName', 512],
  ['username', 256],
  ['url', 4_096],
  ['color', 64],
  ['type', 128],
  ['state', 32],
  ['date', 128],
  ['due', 128],
]);

/**
 * Check all values before schema parsing, including unrecognised fields and
 * lenient cover/custom-field fields that the schema can discard. Each node
 * spends one unit, plus one per 128 string characters. An inline or resolved
 * custom-field value also spends 32 units to cover its use in a task.
 */
export function trelloRawLimit(value: unknown): string | null {
  let remaining = MAX_WORK;
  const refuse = (limit: string) =>
    `This Trello export exceeds the ${limit} limit. Split the board and try again.`;
  const workLimit = () => refuse('2,000,000-unit processing');
  function visit(
    value: unknown,
    depth: number,
    key: string,
    parent: string,
    customValue = false
  ): string | null {
    if (--remaining < 0) return workLimit();
    if (depth > MAX_DEPTH) return refuse(`${MAX_DEPTH}-level nesting`);
    if (typeof value === 'string') {
      remaining -= Math.ceil(value.length / 128);
      const maxLength =
        parent === 'cards' && key === 'name'
          ? TRELLO_IMPORT_LIMITS.cardName
          : (stringLimits.get(key) ?? MAX_STRING_LENGTH);
      const limit = Math.min(maxLength, customValue ? 4096 : Infinity);
      if (value.length > limit) {
        const label = parent === 'cards' && key === 'name' ? 'card name' : key;
        return refuse(`${limit.toLocaleString('en-US')}-character ${label}`);
      }
      return remaining < 0 ? workLimit() : null;
    }
    if (Array.isArray(value)) {
      const limit =
        parent === 'trelloJson' && key === 'actions'
          ? 200_000
          : (arrayLimits.get(key) ?? MAX_ARRAY_LENGTH);
      if (value.length > limit) return refuse(`${limit.toLocaleString('en-US')}-entry ${key}`);
      if (key === 'customFieldItems') remaining -= value.length * 32;
      if (remaining < 0) return workLimit();
      for (const entry of value) {
        const error = visit(entry, depth + 1, key, parent, customValue);
        if (error) return error;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;

    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) return refuse('1,000-entry object');
    const record = value as Record<string, unknown>;
    for (const child of keys) {
      if (child.length > MAX_KEY_LENGTH) return refuse(`${MAX_KEY_LENGTH}-character object key`);
      const entry = record[child];
      if (key === 'memberMapping' && typeof entry === 'string' && entry.length > 256) {
        return refuse('256-character member mapping');
      }
      const error = visit(entry, depth + 1, child, key, customValue || child === 'value');
      if (error) return error;
    }
    return null;
  }
  return visit(value, 0, '', '');
}

export function trelloImportWithinLimits(value: unknown): boolean {
  return trelloRawLimit(value) === null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Count the records the importer would place. Structural validation still belongs to the schema. */
export function trelloRecordLimit(board: unknown, includeArchived: boolean): string | null {
  const source = record(board);
  if (!source) return null;
  const { cards, lists, checklistItems, comments } = TRELLO_IMPORT_LIMITS;
  const refuse = (limit: number, label: string) =>
    `This Trello import exceeds the ${limit.toLocaleString('en-US')} ${label} limit. Split the board or exclude archived records.`;
  const listIds = new Set<unknown>();
  let listCount = 0;
  for (const value of entries(source.lists)) {
    const list = record(value);
    if (!list || (list.closed === true && !includeArchived)) continue;
    if (++listCount > lists) return refuse(lists, 'lists');
    listIds.add(list.id);
  }
  const cardIds = new Set<unknown>();
  let cardCount = 0;
  for (const value of entries(source.cards)) {
    const card = record(value);
    if (!card || (card.closed === true ? !includeArchived : !listIds.has(card.idList))) continue;
    if (++cardCount > cards) return refuse(cards, 'cards');
    cardIds.add(card.id);
  }
  let itemCount = 0;
  for (const value of entries(source.checklists)) {
    const checklist = record(value);
    if (!checklist || !cardIds.has(checklist.idCard)) continue;
    itemCount += entries(checklist.checkItems).length;
    if (itemCount > checklistItems) return refuse(checklistItems, 'checklist items');
  }
  let commentCount = 0;
  for (const value of entries(source.actions)) {
    const action = record(value);
    if (action?.type !== 'commentCard') continue;
    const card = record(record(action.data)?.card);
    if (card && cardIds.has(card.id) && ++commentCount > comments)
      return refuse(comments, 'comments');
  }
  return null;
}
