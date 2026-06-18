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
});

export type TrelloBoard = z.infer<typeof trelloBoardSchema>;
export type TrelloCard = z.infer<typeof trelloCardSchema>;
export type TrelloMember = z.infer<typeof trelloMemberSchema>;

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
