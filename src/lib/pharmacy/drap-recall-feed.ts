import { inflateSync, type Inflate } from 'node:zlib';

import type { DrapNoticeSource, DrapRecallNotice } from './drap-monitoring';

/**
 * DEV-692 — DRAP recall-alert page adapter.
 *
 * DRAP publishes recall and rapid alerts as WordPress posts (each with a PDF
 * copy); there is no API. This adapter reads the listing page, parses each
 * alert's product table into one RECALL notice per product row, and falls back
 * to the PDF's text when a post has no table. Every notice it produces is a
 * draft in the review queue: nothing is recalled or quarantined until a person
 * confirms it (`confirmDrapRecall`).
 *
 * Network access to dra.gov.pk is an operations decision, so the adapter is off
 * unless `PHARMACY_DRAP_RECALL_FEED_ENABLED=true`. It only ever fetches https
 * URLs on dra.gov.pk.
 */

export const DRAP_RECALL_ALERTS_URL =
  'https://www.dra.gov.pk/category/safety_info/product_recalls/recall_alerts/';
/** `ingestedById` for drafts created by the daily fetch (no person is signed in). */
export const DRAP_RECALL_FEED_ACTOR_ID = 'system:drap-recall-feed';

const ALLOWED_HOSTS = new Set(['dra.gov.pk', 'www.dra.gov.pk']);
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_FETCHES = 5;
const MAX_PDF_STREAMS = 500;
const MAX_PDF_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_PDF_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_PDF_EXPANSION_RATIO = 256;
const PDF_EXPANSION_FLOOR_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REASON_LENGTH = 500;

export type DrapRecallFeedConfig = { enabled: boolean; url: string };

export function drapRecallFeedConfig(
  env: Record<string, string | undefined> = process.env
): DrapRecallFeedConfig {
  const url = env.PHARMACY_DRAP_RECALL_FEED_URL?.trim() || DRAP_RECALL_ALERTS_URL;
  return { enabled: env.PHARMACY_DRAP_RECALL_FEED_ENABLED === 'true' && isDrapUrl(url), url };
}

export function isDrapUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type DrapFetchResult = { ok: boolean; status: number; body: Uint8Array };
export type DrapFetch = (url: string, maxBytes: number) => Promise<DrapFetchResult>;

export const fetchDrapPage: DrapFetch = async (url, maxBytes) => {
  if (!isDrapUrl(url)) throw new Error('DRAP feed only fetches https://dra.gov.pk URLs.');
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'text/html,application/pdf;q=0.9' },
  });
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('DRAP page exceeds the size limit.');
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > maxBytes) throw new Error('DRAP page exceeds the size limit.');
  return { ok: response.ok, status: response.status, body };
};

export type DrapRecallAlertRow = {
  productName: string;
  registrationNumber: string | null;
  batchNumbers: string[];
  manufacturer: string | null;
  remarks: string | null;
  /** The source names batches the parser could not pair with this product. */
  batchNumbersUnresolved?: boolean;
};

export type DrapRecallAlert = {
  postId: string;
  title: string;
  url: string | null;
  publishedAt: string | null;
  alertNumber: string | null;
  documentUrl: string | null;
  rows: DrapRecallAlertRow[];
  parsedFrom: 'HTML' | 'PDF' | 'NONE';
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
};

function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const point =
        code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Tag-stripped text with block boundaries kept as newlines. */
function htmlText(fragment: string) {
  return decodeEntities(
    fragment
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|td|th)>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1] ?? null;

const REGISTRATION = /\bReg(?:istration)?\.?\s*(?:No\.?|Number|#)\s*[:.\-]?\s*(\d[\d\-/]{2,})/gi;
const ALERT_NUMBER = /\b([A-Z]{1,4}\/[A-Z]{1,4}\/\d{1,2}-\d{1,2}-\d{1,4})\b/;
const LABELLED_BATCH = /\bBatch\s*(?:No\.?|Number|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\-/]{1,30})/gi;
const NO_BATCH = /^(not\s+mentioned|n\/?a|nil|none|-+|–|—)$/i;

function registrationNumbers(text: string) {
  return [...new Set([...text.matchAll(REGISTRATION)].map((m) => m[1]!.replace(/[-/]+$/, '')))];
}

