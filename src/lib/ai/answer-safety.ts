/**
 * Clinical safety for Ask Fathom answers (DEV-576): no dosing advice, in any vertical.
 *
 * The detector looks for dosing instructions, not for medicines. Some phrasings are
 * instructions on their own: weight-based dosing ("15 mg/kg"), dose phrasing ("the usual
 * adult dose") and an administration verb with a dose ("take 2 tablets"). Everything
 * else is decided per sentence from four signals:
 *   - frequency or timing ("three times daily", "every six hours", "1-0-1", "TDS",
 *     "after meals", "per dose", "din mein do baar", "ہر 6 گھنٹے");
 *   - a dose (a quantity with a dose form, "1 tablet", "do goli", "دو گولیاں") or
 *     medicine context ("500mg", "syrup", "dawai");
 *   - an administration verb ("take", "give", "lein", "پلائیں");
 *   - operations language ("sold", "in stock", "ran out", "restocked", "bikri", "اسٹاک").
 * A count of tablets is never advice on its own ("Panadol ki 40 goliyan stock mein hain"),
 * and frequency words in a stock or sales sentence describe the business ("sells 40
 * tablets a day"), unless a dose sits next to the frequency with no operations word
 * beside it ("1 tablet 3 times daily; 40 in stock"). English, Roman Urdu and Urdu script
 * are covered; Urdu digits are read as ASCII digits.
 */

const EN_NUMBER =
  '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty[- ]?four)';
const UR_NUMBER =
  '(?:ek|aik|do|teen|tin|char|chaar|panch|paanch|chhe|chay|chhay|che|saat|aath|ath|barah|baara)';
const URDU_NUMBER = '(?:ایک|دو|تین|چار|پانچ|چھ|سات|آٹھ|بارہ|\\d+)';

const QUANTITY_TERM = `(?:\\d+(?:\\.\\d+)?|half|a|an|1/2|${EN_NUMBER})`;
const QUANTITY = `${QUANTITY_TERM}(?:\\s*(?:-|to|or)\\s*${QUANTITY_TERM})?`;
const UR_QUANTITY = `(?:${UR_NUMBER}|adhi|aadhi|adha|aadha|\\d+(?:\\.\\d+)?)`;

/** Dose forms that are given, not just stocked. "mg" alone is a strength, not a dose form. */
const DOSE_FORM =
  '(?:tablets?|tabs?|capsules?|caps?|pills?|ml|mls|millilit(?:re|er)s?|drops?|puffs?|sachets?|teaspoons?(?:ful)?|tablespoons?(?:ful)?|tsp|tbsp|spoons?(?:ful)?|doses?|injections?|lozenges?|suppositor(?:y|ies)|patch(?:es)?|units?|iu)';
const UR_DOSE_FORM =
  '(?:goli|golian|goliyan|goliya|golia|chamach|chamch|chamche|chamchay|qatray|qatre|qatry|qatra|tablets?|capsules?|ml)';
const URDU_DOSE_FORM = '(?:گولی|گولیاں|گولیوں|چمچ|چمچے|قطرے|قطرہ|کیپسول)';

/** A dose: a quantity with a dose form, in any of the three scripts. */
const DOSE_PATTERNS: RegExp[] = [
  // "a tab" and "a cap" are usually not doses ("open a tab").
  new RegExp(`\\b(?!an?\\s+(?:tabs?|caps?)\\b)${QUANTITY}\\s*${DOSE_FORM}\\b`, 'gi'),
  new RegExp(`\\b${UR_QUANTITY}\\s+${UR_DOSE_FORM}\\b`, 'gi'),
  new RegExp(`(?<![\\p{L}])${URDU_NUMBER}\\s*${URDU_DOSE_FORM}`, 'gu'),
];

/** Words that make a frequency or timing phrase about medicine. */
const MEDICINE_CONTEXT =
  /\b(?:tablets?|capsules?|pills?|mg|mcg|ml|drops?|puffs?|sachets?|syrup|suspension|teaspoons?|tablespoons?|spoons?|doses?|dosage|injections?|inhaler|cream|ointment|gel|lotion|medicines?|medications?|antibiotics?|goli|golian|goliyan|dawai|dawa|dawaai|khurak|chamach|chamch|qatray|qatre|sharbat)\b|\d\s*(?:mg|mcg|ml|g)\b|گولی|گولیاں|خوراک|چمچ|دوا|دوائی|شربت|کیپسول|قطرے|انجکشن/iu;

