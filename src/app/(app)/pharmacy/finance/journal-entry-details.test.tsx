import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JournalEntryDetails } from './financial-statements';

type Entry = Parameters<typeof JournalEntryDetails>[0]['entry'];
const entry = {
  id: 'entry-internal-id',
  sourceId: 'source-internal-id',
  sourceKind: 'PHARMACY_SALE_LINE',
  description: 'Recorded sale',
  occurredAt: new Date('2026-11-04T21:30:00Z'),
  reversesEntryId: null,
  currency: 'PKR',
  lines: [{ id: 'line', accountCode: 'CASH', side: 'DEBIT', lotId: null, amountMinor: 125 }],
  eventLabel: 'Sale',
  billNumber: 42,
  actorDisplayName: 'Ayesha Khan',
} as Entry;

describe('journal display', () => {
  it('shows the projected event, bill and actor with Karachi time while keeping IDs in details', () => {
    const html = renderToStaticMarkup(<JournalEntryDetails entry={entry} />);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const summary = doc.querySelector('summary')!.textContent!;
    expect(summary).toContain('05-Nov-2026');
    expect(summary).toMatch(/2:30\s*am/i);
    expect(summary).toContain('PKT');
    expect(summary).toContain('Sale · Bill 42 · Ayesha Khan');
    expect(summary).not.toContain('PHARMACY_SALE_LINE');
    expect(summary).not.toContain('internal-id');
    expect(doc.querySelector('details')!.textContent).toContain('entry-internal-id');
    expect(doc.querySelector('details')!.textContent).toContain('source-internal-id');
    expect(doc.querySelector('details')!.textContent).toContain('1.25');
  });

  it('uses honest fallbacks for missing enrichment and preserves the reversal state', () => {
    const html = renderToStaticMarkup(
      <JournalEntryDetails
        entry={{
          ...entry,
          eventLabel: null,
          billNumber: null,
          actorDisplayName: null,
          reversesEntryId: 'original',
        }}
      />
    );
    expect(html).toContain('Reversal: Journal entry');
    expect(html).toContain('Bill number not available');
    expect(html).toContain('Staff member not available');
  });
});