function batchTokens(cell: string) {
  return [
    ...new Set(
      cell
        .split(/[\n,;&]|\band\b/i)
        .map((token) =>
          token
            .replace(/^\s*(?:batch\s*(?:no\.?|number|#)?\s*[:.\-]?)/i, '')
            .trim()
            .replace(/[.;:,]+$/, '')
        )
        .filter((token) => token && !NO_BATCH.test(token) && /\d/.test(token) && token.length <= 40)
    ),
  ];
}

function tableRows(table: string) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => htmlText(cell[1]!))
  );
}

function productTableRows(articleHtml: string): DrapRecallAlertRow[] {
  for (const table of articleHtml.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = tableRows(table[1]!);
    const headerIndex = rows.findIndex(
      (cells) =>
        cells.some((c) => /batch/i.test(c)) && cells.some((c) => /product|name of/i.test(c))
    );
    if (headerIndex < 0) continue;
    const header = rows[headerIndex]!;
    const column = (pattern: RegExp) => header.findIndex((cell) => pattern.test(cell));
    const product = column(/product/i);
    const batch = column(/batch/i);
    const manufacturer = column(/manufactur/i);
    const remarks = column(/remark/i);
    const parsed: DrapRecallAlertRow[] = [];
    for (const cells of rows.slice(headerIndex + 1)) {
      if (cells.length < header.length || product < 0 || !cells[product]) continue;
      const productCell = cells[product]!;
      const registrations = registrationNumbers(productCell);
      const productName =
        productCell
          .split('\n')
          .filter((line) => !/\breg(?:istration)?\.?\s*(?:no|number|#)/i.test(line))
          .join(' ')
          .trim() || productCell.split('\n')[0]!;
      const row = {
        productName,
        batchNumbers: batch >= 0 ? batchTokens(cells[batch] ?? '') : [],
        manufacturer: manufacturer >= 0 ? cells[manufacturer]?.replace(/\n/g, ' ') || null : null,
        remarks: remarks >= 0 ? cells[remarks]?.replace(/\n/g, ' ') || null : null,
      };
      if (!registrations.length) parsed.push({ ...row, registrationNumber: null });
      for (const registrationNumber of registrations) parsed.push({ ...row, registrationNumber });
    }
    if (parsed.length) return parsed;
  }
  return [];
}

/** Parses the DRAP recall-alert listing page (WordPress category archive). */
export function parseDrapRecallAlertsHtml(html: string): DrapRecallAlert[] {
  const alerts: DrapRecallAlert[] = [];
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of markup.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const [, openTag, body] = match as unknown as [string, string, string];
    const postId = /post-(\d+)/.exec(attr(openTag, 'id') ?? '')?.[1] ?? null;
    const titleTag = /<h[1-6][^>]*entry-title[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(body);
    if (!postId || !titleTag) continue;
    const anchor = /<a\b[^>]*>/i.exec(titleTag[1]!)?.[0] ?? '';
    const href = attr(anchor, 'href');
    const published = /<time\b[^>]*\bentry-date published\b[^>]*>/i.exec(body)?.[0];
    const pdf = [...body.matchAll(/<a\b[^>]*href="([^"]+\.pdf)"/gi)]
      .map((m) => decodeEntities(m[1]!))
      .find(isDrapUrl);
    const text = htmlText(body);
    const rows = productTableRows(body);
    alerts.push({
      postId,
      title: htmlText(titleTag[1]!).replace(/\n/g, ' '),
      url: href && isDrapUrl(decodeEntities(href)) ? decodeEntities(href) : null,
      publishedAt: (published && attr(published, 'datetime')) || null,
      alertNumber: ALERT_NUMBER.exec(text.replace(/\s+/g, ' '))?.[1] ?? null,
      documentUrl: pdf ?? null,
      rows,
      parsedFrom: rows.length ? 'HTML' : 'NONE',
    });
  }
  return alerts;
}

const PDF_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  '(': '(',
  ')': ')',
  '\\': '\\',
};
// WinAnsi code points 0x80–0x9f that differ from Latin-1 (quotes, dashes).
const WIN_ANSI: Record<number, string> = {
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x96: '–',
  0x97: '—',
};

/** Literal strings shown between BT/ET; each ET ends a line. Hex (glyph-id) strings are skipped. */
function contentStreamText(content: string) {
  let out = '';
  let inText = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (!inText) {
      if (ch === 'B' && content[i + 1] === 'T' && !/\w/.test(content[i + 2] ?? ' ')) inText = true;
      continue;
    }
    if (ch === 'E' && content[i + 1] === 'T' && !/\w/.test(content[i + 2] ?? ' ')) {
      inText = false;
      out += '\n';
      continue;
    }
    if (ch !== '(') continue;
    let depth = 1;
    let value = '';
    for (i += 1; i < content.length && depth; i++) {
      const c = content[i]!;
      if (c === '\\') {
        const next = content[i + 1] ?? '';
        const octal = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))?.[0];
        if (octal) {
          const code = parseInt(octal, 8);
          value += WIN_ANSI[code] ?? String.fromCharCode(code);
          i += octal.length;
        } else if (next === '\r' || next === '\n') {
          i += next === '\r' && content[i + 2] === '\n' ? 2 : 1;
        } else {
          value += PDF_ESCAPES[next] ?? next;
          i += 1;
        }
        continue;
      }
      if (c === '(') depth += 1;
      if (c === ')' && --depth === 0) break;
      const code = c.charCodeAt(0);
      value += WIN_ANSI[code] ?? c;
    }
    out += value;
  }
  return out;
}

