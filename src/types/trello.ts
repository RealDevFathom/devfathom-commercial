import { z } from 'zod';

export const trelloCheckItemSchema = z.object({
  name: z.string(),
  state: z.enum(['complete', 'incomplete']),
});

export const trelloChecklistSchema = z.object({
  id: z.string(),
  name: z.string(),
  idCard: z.string(),
  checkItems: z.array(trelloCheckItemSchema),
});

export const trelloLabelSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  color: z.string().nullable(),
});

export const trelloAttachmentSchema = z.object({
  name: z.string(),
  url: z.string(),
});

// IMP-TRELLO-02: Trello card "cover" (a background color or an uploaded image).
// Lenient + passthrough: we only read color/url and never want a malformed cover
// to fail the whole import.
export const trelloCoverSchema = z
  .object({
    color: z.string().nullable().optional(),
    idAttachment: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough();

// IMP-TRELLO-02: a single custom-field value on a card. Power-up custom fields
// carry either an inline `value` object ({ text } / { number } / { date } /
// { checked }) or an `idValue` pointing at a dropdown option defined on the board.
export const trelloCustomFieldItemSchema = z
  .object({
    idCustomField: z.string().optional(),
    idValue: z.string().nullable().optional(),
    value: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export const trelloCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string().default(''),
  idList: z.string(),
  pos: z.number(),
  due: z.string().nullable().optional(),
  labels: z.array(trelloLabelSchema).default([]),
  idMembers: z.array(z.string()).default([]),
  closed: z.boolean().default(false),
  attachments: z.array(trelloAttachmentSchema).default([]),
  // IMP-TRELLO-02: extra card data. All lenient — `.catch(...)` guarantees a
  // malformed value here can never abort the import.
  cover: trelloCoverSchema.nullable().optional().catch(undefined),
  customFieldItems: z.array(trelloCustomFieldItemSchema).catch([]),
  dueComplete: z.boolean().optional().catch(undefined),
});

export const trelloListSchema = z.object({
  id: z.string(),
  name: z.string(),
  pos: z.number(),
  closed: z.boolean().default(false),
});

export const trelloMemberSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  username: z.string(),
});

export const trelloActionSchema = z.object({
  type: z.string(),
  date: z.string(),
  data: z
    .object({
      text: z.string().optional(),
      card: z.object({ id: z.string() }).optional(),
    })
    .passthrough(),
  memberCreator: z
    .object({
      id: z.string(),
      fullName: z.string(),
      username: z.string(),
    })
    .optional(),
});

// IMP-TRELLO-02: board-level custom-field definitions. Used to resolve a card's
// `customFieldItems` into human "Field: value" lines (name + dropdown options).
export const trelloCustomFieldOptionSchema = z
  .object({
    id: z.string(),
    value: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export const trelloCustomFieldSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
    options: z.array(trelloCustomFieldOptionSchema).catch([]),
  })
  .passthrough();

export const trelloBoardSchema = z.object({
  name: z.string(),
  desc: z.string().default(''),
  id: z.string().optional(),
  lists: z.array(trelloListSchema),
  cards: z.array(trelloCardSchema),
  labels: z.array(trelloLabelSchema).default([]),
  members: z.array(trelloMemberSchema).default([]),
  checklists: z.array(trelloChecklistSchema).default([]),
  actions: z.array(trelloActionSchema).default([]),
  // IMP-TRELLO-02: board-level custom-field definitions (lenient).
  customFields: z.array(trelloCustomFieldSchema).catch([]),
});

export type TrelloBoard = z.infer<typeof trelloBoardSchema>;
export type TrelloCard = z.infer<typeof trelloCardSchema>;
export type TrelloMember = z.infer<typeof trelloMemberSchema>;
export type TrelloCover = z.infer<typeof trelloCoverSchema>;
export type TrelloCustomFieldItem = z.infer<typeof trelloCustomFieldItemSchema>;
export type TrelloCustomField = z.infer<typeof trelloCustomFieldSchema>;

// Color mapping: Trello color names to hex
export const trelloColorMap: Record<string, string> = {
  green: '#16A34A',
  yellow: '#D97706',
  orange: '#BC8850',
  red: '#DC2626',
  purple: '#7C3AED',
  blue: '#2563EB',
  sky: '#0EA5E9',
  lime: '#65A30D',
  pink: '#DB2777',
  black: '#11121A',
};
