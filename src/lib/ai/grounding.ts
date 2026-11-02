/**
 * Number grounding for Ask Fathom answers (DEV-576).
 *
 * SQL and tools compute every figure; the model only restates them. This module checks
 * that each figure in an answer is one the turn can account for:
 *   - a value in this turn's tool results (numbers, numeric strings, numbers inside
 *     returned text, `*Minor` integer minor units ÷ 100, ratio ↔ percent, array lengths),
 *   - a figure the user typed,
 *   - or an exempt figure: a plain integer ≤ 10, or a date, time or year (a year only
 *     where it reads as one: "in 2026", "since 2024", "November 2026", "FY 2026").
 * Scale words are read in English, Roman Urdu and Urdu ("50 hazar", "1.2 لاکھ", "3 karor"),
 * and Urdu digits as ASCII digits.
 * A figure matches within its displayed precision ("1.2 lakh" accepts 115,000–125,000;
 * "Rs 1,235" accepts 1,234.5). Signs are compared by magnitude, because answers often
 * carry the sign in words ("a shortfall of Rs 1,200").
 */
import type { TextStreamPart, ToolSet, UIMessage } from 'ai';

import { detectDosingInstruction } from './answer-safety';

export const GROUNDING_REJECTED_TEXT =
  "I couldn't verify every figure in that answer against your workspace data, so I haven't shown it. Ask for a specific report and I'll answer from those numbers.";
export const DOSING_REJECTED_TEXT =
  "I can't give dosing advice. Please ask the pharmacist or the prescriber.";

/** Integers up to this size, written plainly, are never checked. */
export const SMALL_INTEGER_EXEMPTION = 10;

const MAX_WALK_DEPTH = 12;
const MAX_WALK_NODES = 50_000;
/** Sibling keys whose string value can mark an object's amounts as minor units. */
const MINOR_UNIT_LABEL_KEYS = new Set(['metricKey', 'key', 'metric', 'unit', 'moneyUnit']);

export type Figure = {
  /** The displayed text, for tests and debugging only. Never logged. */
  raw: string;
  /** Magnitude in base units (a percent stays on its 0–100 scale). */
  value: number;
  /** Half a unit of the displayed precision, in base units. */
  tolerance: number;
  percent: boolean;
  /** Offset of the figure in the text it was extracted from. */
  index: number;
};

const SCALE_WORDS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
  crore: 1e7,
  crores: 1e7,
  cr: 1e7,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  millions: 1e6,
  bn: 1e9,
  billion: 1e9,
  billions: 1e9,
  hazar: 1e3,
  hazaar: 1e3,
  hazaron: 1e3,
  ہزار: 1e3,
  لاکھ: 1e5,
  karor: 1e7,
  karod: 1e7,
  karore: 1e7,
  کروڑ: 1e7,
  arab: 1e9,
  ارب: 1e9,
};

const EASTERN_DIGITS = /[٠-٩۰-۹٫٬]/g;
/** Arabic-Indic and Urdu digits (and their separators) as ASCII, one for one. */
function asciiDigits(text: string): string {
  return text.replace(EASTERN_DIGITS, (digit) => {
    if (digit === '٫') return '.';
    if (digit === '٬') return ',';
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY = '(?:0?[1-9]|[12]\\d|3[01])';
/** "may" and "mar" are also ordinary words; lower-case, they need a year or an ordinal. */
const AMBIGUOUS_MONTH = /^(?:may|mar)$/i;
const CAPITALISED = /^\p{Lu}\p{Ll}*$/u;

function isAmbiguousMonth(month: string, ordinal: string | undefined, year: string | undefined) {
  return AMBIGUOUS_MONTH.test(month) && !CAPITALISED.test(month) && !ordinal && !year;
}

/** "15/11" and "11/15" read as dates. A first part ≤ the second ("3/5") is a date only after a date word. */
const SHORT_DATE = /(?<![\p{L}\p{N}.,/])(\d{1,2})\/(\d{1,2})(?![\p{N}/]|[.,]\d)/gu;
const DATE_WORD_BEFORE =
  /(?:\b(?:on|from|to|till|until|since|by|dated?|due|before|after|between|and|through|tak|se|ko)|تک|سے|کو)\s*$/iu;

function isShortDate(text: string, index: number, first: number, second: number) {
  if (first < 1 || second < 1) return false;
  const valid = (first <= 31 && second <= 12) || (first <= 12 && second <= 31);
  if (!valid) return false;
  return first > second || DATE_WORD_BEFORE.test(text.slice(Math.max(0, index - 12), index));
}

/**
 * Spans that are never figures: links (their ids and query strings), dates, times,
 * ordinals and Markdown list markers. They are blanked before extraction.
 */
const EXEMPT_SPANS: RegExp[] = [
  /\]\([^)\s]*\)/g,
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm|a\.m\.|p\.m\.))?/gi,
  /\b\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)(?![\p{L}])/giu,
  /\b\d+(?:st|nd|rd|th)\b/gi,
  /^[ \t]*\d+[.)][ \t]/gm,
];