/**
 * Best-effort text of a PDF's FlateDecode content streams (DRAP alerts are
 * Word exports with WinAnsi fonts). Not a general PDF reader: unreadable
 * text simply yields no rows, and the alert still reaches the review queue.
 */
export function extractPdfText(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('DRAP PDF exceeds the size limit.');
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const pieces: string[] = [];
  const marker = />>\s*stream\r?\n/g;
  let streams = 0;
  let decodedBytes = 0;
  for (let match = marker.exec(raw); match; match = marker.exec(raw)) {
    if (++streams > MAX_PDF_STREAMS) throw new Error('DRAP PDF has too many streams.');
    const dataStart = match.index + match[0].length;
    const end = raw.indexOf('endstream', dataStart);
    if (end < 0) break;
    marker.lastIndex = end + 9;
    const dictionary = raw.slice(Math.max(0, raw.lastIndexOf('<<', match.index)), match.index);
    const singleFlateFilter = /\/Filter\s*(?:\/FlateDecode\b|\[\s*\/FlateDecode\s*\])/;
    if (!singleFlateFilter.test(dictionary) || /\/Subtype\s*\/Image/.test(dictionary)) continue;
    const remaining = MAX_PDF_DECODED_BYTES - decodedBytes;
    // zlib requires a positive maximum, even when the only output we can accept is empty.
    const maxOutputLength = Math.max(1, Math.min(MAX_PDF_STREAM_BYTES, remaining));
    let result;
    try {
      // Node returns the engine with `info: true`; the type declarations omit the overload.
      result = inflateSync(bytes.subarray(dataStart, end), {
        maxOutputLength,
        info: true,
      }) as unknown as { buffer: Buffer; engine: Inflate };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error('DRAP PDF exceeds the decoded stream budget.');
      }
      // zlib may have produced output before it failed. Stop instead of spending
      // an unknown portion of the decode budget on each unreadable stream.
      throw new Error('DRAP PDF has an unreadable compressed stream.');
    }
    const { buffer, engine } = result;
    if (buffer.length > remaining) throw new Error('DRAP PDF exceeds the decoded stream budget.');
    // Count the compressed bytes consumed by zlib, excluding any stream delimiter or padding.
    if (
      buffer.length >
      Math.max(PDF_EXPANSION_FLOOR_BYTES, engine.bytesWritten * MAX_PDF_EXPANSION_RATIO)
    ) {
      throw new Error('DRAP PDF stream expands beyond the permitted ratio.');
    }
    decodedBytes += buffer.length;
    const decoded = buffer.toString('latin1');
    if (/\bBT\b/.test(decoded)) pieces.push(contentStreamText(decoded));
  }
  return pieces.join('\n');
}

/**
 * Rows from PDF text. Registration numbers are reliable labels; batch numbers
 * are paired with a registration only when the document names one product.
 */
export function parseDrapRecallPdfText(text: string, title: string): DrapRecallAlertRow[] {
  const flat = text.replace(/\s+/g, ' ');
  const registrations = pdfRegistrationNumbers(flat);
  const batches = [...new Set([...flat.matchAll(LABELLED_BATCH)].map((m) => m[1]!))];
  const paired = registrations.length === 1 && batches.length > 0;
  return registrations.map((registrationNumber) => ({
    productName: title,
    registrationNumber,
    batchNumbers: paired ? batches : [],
    ...(paired ? {} : { batchNumbersUnresolved: true }),
    manufacturer: null,
    remarks: 'Parsed from the DRAP PDF; check the document before confirming.',
  }));
}

