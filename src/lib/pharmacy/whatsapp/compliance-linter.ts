/**
 * DEV-29 — deterministic WhatsApp compliance linter (research §10, Compliant Messaging 1).
 *
 * Checks template text and send-time variable values. Customer-facing WhatsApp text never
 * names a drug, salt or medicine category (Meta commerce policy, DRAP s.24), so any match
 * against the branch catalogue names or the static term list BLOCKS, including common
 * misspellings, digit-for-letter substitutions and Urdu-script transliterations of Latin
 * catalogue names. Promotional wording in a utility message and health claims WARN.
 *
 * The linter is pure: callers load catalogue names (`readTenantMedicineNames`) and write
 * the block log row (`recordWhatsAppComplianceBlock`). An optional intent classification
 * (for example from an AI classifier) may be passed in; it can only add warnings, never
 * clear a deterministic block.
 */

import { normalizeNameText } from '../medicine-names';

export const WHATSAPP_LINTER_VERSION = 'wa-compliance-lint-v1';

export type WhatsAppMessagePurpose = 'UTILITY' | 'MARKETING';
export type WhatsAppLintOutcome = 'BLOCK' | 'WARN' | 'PASS';
export type WhatsAppLintReasonCode =
  | 'CATALOG_MEDICINE_NAME'
  | 'STATIC_MEDICINE_TERM'
  | 'PROMOTIONAL_IN_UTILITY'
  | 'HEALTH_CLAIM'
  | 'INTENT_MISMATCH';

export type WhatsAppLintReason = {
  code: WhatsAppLintReasonCode;
  outcome: Exclude<WhatsAppLintOutcome, 'PASS'>;
  source: 'TEMPLATE' | 'VARIABLE' | 'INTENT';
  /** Variable position (0-based) for a VARIABLE reason. */
  index?: number;
  /** The catalogue or static term that matched — never the raw variable value. */
  term?: string;
  match?: 'EXACT' | 'MISSPELLING' | 'TRANSLITERATION';
};

export type WhatsAppLintResult = {
  outcome: WhatsAppLintOutcome;
  reasons: WhatsAppLintReason[];
  linterVersion: string;
};

/** Optional classifier output; it can only add warnings. */
export type WhatsAppIntentClassification = {
  category: WhatsAppMessagePurpose;
  promotional?: boolean;
  healthClaim?: boolean;
};

export type WhatsAppLintOptions = {
  /** Minimum term length (characters) checked for one-letter misspellings. */
  misspellingMinLength?: number;
  /** Minimum term length (characters) allowed two-letter misspellings. */
  twoEditMinLength?: number;
  /** Minimum consonant-skeleton length matched for Urdu-script transliterations. */
  transliterationMinSkeleton?: number;
};

export const DEFAULT_WHATSAPP_LINT_OPTIONS: Required<WhatsAppLintOptions> = {
  misspellingMinLength: 6,
  twoEditMinLength: 9,
  transliterationMinSkeleton: 4,
};

/**
 * Static drug, salt and medicine-category terms (English, Roman Urdu, Urdu script). The
 * tenant catalogue adds its own brands, aliases and ingredients on top of these.
 */