/** Frequency, timing and per-dose language. */
const FREQUENCY_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(?:once|twice|thrice|(?:\\d+|${EN_NUMBER})\\s*(?:x|times?))\\s+(?:a|per|each|every)\\s+(?:day|night|morning|evening)\\b`,
    'gi'
  ),
  new RegExp(
    `\\b(?:once|twice|thrice|(?:\\d+|${EN_NUMBER})\\s*(?:x|times?))\\s+(?:daily|nightly|a\\s+day|per\\s+day|in\\s+24\\s+hours)\\b`,
    'gi'
  ),
  new RegExp(
    `\\bevery\\s+(?:\\d+|${EN_NUMBER})(?:\\s*(?:-|to|or)\\s*(?:\\d+|${EN_NUMBER}))?\\s*(?:hours?|hrs?|h)\\b`,
    'gi'
  ),
  /\bevery\s+(?:morning|night|evening|bedtime)\b/gi,
  /\bq\.?\s?\d+\s?h\b/gi,
  /\b(?:bid|tid|qid|tds|prn|b\.d\.|o\.d\.|t\.i\.d\.|b\.i\.d\.|q\.i\.d\.|q\.d\.|h\.s\.)(?![\p{L}])/giu,
  /(?<![\p{N}-])[0-2](?:\s*[-+]\s*[0-2]){2}(?![\p{N}-])/gu,
  /\b(?:before|after|with)\s+(?:meals?|food|breakfast|lunch|dinner|eating)\b/gi,
  /\bon an empty stomach\b|\bat bedtime\b|\bbefore (?:bed|sleep)\b/gi,
  /\b(?:per|each|every|a)\s+dose\b/gi,
  new RegExp(
    `\\b${QUANTITY}\\s*${DOSE_FORM}\\s+(?:a|per|each|every)\\s+(?:day|night|morning)\\b`,
    'gi'
  ),
  // Roman Urdu.
  new RegExp(
    `\\b(?:din|roz(?:ana)?)\\s+(?:m[ae]i?n|me|men|mai)\\s+${UR_NUMBER}\\s+(?:baar|bar|dafa|dafah|martaba)\\b`,
    'gi'
  ),
  new RegExp(`\\b${UR_NUMBER}\\s+(?:baar|bar|dafa|martaba)\\s+(?:roz|rozana|din)\\b`, 'gi'),
  new RegExp(`\\b(?:roz|rozana)\\s+${UR_NUMBER}\\s+(?:baar|bar|dafa|martaba)\\b`, 'gi'),
  /\bsubah\s+(?:o\s+|aur\s+)?sh?aa?m\b/gi,
  new RegExp(`\\bhar\\s+(?:\\d+|${UR_NUMBER})\\s+(?:ghante|ghantay|ghanta|ghanton)\\b`, 'gi'),
  /\braat\s+ko\s+(?:sote|sotay|sonay|sone)\b/gi,
  /\bkhan[ae]y?\s+(?:ke|k|se)\s+(?:baad|bad|pehle|pehlay|sath|saath)\b/gi,
  /\bkhali\s+pet\b/gi,
  // Urdu script.
  new RegExp(`دن\\s*میں\\s*${URDU_NUMBER}\\s*(?:بار|دفعہ|مرتبہ)`, 'gu'),
  /کھانے\s*(?:کے|سے)\s*(?:بعد|پہلے|ساتھ)/gu,
  /صبح\s*(?:و\s*|اور\s*)?شام/gu,
  new RegExp(`ہر\\s*${URDU_NUMBER}\\s*گھنٹے`, 'gu'),
  /خالی\s*پیٹ/gu,
];

/** English administration verbs; the object must not be an operations noun. */
const EN_ADMIN_VERB =
  /\b(?:take|takes|taking|give|gives|giving|administer|administering|apply|inject|chew|swallow|dissolve|instil+|inhale)\s+(?!(?:a\s+)?(?:look|stock|inventory|note|notes|care|place|action|orders?|counts?|cash|backups?|break|breaks|photos?|pictures?|time|turns|deliver(?:y|ies)|readings?|attendance|payments?|discounts?|stock-?takes?|minutes?|calls?|bookings?)\b)(\S+)/gi;
/** "to be taken", "should be given". */
const EN_PASSIVE_ADMIN =
  /\b(?:to|should|must|can)\s+be\s+(?:taken|given|applied|swallowed|chewed|administered|injected)\b/i;
/** Verbs with a drug-like capitalised object ("take Panadol") need no other medicine context. */
const DRUG_VERB =
  /^(?:take|takes|taking|give|gives|giving|administer|administering|apply|inject|chew|swallow)$/i;
const DRUG_OBJECT = /^(?:it|them|this|these|one|both|\p{Lu}[\p{L}\p{N}-]*)$/u;
/** "Take every six hours": the verb's object is left implicit. */
const IMPLICIT_OBJECT = /^(?:every|once|twice|thrice|daily|nightly)$/i;
/**
 * After a capitalised object, a plain lower-case word other than these makes the object a
 * modifier ("take Excel exports"), not a drug ("take Panadol twice daily").
 */
const AFTER_DRUG =
  /^(?:every|once|twice|thrice|daily|nightly|after|before|with|at|on|in|for|when|if|and|or|as|only|regularly|three|two|four|one|five|six|tablets?|capsules?|pills?|syrup|drops?|cream|ointment|gel|mg|ml)$/i;
/** Roman Urdu and Urdu administration verbs (they close the clause). */
const UR_ADMIN_VERB_WORDS =
  '(?:lein|lain|len|leyn|lijiye|lijye|lijie|khayen|khaen|khain|khaein|khayein|khilayen|khilaen|khilaein|pilayen|pilaen|pilaein|pilaiye|dalein|dalain|daalein|lagayen|lagaen|lagaein)';
const UR_ADMIN_VERB = new RegExp(`\\b${UR_ADMIN_VERB_WORDS}\\b`, 'i');
const URDU_ADMIN_VERB =
  /(?<![\p{L}])(?:لیں|لیجیے|لیجئے|کھائیں|کھلائیں|پلائیں|ڈالیں|لگائیں|دیں)(?![\p{L}])/u;

/** Stock, sales and operations language: frequency words here describe the business. */
const OPERATIONS_WORDS =
  /\b(?:sell|sells|sold|selling|sale|sales|dispens\w*|stock\w*|restock\w*|in\s+stock|out\s+of\s+stock|ran\s+out|run\s+out|runs\s+out|running\s+out|sold\s+out|order\w*|reorder\w*|bought|purchas\w*|received|receiving|returned|returns|delivered|deliver(?:y|ies)|supplier\w*|units?|packs?|strips?|boxes|cartons?|expir\w*|wasted|written\s+off|write-?offs?|shrinkage|inventory|on\s+hand|shelf|shelves|bikri|biki|bika|bikay|bike|bikin|bikeen|bikti|bikta|bik|farokht|maal|khatam|mojood|maujood)\b|فروخت|بکی|بکیں|بکا|بکے|بک\s*گئ|اسٹاک|سٹاک|مال|آرڈر|ختم|موجود|ایکسپائر/iu;

/** Instructions on their own. */
const STRONG: RegExp[] = [
  // Weight-based dosing.
  /\b\d*(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|units?|iu)\s*(?:\/|per)\s*(?:kg|kilo(?:gram)?s?)\b/i,
  /\bper\s+(?:kg|kilo(?:gram)?)\s+(?:of\s+)?(?:body\s*)?weight\b/i,
  /\/\s*kg\s*\/\s*day\b/i,
  // English administration verb + quantity + dose form.
  new RegExp(
    `\\b(?:take|takes|taking|give|giving|administer|administering|use|apply|inject|chew|swallow|dissolve|instil+|insert|inhale|put)\\s+${QUANTITY}\\s*${DOSE_FORM}\\b`,
    'i'
  ),
  // Dose phrasing.
  /\b(?:recommended|usual|typical|standard|adult|child(?:ren)?'?s?|pa?ediatric|maximum|max|daily|starting|initial|loading|maintenance)\s+(?:daily\s+)?dos(?:e|es|age|ing)\b/i,
  /\bdos(?:e|age)\s+(?:is|of|for|should be)\s+\d/i,
  /\bdo not (?:exceed|take more than)\s+\d/i,
];

/** Roman Urdu or Urdu dose followed by an administration verb ("ek goli lein"). */
const UR_DOSE_THEN_VERB = new RegExp(
  `\\b${UR_QUANTITY}\\s+${UR_DOSE_FORM}\\b(?:\\s+\\S+){0,3}?\\s+${UR_ADMIN_VERB_WORDS}\\b`,
  'i'
);
const URDU_DOSE_THEN_VERB = new RegExp(
  `${URDU_NUMBER}\\s*${URDU_DOSE_FORM}(?:\\s+\\S+){0,3}?\\s*(?:لیں|لیجیے|لیجئے|کھائیں|کھلائیں|پلائیں|ڈالیں)(?![\\p{L}])`,
  'u'
);

type Span = { start: number; end: number };

function spans(patterns: RegExp[], sentence: string): Span[] {
  const out: Span[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of sentence.matchAll(pattern))
      out.push({ start: match.index, end: match.index + match[0].length });
  }
  return out;
}

const CLAUSE_BREAK = /[;:,()—–]/u;

/** Operations words right before or after a dose-and-frequency pair, within its clause. */
function countNearby(sentence: string, start: number, end: number): boolean {
  const beforeText = sentence.slice(Math.max(0, start - 30), start);
  const breakAt = Math.max(
    ...[...beforeText.matchAll(new RegExp(CLAUSE_BREAK, 'gu'))].map((m) => m.index + 1),
    0
  );
  const before = beforeText.slice(breakAt);
  const afterText = sentence.slice(end, end + 25);
  const afterBreak = afterText.search(CLAUSE_BREAK);
  const after = afterBreak === -1 ? afterText : afterText.slice(0, afterBreak);
  return OPERATIONS_WORDS.test(before) || OPERATIONS_WORDS.test(after);
}

/** A dose directly next to a frequency ("1 tablet 3 times daily") with no count word beside it. */
function adjacentDoseFrequency(sentence: string, doses: Span[], frequencies: Span[]): boolean {
  for (const dose of doses) {
    for (const frequency of frequencies) {
      const gap =
        frequency.start >= dose.end
          ? frequency.start - dose.end
          : dose.start >= frequency.end
            ? dose.start - frequency.end
            : 0;
      if (gap > 20) continue;
      const start = Math.min(dose.start, frequency.start);
      const end = Math.max(dose.end, frequency.end);
      if (!countNearby(sentence, start, end)) return true;
    }
  }
  return false;
}

function englishAdministration(sentence: string, medicine: boolean): boolean {
  if (EN_PASSIVE_ADMIN.test(sentence) && medicine) return true;
  EN_ADMIN_VERB.lastIndex = 0;
  for (const match of sentence.matchAll(EN_ADMIN_VERB)) {
    if (medicine) return true;
    const verb = match[0].split(/\s+/)[0]!;
    if (!DRUG_VERB.test(verb)) continue;
    const object = match[1]!.replace(/[^\p{L}\p{N}-]+$/u, '');
    if (IMPLICIT_OBJECT.test(object)) return true;
    if (!DRUG_OBJECT.test(object)) continue;
    // The object ends its clause, or is followed by a frequency, strength or dose form.
    if (object !== match[1]) return true;
    const rest = sentence.slice(match.index + match[0].length);
    const next = /^\s+(\S+)/u.exec(rest)?.[1]?.replace(/[^\p{L}\p{N}]+$/u, '') ?? '';
    if (!/^\p{Ll}+$/u.test(next) || AFTER_DRUG.test(next)) return true;
  }
  return false;
}

function sentenceHasDosing(sentence: string): boolean {
  if (STRONG.some((pattern) => pattern.test(sentence))) return true;
  const operations = OPERATIONS_WORDS.test(sentence);
  if (!operations && (UR_DOSE_THEN_VERB.test(sentence) || URDU_DOSE_THEN_VERB.test(sentence)))
    return true;

  const frequencies = spans(FREQUENCY_PATTERNS, sentence);
  if (frequencies.length === 0) return false;
  const doses = spans(DOSE_PATTERNS, sentence);
  const medicine = doses.length > 0 || MEDICINE_CONTEXT.test(sentence);

  // "He should take Brufen 400mg three times daily", "Take Panadol every six hours".
  if (englishAdministration(sentence, medicine)) return true;
  // "Panadol din mein do baar lein".
  if ((UR_ADMIN_VERB.test(sentence) || URDU_ADMIN_VERB.test(sentence)) && (medicine || !operations))
    return true;
  // "Two tablets every six hours", "Augmentin 625mg BID".
  if (medicine && !operations) return true;
  // A stock or sales sentence that still carries a dose next to a frequency.
  return adjacentDoseFrequency(sentence, doses, frequencies);
}

const EASTERN_DIGITS = /[٠-٩۰-۹]/g;
function asciiDigits(text: string): string {
  return text.replace(EASTERN_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?؟۔])\s+|\n+/u).filter((sentence) => sentence.trim());
}

/** Whether `text` contains a dosing instruction. */
export function detectDosingInstruction(text: string): boolean {
  if (!text.trim()) return false;
  return sentences(asciiDigits(text)).some(sentenceHasDosing);
}
