import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  DRAP_RECALL_ALERTS_URL,
  DrapWebNoticeSource,
  drapAlertNotices,
  drapRecallFeedConfig,
  extractPdfText,
  fetchDrapPage,
  parseDrapRecallAlertsHtml,
  parseDrapRecallPdfText,
  pdfAlertNumber,
  type DrapFetch,
} from './drap-recall-feed';

// Saved from dra.gov.pk on 2026-11-15; see the header comment in each fixture.
const fixtures = join(__dirname, 'fixtures', 'drap-recall-alerts');
const page = readFileSync(join(fixtures, 'recall-alerts-page.html'), 'utf8');
const pdf = new Uint8Array(readFileSync(join(fixtures, 'recall-alert-45.pdf')));

describe('DEV-692 DRAP recall-alert page parser', () => {
  const alerts = parseDrapRecallAlertsHtml(page);
  const byPost = (id: string) => alerts.find((alert) => alert.postId === id)!;

  it('reads every saved alert post with its source page, PDF and alert number', () => {
    expect(alerts.map((alert) => alert.postId)).toEqual(['79815', '79813', '79742', '79736']);
    expect(byPost('79736')).toMatchObject({
      title: '45. Recall Alert (Carapamin Injection & Librax Tablet/Dragees)',
      alertNumber: 'I/S/10-26-45',
      publishedAt: '2026-10-23T15:32:50+05:00',
      url: 'https://www.dra.gov.pk/safety_info/product_recalls/recall_alerts/45-recall-alert-carapamin-injection-librax-tablet-dragees/',
      documentUrl:
        'https://www.dra.gov.pk/wp-content/uploads/2026/11/45.-Recall-Alert-Class-II-Carapamin-Librax.pdf',
      parsedFrom: 'HTML',
    });
  });

  it('pairs each registration number with its own batch from the product table', () => {
    expect(byPost('79736').rows).toEqual([
      expect.objectContaining({
        productName: 'Carapamin Injection 200mg (Dopamine HydrochlorideUSP)',
        registrationNumber: '060235',
        batchNumbers: ['26A059'],
      }),
      expect.objectContaining({
        registrationNumber: '000568',
        batchNumbers: ['001952'],
      }),
    ]);
  });

  it('maps columns by header, so a table with manufacturer before batch still parses', () => {
    expect(byPost('79742').rows).toEqual([
      expect.objectContaining({ registrationNumber: null, batchNumbers: ['25495'] }),
    ]);
  });

  it('keeps "Not mentioned" out of batch numbers and rows without registration numbers', () => {
    const rows = byPost('79813').rows;
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[0]).toMatchObject({ batchNumbers: [], registrationNumber: null });
    expect(rows.find((row) => row.productName.startsWith('Magic Lotion'))?.batchNumbers).toEqual([
      '002',
    ]);
    expect(byPost('79815').rows.map((row) => row.batchNumbers)).toEqual([
      ['FDAG020'],
      ['MDSB25008A'],
      ['4626'],
    ]);
  });

  it('turns every row into a reviewable RECALL notice with a stable reference', () => {
    const notices = drapAlertNotices(alerts);
    const carapamin = notices.find((n) => n.sourceReference === 'DRAP-WEB:I/S/10-26-45:1');
    expect(carapamin).toEqual({
      kind: 'RECALL',
      sourceReference: 'DRAP-WEB:I/S/10-26-45:1',
      drapRegistrationNumber: '060235',
      batchNumbers: ['26A059'],
      reason: expect.stringContaining('45. Recall Alert'),
      productName: 'Carapamin Injection 200mg (Dopamine HydrochlorideUSP)',
      alertNumber: 'I/S/10-26-45',
      sourceUrl: expect.stringMatching(/^https:\/\/www\.dra\.gov\.pk\//),
      documentUrl: expect.stringMatching(/\.pdf$/),
      publishedAt: '2026-10-23T15:32:50+05:00',
    });
    // No registration number: still queued for a person, with an empty registration.
    expect(notices.find((n) => n.sourceReference === 'DRAP-WEB:I/S/11-05-51:1')).toMatchObject({
      drapRegistrationNumber: '',
      batchNumbers: ['FDAG020'],
    });
    expect(new Set(notices.map((n) => n.sourceReference)).size).toBe(notices.length);
    expect(drapAlertNotices(parseDrapRecallAlertsHtml(page))).toEqual(notices);
  });

  it('queues a post with no product table under its post id', () => {
    const [notice] = drapAlertNotices(
      parseDrapRecallAlertsHtml(
        '<article id="post-9" class="post"><h2 class="entry-title"><a href="https://evil.example/x">Alert</a></h2><p>Text only</p></article>'
      )
    );
    expect(notice).toEqual({
      kind: 'RECALL',
      sourceReference: 'DRAP-WEB:post-9:1',
      drapRegistrationNumber: '',
      reason: 'Alert',
      productName: 'Alert',
    });
  });
});