export const STATIC_MEDICINE_TERMS: readonly string[] = [
  // Generic medicine words and categories
  'medicine',
  'medicines',
  'medication',
  'medications',
  'drug',
  'drugs',
  'dawa',
  'dawai',
  'dawaai',
  'dawaiyan',
  'antibiotic',
  'antibiotics',
  'painkiller',
  'painkillers',
  'antidepressant',
  'antidepressants',
  'antihistamine',
  'antihistamines',
  'sedative',
  'sedatives',
  'sleeping pill',
  'sleeping pills',
  'steroid',
  'steroids',
  'contraceptive',
  'contraceptives',
  'birth control',
  'opioid',
  'opioids',
  'tranquilizer',
  'tranquilizers',
  'دوا',
  'دوائی',
  'دوائیں',
  'ادویات',
  'اینٹی بائیوٹک',
  'نیند کی گولی',
  // Common salts and brands in Pakistan
  'paracetamol',
  'acetaminophen',
  'ibuprofen',
  'diclofenac',
  'mefenamic',
  'aspirin',
  'amoxicillin',
  'augmentin',
  'azithromycin',
  'ciprofloxacin',
  'metronidazole',
  'flagyl',
  'omeprazole',
  'esomeprazole',
  'metformin',
  'insulin',
  'cetirizine',
  'loratadine',
  'codeine',
  'tramadol',
  'alprazolam',
  'diazepam',
  'sildenafil',
  'tadalafil',
  'panadol',
  'brufen',
  'disprin',
  'calpol',
  'ponstan',
  'arinac',
  'پیناڈول',
  'پیراسیٹامول',
  'بروفین',
  'ڈسپرین',
  'انسولین',
];

const PROMOTIONAL_TERMS: readonly string[] = [
  'offer',
  'offers',
  'discount',
  'discounts',
  'sale',
  'deal',
  'deals',
  'cashback',
  'coupon',
  'voucher',
  'promo',
  'promotion',
  'free',
  'limited time',
  'buy one',
  'riayat',
  'sasta',
  'آفر',
  'رعایت',
  'ڈسکاؤنٹ',
  'مفت',
  'سیل',
];

const HEALTH_CLAIM_TERMS: readonly string[] = [
  'cure',
  'cures',
  'cured',
  'guaranteed',
  'guarantee',
  'miracle',
  'no side effects',
  'weight loss',
  'lose weight',
  'treats',
  'heals',
  'ilaj',
  'ilaaj',
  'shifa',
  'علاج',
  'شفا',
];

/** Ordinary words one or two letters from a medicine term; never treated as misspellings. */
const NOT_MISSPELLINGS = new Set(['meditation', 'meditations', 'dawat', 'dawaat', 'dawatein']);

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

/**
 * Normalized text with digit-for-letter substitutions undone inside words that also hold
 * letters ("p4nad0l" → "panadol"). Pure numbers (amounts, dates) are left as they are.
 */
function foldedText(value: string): string {
  const deLeet = value.replace(/[\p{L}\p{N}@$]+/gu, (word) =>
    /\p{L}/u.test(word) && /[\d@$]/.test(word) ? word.replace(/[\d@$]/g, (c) => LEET[c] ?? c) : word
  );
  return normalizeNameText(deLeet);
}

/** Repeated letters collapsed ("panaadool" → "panadol"). */
const collapse = (value: string) => value.replace(/(.)\1+/gu, '$1');

const URDU_CONSONANTS: Record<string, string> = {
  ب: 'b',
  پ: 'p',
  ت: 't',
  ٹ: 't',
  ث: 's',
  ج: 'j',
  چ: 'c',
  خ: 'k',
  د: 'd',
  ڈ: 'd',
  ذ: 'z',
  ر: 'r',
  ڑ: 'r',
  ز: 'z',
  ژ: 'z',
  س: 's',
  ش: 's',
  ص: 's',
  ض: 'z',
  ط: 't',
  ظ: 'z',
  غ: 'g',
  ف: 'f',
  ق: 'k',
  ک: 'k',
  ك: 'k',
  گ: 'g',
  ل: 'l',
  م: 'm',
  ن: 'n',
  ں: 'n',
};

const isUrduScript = (value: string) => /[؀-ۿ]/u.test(value);

/** Consonant skeleton of an Urdu-script word: vowels, aspiration and hamza dropped. */
function urduSkeleton(word: string): string {
  return collapse([...word].map((ch) => URDU_CONSONANTS[ch] ?? '').join(''));
}