/** Day-month and month-day dates; lower-case "may"/"mar" need an ordinal or a year. */
const DAY_MONTH = new RegExp(
  `\\b${DAY}(st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\b\\.?(?:,?\\s+(\\d{4}))?`,
  'gi'
);
const MONTH_DAY = new RegExp(
  `\\b(${MONTH})\\.?\\s+${DAY}(st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`,
  'gi'
);

/**
 * One figure: optional currency, optional sign, the digits (Western or South Asian
 * grouping, optional decimals), an optional scale word and an optional percent sign.
 * The look-behinds skip digits inside identifiers ("INV-0042", "Q3", "v2", "#12", "3/5"'s 5).
 */
const FIGURE =
  /(?<![\p{L}\p{N}_.,/#:=?&])(?<![\p{L}\p{N}][-–])((?:rs\.?|pkr|usd|\$)\s?)?([-−–]\s?)?((?:rs\.?|pkr|usd|\$)\s?)?(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(thousand|hazaa?r|hazaron|ہزار|lakhs?|lacs?|لاکھ|crores?|cr|karor|karod|karore|کروڑ|millions?|mn|billions?|bn|arab|ارب)(?![\p{L}])|([kKmM])(?![\p{L}\p{N}]))?(\s?%|\s+percent\b)?/giu;

const blank = (match: string) => ' '.repeat(match.length);

function blankExemptSpans(ascii: string): string {
  let out = ascii;
  // Day-month dates go first, before ordinals lose their suffix.
  out = out.replace(DAY_MONTH, (match, ordinal?: string, month?: string, year?: string) =>
    isAmbiguousMonth(month!, ordinal, year) ? match : blank(match)
  );
  out = out.replace(MONTH_DAY, (match, month?: string, ordinal?: string, year?: string) =>
    isAmbiguousMonth(month!, ordinal, year) ? match : blank(match)
  );
  for (const pattern of EXEMPT_SPANS) out = out.replace(pattern, blank);
  out = out.replace(SHORT_DATE, (match, first: string, second: string, offset: number) =>
    isShortDate(out, offset, Number(first), Number(second)) ? blank(match) : match
  );
  return out;
}

/** Words before a figure that make a 1900–2100 integer a year. */
const YEAR_BEFORE = new RegExp(
  `(?:\\b(?:in|since|during|until|till|through|between|year|years|fy|cy|fiscal|financial|calendar|as\\s+of|san|sal|saal|q[1-4]|h[12]|${MONTH}\\.?,?)|سال|سن)\\s*'?$`,
  'iu'
);
/** "2025-26", "2024–2026": a financial year or a year range. */
const YEAR_AFTER = /^\s*[-–/]\s*(?:(?:19|20)\d{2}|\d{2})(?![\p{N}])/u;

function readsAsYear(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 16), index);
  if (YEAR_BEFORE.test(before)) return true;
  const after = YEAR_AFTER.exec(text.slice(index + length, index + length + 8));
  if (!after) return false;
  const year = Number(text.slice(index, index + length));
  const next = after[0].replace(/[^\d]/g, '');
  return next.length === 4 ? Number(next) > year : Number(next) === (year + 1) % 100;
}

/** Every figure in `text`, including exempt-sized ones; dates, times and links excluded. */
export function extractFigures(text: string): Figure[] {
  return extract(asciiDigits(text));
}

function extract(ascii: string): Figure[] {
  const figures: Figure[] = [];
  for (const match of blankExemptSpans(ascii).matchAll(FIGURE)) {
    // Groups: 1 currency, 2 sign, 3 currency, 4 digits, 5 scale word, 6 scale letter, 7 percent.
    const digits = match[4]!.replace(/,/g, '');
    const mantissa = Number(digits);
    if (!Number.isFinite(mantissa)) continue;
    const decimals = digits.includes('.') ? digits.length - digits.indexOf('.') - 1 : 0;
    const scaleKey = (match[5] ?? match[6] ?? '').toLowerCase();
    const scale = scaleKey ? (SCALE_WORDS[scaleKey] ?? 1) : 1;
    figures.push({
      raw: match[0].trim(),
      value: mantissa * scale,
      tolerance: 0.5 * 10 ** -decimals * scale,
      percent: Boolean(match[7]),
      index: match.index,
    });
  }
  return figures;
}