/**
 * PDF text runs split words ("Reg # 000 568"). A registration number is read
 * as digit groups joined until it reaches six digits, DRAP's printed width.
 */
function pdfRegistrationNumbers(flat: string) {
  const found = new Set<string>();
  for (const label of flat.matchAll(/\bReg(?:istration)?\.?\s*(?:No\.?|Number|#)\s*[:.\-]?\s*/gi)) {
    let digits = '';
    for (const token of flat.slice(label.index! + label[0].length).split(' ')) {
      if (!/^\d+$/.test(token) || digits.length + token.length > 8) break;
      digits += token;
      if (digits.length >= 6) break;
    }
    if (digits.length >= 3) found.add(digits);
  }
  return [...found];
}

export function pdfAlertNumber(text: string) {
  const label = /ALERT\s*No\.?\s*:?\s*(?:N\s*o\.?\s*)?/i.exec(text);
  if (!label) return null;
  const compact = text
    .slice(label.index + label[0].length)
    .slice(0, 40)
    .replace(/\s+/g, '');
  return /^([A-Z]{1,4}\/[A-Z]{1,4}\/\d{1,2}-\d{1,2}-\d{1,4})(?!\d)/.exec(compact)?.[1] ?? null;
}

/** One RECALL notice per alert row; an alert with no rows still reaches review. */
export function drapAlertNotices(alerts: readonly DrapRecallAlert[]): DrapRecallNotice[] {
  const notices: DrapRecallNotice[] = [];
  for (const alert of alerts) {
    const key = alert.alertNumber ?? `post-${alert.postId}`;
    const rows: DrapRecallAlertRow[] = alert.rows.length
      ? alert.rows
      : [
          {
            productName: alert.title,
            registrationNumber: null,
            batchNumbers: [],
            manufacturer: null,
            remarks: null,
          },
        ];
    rows.forEach((row, index) => {
      const reason = [alert.title, row.remarks].filter(Boolean).join(' — ');
      notices.push({
        kind: 'RECALL',
        sourceReference: `DRAP-WEB:${key}:${index + 1}`,
        drapRegistrationNumber: row.registrationNumber ?? '',
        ...(row.batchNumbers.length ? { batchNumbers: row.batchNumbers } : {}),
        ...(row.batchNumbersUnresolved ? { batchNumbersUnresolved: true } : {}),
        reason: reason.slice(0, MAX_REASON_LENGTH),
        productName: row.productName.slice(0, 300),
        ...(alert.alertNumber ? { alertNumber: alert.alertNumber } : {}),
        ...(alert.url ? { sourceUrl: alert.url } : {}),
        ...(alert.documentUrl ? { documentUrl: alert.documentUrl } : {}),
        ...(alert.publishedAt ? { publishedAt: alert.publishedAt } : {}),
      });
    });
  }
  return notices;
}

export class DrapWebNoticeSource implements DrapNoticeSource {
  readonly adapter = 'DRAP_WEB' as const;
  constructor(
    private readonly config: DrapRecallFeedConfig,
    private readonly fetcher: DrapFetch = fetchDrapPage
  ) {}

  async read(): Promise<readonly DrapRecallNotice[]> {
    if (!this.config.enabled) throw new Error('The DRAP recall feed is not enabled.');
    const page = await this.fetcher(this.config.url, MAX_HTML_BYTES);
    if (!page.ok) throw new Error(`DRAP recall page returned HTTP ${page.status}.`);
    const alerts = parseDrapRecallAlertsHtml(Buffer.from(page.body).toString('utf8'));
    let pdfFetches = 0;
    for (const alert of alerts) {
      if (alert.rows.length || !alert.documentUrl || pdfFetches >= MAX_PDF_FETCHES) continue;
      pdfFetches += 1;
      try {
        const pdf = await this.fetcher(alert.documentUrl, MAX_PDF_BYTES);
        if (!pdf.ok) continue;
        const text = extractPdfText(pdf.body);
        alert.rows = parseDrapRecallPdfText(text, alert.title);
        alert.alertNumber ??= pdfAlertNumber(text);
        if (alert.rows.length) alert.parsedFrom = 'PDF';
      } catch {
        // The alert still reaches the queue with its title and document link.
      }
    }
    return drapAlertNotices(alerts);
  }
}