/** Consonant skeleton of a Latin word, spelled the way Urdu script writes it. */
function latinSkeleton(word: string): string {
  const spelled = word
    .toLowerCase()
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/v/g, 'w')
    .replace(/[^a-z]/g, '')
    .replace(/[aeiouywh]/g, '');
  return collapse(spelled);
}

/** Whether Levenshtein distance between `a` and `b` is at most `max`. */
function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}

type TermIndex = {
  phrases: Set<string>;
  /** Single-word Latin terms bucketed by every message length within their allowed edits. */
  fuzzy: Map<number, string[]>;
  /** Latin-term consonant skeletons for Urdu-script transliterations. */
  skeletons: Map<string, string>;
};

function buildIndex(terms: Iterable<string>, options: Required<WhatsAppLintOptions>): TermIndex {
  const index: TermIndex = { phrases: new Set(), fuzzy: new Map(), skeletons: new Map() };
  for (const raw of terms) {
    const term = normalizeNameText(raw);
    if ([...term].length < 3) continue;
    // Keep the literal name ("coq10") and its de-leeted form, as messages are checked both ways.
    for (const variant of new Set([term, foldedText(raw)])) {
      index.phrases.add(variant);
      index.phrases.add(collapse(variant));
    }
    if (term.includes(' ') || isUrduScript(term) || !/^[a-z]+$/.test(term)) continue;
    const base = collapse(term);
    if (base.length >= options.misspellingMinLength) {
      const max = base.length >= options.twoEditMinLength ? 2 : 1;
      // Every message length within the allowed edits, whatever letter changed.
      for (let length = base.length - max; length <= base.length + max; length++) {
        const bucket = index.fuzzy.get(length) ?? [];
        bucket.push(base);
        index.fuzzy.set(length, bucket);
      }
    }
    const skeleton = latinSkeleton(term);
    if (skeleton.length >= options.transliterationMinSkeleton && !index.skeletons.has(skeleton))
      index.skeletons.set(skeleton, term);
  }
  return index;
}

type TermMatch = { term: string; match: NonNullable<WhatsAppLintReason['match']> };

function findTerm(
  text: string,
  index: TermIndex,
  options: Required<WhatsAppLintOptions>
): TermMatch | null {
  const folded = foldedText(text);
  if (!folded) return null;
  const literal = normalizeNameText(text);
  const haystacks = [...new Set([folded, collapse(folded), literal, collapse(literal)])].map(
    (value) => ` ${value} `
  );
  for (const phrase of index.phrases)
    if (haystacks.some((haystack) => haystack.includes(` ${phrase} `)))
      return { term: phrase, match: 'EXACT' };
  for (const word of folded.split(' ')) {
    if (isUrduScript(word)) {
      const skeleton = urduSkeleton(word);
      const term =
        skeleton.length >= options.transliterationMinSkeleton
          ? index.skeletons.get(skeleton)
          : undefined;
      if (term) return { term, match: 'TRANSLITERATION' };
      continue;
    }
    const base = collapse(word);
    if (
      !/^[a-z]+$/.test(base) ||
      base.length < options.misspellingMinLength - 1 ||
      NOT_MISSPELLINGS.has(word)
    )
      continue;
    for (const candidate of index.fuzzy.get(base.length) ?? []) {
      const max = candidate.length >= options.twoEditMinLength ? 2 : 1;
      if (withinDistance(base, candidate, max)) return { term: candidate, match: 'MISSPELLING' };
    }
  }
  return null;
}

const containsPhrase = (text: string, phrases: readonly string[]) => {
  const haystack = ` ${normalizeNameText(text)} `;
  return phrases.some((phrase) => haystack.includes(` ${normalizeNameText(phrase)} `));
};

const isPromotional = (text: string) =>
  /\d+\s*%\s*off/i.test(text) || containsPhrase(text, PROMOTIONAL_TERMS);

const STATIC_INDEX_CACHE = new Map<string, TermIndex>();