function isExemptFigure(figure: Figure, ascii: string): boolean {
  const digits = figure.raw.replace(/^[-−–]\s?/, '');
  if (!/^\d+$/.test(digits) || figure.percent) return false;
  if (figure.value <= SMALL_INTEGER_EXEMPTION) return true;
  // A four-digit year, where the words around it say so ("in 2026", not "sold 2000").
  return (
    figure.value >= 1900 &&
    figure.value <= 2100 &&
    readsAsYear(ascii, figure.index + figure.raw.length - digits.length, digits.length)
  );
}

/** The figures in `text` that must be grounded: everything except the exemptions. */
export function checkableFigures(text: string): Figure[] {
  const ascii = asciiDigits(text);
  return extract(ascii).filter((figure) => !isExemptFigure(figure, ascii));
}

/** Numeric values the current turn may restate. */
export class GroundingEvidence {
  private values: number[] = [];
  private sorted = true;

  get size(): number {
    return this.values.length;
  }

  private add(value: number) {
    if (!Number.isFinite(value)) return;
    this.values.push(Math.abs(value));
    this.sorted = false;
  }

  private addNumber(value: number, key: string, minor = false) {
    this.add(value);
    if (minor || /minor$/i.test(key)) this.add(value / 100);
    if (/percent|pct/i.test(key)) this.add(value / 100);
    else if (
      /ratio|rate|share|fraction|proportion/i.test(key) ||
      (!Number.isInteger(value) && Math.abs(value) <= 1)
    )
      this.add(value * 100);
  }

  private addText(text: string, key: string, minor: boolean) {
    const trimmed = text.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      this.addNumber(Number(trimmed), key, minor);
      return;
    }
    for (const figure of extractFigures(text)) {
      this.add(figure.value);
      if (figure.percent) this.add(figure.value / 100);
    }
  }

  /** Add one tool result (any JSON-like value). */
  addToolOutput(output: unknown) {
    let nodes = 0;
    const walk = (value: unknown, key: string, minor: boolean, depth: number) => {
      if (depth > MAX_WALK_DEPTH || ++nodes > MAX_WALK_NODES) return;
      if (typeof value === 'number') return this.addNumber(value, key, minor);
      if (typeof value === 'bigint') return this.addNumber(Number(value), key, minor);
      if (typeof value === 'string') return this.addText(value, key, minor);
      if (!value || typeof value !== 'object' || value instanceof Date) return;
      if (Array.isArray(value)) {
        this.add(value.length);
        for (const item of value) walk(item, key, minor, depth + 1);
        return;
      }
      const toJSON = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') return walk(toJSON.call(value), key, minor, depth + 1);
      const entries = Object.entries(value);
      // A claim such as { metricKey: 'salesMinor', value } or a block with
      // moneyUnit: 'integer_minor' carries its amounts in minor units.
      const minorHere =
        minor ||
        entries.some(
          ([childKey, child]) =>
            MINOR_UNIT_LABEL_KEYS.has(childKey) && typeof child === 'string' && /minor/i.test(child)
        );
      for (const [childKey, child] of entries) walk(child, childKey, minorHere, depth + 1);
    };
    walk(output, '', false, 0);
  }

  /** Add the figures a user typed. */
  addUserText(text: string) {
    for (const figure of extractFigures(text)) {
      this.add(figure.value);
      if (figure.percent) this.add(figure.value / 100);
    }
  }

  /**
   * Add the user's own text and any tool results already in the conversation. Earlier
   * results come from the client like the user's text, so they ground no more than the
   * user could type; earlier assistant prose is not evidence.
   */
  addConversation(messages: readonly UIMessage[]) {
    for (const message of messages) {
      for (const part of message.parts ?? []) {
        const record = part as {
          type?: unknown;
          text?: unknown;
          state?: unknown;
          output?: unknown;
        };
        if (message.role === 'user' && record.type === 'text' && typeof record.text === 'string')
          this.addUserText(record.text);
        if (
          message.role === 'assistant' &&
          typeof record.type === 'string' &&
          (record.type.startsWith('tool-') || record.type === 'dynamic-tool') &&
          record.state === 'output-available'
        )
          this.addToolOutput(record.output);
      }
    }
  }

  /** Whether some evidence lies within the figure's displayed precision. */
  matches(figure: Figure): boolean {
    if (!this.sorted) {
      this.values.sort((a, b) => a - b);
      this.sorted = true;
    }
    const slack = figure.tolerance + 1e-9 * Math.max(1, figure.value);
    const low = figure.value - slack;
    let lo = 0;
    let hi = this.values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.values[mid]! < low) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.values.length && this.values[lo]! <= figure.value + slack;
  }
}

