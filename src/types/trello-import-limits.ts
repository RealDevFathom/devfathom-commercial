// The wire limit includes the tRPC envelope and, for a batch, the other calls.
export const MAX_TRELLO_REQUEST_BYTES = 16 * 1024 * 1024;
export const TRELLO_LIMIT_MESSAGE =
  'This Trello export is too large to import. Split the board and try again.';

const MAX_WORK = 250_000;
const MAX_DEPTH = 16;
const MAX_OBJECT_KEYS = 1_000;
const MAX_KEY_LENGTH = 256;
const MAX_STRING_LENGTH = 32_768;
const MAX_ARRAY_LENGTH = 10_000;

const arrayLimits = new Map([
  ['lists', 500],
  ['cards', 3_000],
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
export function trelloImportWithinLimits(value: unknown): boolean {
  let remaining = MAX_WORK;
  function visit(value: unknown, depth: number, key: string, customValue = false): boolean {
    if (--remaining < 0 || depth > MAX_DEPTH) return false;
    if (typeof value === 'string') {
      remaining -= Math.ceil(value.length / 128);
      const limit = Math.min(
        stringLimits.get(key) ?? MAX_STRING_LENGTH,
        customValue ? 4096 : Infinity
      );
      return remaining >= 0 && value.length <= limit;
    }
    if (Array.isArray(value)) {
      if (value.length > (arrayLimits.get(key) ?? MAX_ARRAY_LENGTH)) return false;
      if (key === 'customFieldItems') remaining -= value.length * 32;
      return remaining >= 0 && value.every((entry) => visit(entry, depth + 1, key, customValue));
    }
    if (!value || typeof value !== 'object') return true;

    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) return false;
    const record = value as Record<string, unknown>;
    return keys.every((child) => {
      if (child.length > MAX_KEY_LENGTH) return false;
      const entry = record[child];
      if (key === 'memberMapping' && typeof entry === 'string' && entry.length > 256) return false;
      return visit(entry, depth + 1, child, customValue || child === 'value');
    });
  }
  return visit(value, 0, '');
}
