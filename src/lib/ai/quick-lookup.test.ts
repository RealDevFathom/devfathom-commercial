import { describe, expect, it } from 'vitest';

import { assistantTurnTier, isQuickLookup, type QuickLookupInput } from './quick-lookup';

const READ_TOOLS = ['askPharmacyReports', 'listMyTasks', 'getOverview', 'createTask'];

function turn(latestUserText: string, overrides: Partial<QuickLookupInput> = {}): QuickLookupInput {
  return {
    latestUserText,
    isApprovalContinuation: false,
    forcedTool: false,
    toolNames: READ_TOOLS,
    ...overrides,
  };
}

describe('assistantTurnTier', () => {
  it.each([
    'What were sales today?',
    'How many open stock signals at Gulberg?',
    'Show my overdue tasks',
    'Is Ali on leave today?',
    'Aaj ki sales kitni hain?',
    'کتنا کھاتہ باقی ہے؟',
    'Which invoices are unpaid?',
  ])('gives a quick lookup the cheap tier: %s', (text) => {
    expect(assistantTurnTier(turn(text))).toBe('cheap');
  });

  it.each([
    'Create a task to call the supplier tomorrow',
    'Send a message to the team about the stock count',
    'Mark the invoice as paid',
    'Why did sales drop this week?',
    'Compare this month with last month',
    'Summarize my week',
    'What should I reorder?',
    'Draft a WhatsApp message for customers',
    'Request leave from Monday to Wednesday',
    'Message Sara bhej do',
    'Sales report.',
    'What were sales today? And how many refunds?',
    'Tell me everything about the Gulberg branch performance over the last quarter including refunds, discounts, khata and supplier credits',
    'hello',
    '',
  ])('keeps standard for anything else: %s', (text) => {
    expect(assistantTurnTier(turn(text))).toBe('standard');
  });

  it('keeps standard for approval continuations, forced tools and turns without read tools', () => {
    expect(isQuickLookup(turn('What were sales today?', { isApprovalContinuation: true }))).toBe(
      false
    );
    expect(isQuickLookup(turn('What were sales today?', { forcedTool: true }))).toBe(false);
    expect(isQuickLookup(turn('What were sales today?', { toolNames: ['createTask'] }))).toBe(
      false
    );
    expect(isQuickLookup(turn('What were sales today?', { toolNames: [] }))).toBe(false);
  });
});