export type GroundingResult = { ok: boolean; figures: number; unmatched: number };

export function checkGrounding(text: string, evidence: GroundingEvidence): GroundingResult {
  const figures = checkableFigures(text);
  const unmatched = figures.filter((figure) => !evidence.matches(figure)).length;
  return { ok: unmatched === 0, figures: figures.length, unmatched };
}

export type AnswerGuardVerdict =
  { kind: 'ok' } | { kind: 'dosing' } | ({ kind: 'ungrounded' } & GroundingResult);

/** Dosing first (safety), then figures. */
export function reviewAnswerText(text: string, evidence: GroundingEvidence): AnswerGuardVerdict {
  if (detectDosingInstruction(text)) return { kind: 'dosing' };
  const grounding = checkGrounding(text, evidence);
  return grounding.ok ? { kind: 'ok' } : { kind: 'ungrounded', ...grounding };
}

type GuardLog = (
  event: 'ASSISTANT_GROUNDING_REJECTED' | 'ASSISTANT_DOSING_REJECTED',
  detail: Record<string, number>
) => void;

const defaultLog: GuardLog = (event, detail) => console.error(event, detail);

/**
 * `experimental_transform` for the assistant's `streamText`. Text is held per text id
 * and released at its `text-end` (or at `finish-step` / stream end, if a block was
 * left open) after the dosing and grounding checks; a failing block is replaced with a
 * fixed message. `text-start` passes straight through, so each id keeps the
 * start → delta → end order the SDK's step bookkeeping requires, and the replaced
 * text is what reaches the client, `result.text` and the next step's messages.
 * Tool results are collected as they stream past.
 */
export function createAnswerGuardTransform<TOOLS extends ToolSet>(
  evidence: GroundingEvidence,
  log: GuardLog = defaultLog
) {
  return () => {
    const open = new Map<string, string>();
    // Ids this guard has already closed (at a finish-step or stream end). Anything the
    // provider sends for them afterwards is dropped, never passed through unchecked.
    const closed = new Set<string>();
    const release = (
      id: string,
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>
    ) => {
      const buffered = open.get(id) ?? '';
      open.delete(id);
      if (!buffered) return;
      const verdict = reviewAnswerText(buffered, evidence);
      let text = buffered;
      if (verdict.kind === 'dosing') {
        log('ASSISTANT_DOSING_REJECTED', { characters: buffered.length });
        text = DOSING_REJECTED_TEXT;
      } else if (verdict.kind === 'ungrounded') {
        log('ASSISTANT_GROUNDING_REJECTED', {
          figures: verdict.figures,
          unmatched: verdict.unmatched,
          evidence: evidence.size,
        });
        text = GROUNDING_REJECTED_TEXT;
      }
      controller.enqueue({ type: 'text-delta', id, text } as TextStreamPart<TOOLS>);
    };
    const closeOpen = (controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>) => {
      for (const id of [...open.keys()]) {
        release(id, controller);
        closed.add(id);
        controller.enqueue({ type: 'text-end', id } as TextStreamPart<TOOLS>);
      }
    };
    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        switch (part.type) {
          case 'text-start':
            if (closed.has(part.id) || open.has(part.id)) return;
            open.set(part.id, '');
            controller.enqueue(part);
            return;
          case 'text-delta':
            // Text for an id that is not open (never started, or already closed here)
            // is dropped: only checked text leaves this guard.
            if (open.has(part.id)) open.set(part.id, open.get(part.id)! + part.text);
            return;
          case 'text-end':
            if (!open.has(part.id)) return;
            release(part.id, controller);
            controller.enqueue(part);
            return;
          case 'start-step':
            // Providers may reuse text ids from one step to the next.
            closed.clear();
            controller.enqueue(part);
            return;
          case 'tool-result':
            if (!part.preliminary) evidence.addToolOutput(part.output);
            controller.enqueue(part);
            return;
          case 'finish-step':
          case 'finish':
            closeOpen(controller);
            controller.enqueue(part);
            return;
          default:
            controller.enqueue(part);
        }
      },
      flush(controller) {
        closeOpen(controller);
      },
    });
  };
}