function staticIndex(options: Required<WhatsAppLintOptions>): TermIndex {
  const key = JSON.stringify(options);
  let index = STATIC_INDEX_CACHE.get(key);
  if (!index) {
    index = buildIndex(STATIC_MEDICINE_TERMS, options);
    STATIC_INDEX_CACHE.set(key, index);
  }
  return index;
}

/**
 * Lint a WhatsApp template body and/or its send-time variable values.
 * BLOCK wins over WARN; every reason is returned so the caller can log and explain it.
 */
export function lintWhatsAppMessage(input: {
  purpose: WhatsAppMessagePurpose;
  template?: string | null;
  variables?: readonly string[];
  catalogNames?: Iterable<string>;
  intent?: WhatsAppIntentClassification | null;
  options?: WhatsAppLintOptions;
}): WhatsAppLintResult {
  const options = { ...DEFAULT_WHATSAPP_LINT_OPTIONS, ...input.options };
  const catalog = buildIndex(input.catalogNames ?? [], options);
  const statics = staticIndex(options);
  const reasons: WhatsAppLintReason[] = [];
  const parts: Array<{ source: 'TEMPLATE' | 'VARIABLE'; text: string; index?: number }> = [];
  if (input.template) parts.push({ source: 'TEMPLATE', text: input.template });
  (input.variables ?? []).forEach((text, index) => parts.push({ source: 'VARIABLE', text, index }));

  for (const part of parts) {
    const where = part.source === 'VARIABLE' ? { index: part.index } : {};
    const catalogHit = findTerm(part.text, catalog, options);
    const staticHit = catalogHit ? null : findTerm(part.text, statics, options);
    if (catalogHit)
      reasons.push({
        code: 'CATALOG_MEDICINE_NAME',
        outcome: 'BLOCK',
        source: part.source,
        ...where,
        ...catalogHit,
      });
    else if (staticHit)
      reasons.push({
        code: 'STATIC_MEDICINE_TERM',
        outcome: 'BLOCK',
        source: part.source,
        ...where,
        ...staticHit,
      });
    if (input.purpose === 'UTILITY' && isPromotional(part.text))
      reasons.push({
        code: 'PROMOTIONAL_IN_UTILITY',
        outcome: 'WARN',
        source: part.source,
        ...where,
      });
    if (containsPhrase(part.text, HEALTH_CLAIM_TERMS))
      reasons.push({ code: 'HEALTH_CLAIM', outcome: 'WARN', source: part.source, ...where });
  }

  const intent = input.intent;
  if (intent) {
    if (intent.category !== input.purpose)
      reasons.push({ code: 'INTENT_MISMATCH', outcome: 'WARN', source: 'INTENT' });
    if (
      input.purpose === 'UTILITY' &&
      intent.promotional &&
      !reasons.some((r) => r.code === 'PROMOTIONAL_IN_UTILITY')
    )
      reasons.push({ code: 'PROMOTIONAL_IN_UTILITY', outcome: 'WARN', source: 'INTENT' });
    if (intent.healthClaim && !reasons.some((r) => r.code === 'HEALTH_CLAIM'))
      reasons.push({ code: 'HEALTH_CLAIM', outcome: 'WARN', source: 'INTENT' });
  }

  const outcome: WhatsAppLintOutcome = reasons.some((r) => r.outcome === 'BLOCK')
    ? 'BLOCK'
    : reasons.length
      ? 'WARN'
      : 'PASS';
  return { outcome, reasons, linterVersion: WHATSAPP_LINTER_VERSION };
}

/** Customer-safe explanation of a blocked result; never repeats the matched term. */
export function whatsAppLintMessage(result: WhatsAppLintResult): string {
  return result.reasons.some((r) => r.outcome === 'BLOCK' && r.source === 'VARIABLE')
    ? 'A message value names a medicine, salt or medicine category. WhatsApp text cannot name medicines.'
    : 'WhatsApp text cannot name a medicine, salt or medicine category. Use generic retail copy.';
}