describe('DEV-692 DRAP recall PDF fallback', () => {
  it('extracts registration numbers and the alert number from the saved PDF', () => {
    const text = extractPdfText(pdf);
    expect(text).toContain('Carapamin');
    expect(pdfAlertNumber(text)).toBe('II/S/10-26-45');
    // The PDF table's batch cells are not labelled, so the batches stay unresolved.
    expect(parseDrapRecallPdfText(text, 'Alert 45')).toEqual([
      expect.objectContaining({
        registrationNumber: '060235',
        batchNumbers: [],
        batchNumbersUnresolved: true,
      }),
      expect.objectContaining({
        registrationNumber: '000568',
        batchNumbers: [],
        batchNumbersUnresolved: true,
      }),
    ]);
  });

  it('pairs labelled batches only when the document names a single product', () => {
    const [row] = parseDrapRecallPdfText('Reg. No. 012345 Batch No. AB12', 'One');
    expect(row).toMatchObject({ registrationNumber: '012345', batchNumbers: ['AB12'] });
    expect(row).not.toHaveProperty('batchNumbersUnresolved');
  });
});

describe('DEV-692 DRAP recall feed adapter', () => {
  it('is off unless operations enable it, and only targets dra.gov.pk', () => {
    expect(drapRecallFeedConfig({})).toEqual({ enabled: false, url: DRAP_RECALL_ALERTS_URL });
    expect(drapRecallFeedConfig({ PHARMACY_DRAP_RECALL_FEED_ENABLED: '1' }).enabled).toBe(false);
    expect(drapRecallFeedConfig({ PHARMACY_DRAP_RECALL_FEED_ENABLED: 'true' }).enabled).toBe(true);
    expect(
      drapRecallFeedConfig({
        PHARMACY_DRAP_RECALL_FEED_ENABLED: 'true',
        PHARMACY_DRAP_RECALL_FEED_URL: 'https://dra.gov.pk.example.com/recalls',
      }).enabled
    ).toBe(false);
  });

  it('refuses to fetch outside dra.gov.pk before any network call', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchDrapPage('http://www.dra.gov.pk/', 10)).rejects.toThrow(/dra\.gov\.pk/);
    await expect(fetchDrapPage('https://169.254.169.254/', 10)).rejects.toThrow(/dra\.gov\.pk/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reads the saved page into notices and fetches no PDF when tables parse', async () => {
    const fetcher = vi.fn<DrapFetch>(async () => ({
      ok: true,
      status: 200,
      body: new TextEncoder().encode(page),
    }));
    const source = new DrapWebNoticeSource({ enabled: true, url: DRAP_RECALL_ALERTS_URL }, fetcher);
    const notices = await source.read();
    expect(source.adapter).toBe('DRAP_WEB');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(notices).toEqual(drapAlertNotices(parseDrapRecallAlertsHtml(page)));
  });

  it('falls back to the PDF for a post whose page has no product table', async () => {
    const html = page.replace(/<table\b[\s\S]*?<\/table>/g, '');
    const fetcher = vi.fn<DrapFetch>(async (url) => ({
      ok: true,
      status: 200,
      body: url.endsWith('Carapamin-Librax.pdf')
        ? pdf
        : url.endsWith('.pdf')
          ? new Uint8Array()
          : new TextEncoder().encode(html),
    }));
    const notices = await new DrapWebNoticeSource(
      { enabled: true, url: DRAP_RECALL_ALERTS_URL },
      fetcher
    ).read();
    expect(fetcher.mock.calls.every(([url]) => url.startsWith('https://www.dra.gov.pk/'))).toBe(
      true
    );
    const fromPdf = notices.filter((n) => n.documentUrl?.endsWith('Carapamin-Librax.pdf'));
    expect(fromPdf.map((n) => n.drapRegistrationNumber)).toEqual(['060235', '000568']);
    // Never a confirmable medicine-wide recall: the batches are flagged unresolved.
    expect(fromPdf.every((n) => n.batchNumbersUnresolved && !n.batchNumbers)).toBe(true);
    // The page's alert-number table was removed too, so the PDF supplies it.
    expect(fromPdf[0]!.sourceReference).toBe('DRAP-WEB:II/S/10-26-45:1');
  });

  it('never reads when disabled and reports a failed page fetch', async () => {
    const fetcher = vi.fn<DrapFetch>(async () => ({
      ok: false,
      status: 503,
      body: new Uint8Array(),
    }));
    await expect(
      new DrapWebNoticeSource({ enabled: false, url: DRAP_RECALL_ALERTS_URL }, fetcher).read()
    ).rejects.toThrow(/not enabled/);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      new DrapWebNoticeSource({ enabled: true, url: DRAP_RECALL_ALERTS_URL }, fetcher).read()
    ).rejects.toThrow(/503/);
  });
});
