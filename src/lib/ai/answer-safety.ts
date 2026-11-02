/**
 * Clinical safety for Ask Fathom answers (DEV-576): no dosing advice, in any vertical.
 *
 * The detector looks for dosing instructions, not for medicines: frequency ("twice a
 * day", "every 8 hours", "1-0-1", "TDS"), administration ("take 2 tablets", "give 5 ml")
 * and weight-based dosing ("15 mg/kg"). A plain strength in a stock list ("Panadol
 * 500mg: 40 in stock") is not an instruction and passes. English, Roman Urdu and Urdu
 * script are covered. Frequency and timing phrases count only in a sentence that also
 * names a dose form, so "cash is counted twice a day" passes.
 */

const QUANTITY =
  '(?:\\d+(?:\\.\\d+)?|half|one|two|three|four|five|a|an|1/2)(?:\\s*(?:-|to|or)\\s*(?:\\d+(?:\\.\\d+)?|one|two|three|four))?';

/** Dose forms that are given, not just stocked. "mg" alone is a strength, not a dose form. */
const DOSE_FORM =
  '(?:tablets?|tabs?|capsules?|caps?|pills?|ml|mls|millilit(?:re|er)s?|drops?|puffs?|sachets?|teaspoons?(?:ful)?|tablespoons?(?:ful)?|tsp|tbsp|spoons?(?:ful)?|doses?|injections?|lozenges?|suppositor(?:y|ies)|patch(?:es)?|goli|golian|goliyan|chamach|chamch|qatray|qatre|qatry)';

/** Words that make a frequency or timing phrase about medicine. */
const DOSE_CONTEXT =
  /\b(?:tablets?|tabs?|capsules?|caps?|pills?|mg|mcg|ml|drops?|puffs?|sachets?|syrup|suspension|teaspoons?|tablespoons?|spoons?|doses?|dosage|injections?|inhaler|medicines?|medications?|antibiotics?|goli|golian|goliyan|dawai|dawa|dawaai|khurak|chamach|chamch|qatray|qatre)\b|\d\s*(?:mg|mcg|ml|g)\b|گولی|گولیاں|خوراک|چمچ|دوا|دوائی|شربت|کیپسول|قطرے|انجکشن/iu;

/** Instructions on their own. */
const STRONG: RegExp[] = [
  // Weight-based dosing.
  /\b\d*(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|units?|iu)\s*(?:\/|per)\s*(?:kg|kilo(?:gram)?s?)\b/i,
  /\bper\s+(?:kg|kilo(?:gram)?)\s+(?:of\s+)?(?:body\s*)?weight\b/i,
  /\/\s*kg\s*\/\s*day\b/i,
  // Administration verb + quantity + dose form.
  new RegExp(
    `\\b(?:take|takes|taking|give|giving|administer|administering|use|apply|inject|chew|swallow|dissolve|instil+|insert|inhale|put|lein|lain|len|khayen|khaen|khain|dein|dain|pilayen|pilaen|dalein|dalain)\\s+${QUANTITY}\\s*${DOSE_FORM}\\b`,
    'i'
  ),
  // Dose phrasing.
  /\b(?:recommended|usual|typical|standard|adult|child(?:ren)?'?s?|pa?ediatric|maximum|max|daily|starting|initial|loading|maintenance)\s+(?:daily\s+)?dos(?:e|es|age|ing)\b/i,
  /\bdos(?:e|age)\s+(?:is|of|for|should be)\s+\d/i,
  /\bdo not (?:exceed|take more than)\s+\d/i,
  // Roman Urdu: quantity + tablet/spoon/drops ("do goli", "aik chamach").
  /\b(?:ek|aik|do|teen|char|chaar|adhi|aadhi|\d+)\s+(?:goli|golian|goliyan|chamach|chamch|qatray|qatre|qatry)\b/i,
  // Urdu script: quantity + tablet/spoon/drops.
  /(?:ایک|دو|تین|چار|آدھی|\d+)\s*(?:گولی|گولیاں|چمچ|قطرے)/u,
];

/** Frequency and timing language; a match needs dose context in the same sentence. */
const CONTEXTUAL: RegExp[] = [
  /\b(?:once|twice|thrice|(?:one|two|three|four|five|six|\d+)\s+times?)\s+(?:a|per|each|every)\s+day\b/i,
  /\b(?:once|twice|thrice)\s+(?:daily|nightly)\b/i,
  /\bevery\s+\d+(?:\s*(?:-|to)\s*\d+)?\s*(?:hours?|hrs?|h)\b/i,
  /\bq\.?\s?\d+\s?h\b/i,
  /\b(?:bid|tid|qid|tds|prn|b\.d\.|o\.d\.|t\.i\.d\.|b\.i\.d\.|q\.i\.d\.|q\.d\.|h\.s\.)(?![\p{L}])/iu,
  /(?<![\p{N}-])[0-2](?:\s*[-+]\s*[0-2]){2}(?![\p{N}-])/u,
  /\b(?:before|after|with)\s+(?:meals?|food|breakfast|lunch|dinner|eating)\b/i,
  /\bon an empty stomach\b|\bat bedtime\b|\bbefore (?:bed|sleep)\b/i,
  new RegExp(
    `\\b${QUANTITY}\\s*${DOSE_FORM}\\s+(?:a|per|each|every)\\s+(?:day|night|morning)\\b`,
    'i'
  ),
  // Roman Urdu frequency and timing.
  /\b(?:din|roz(?:ana)?)\s+(?:m[ae]i?n|me)\s+(?:ek|aik|do|teen|char|\d+)\s+(?:baar|bar|dafa|dafah|martaba)\b/i,
  /\b(?:ek|aik|do|teen|char)\s+(?:baar|bar|dafa|martaba)\s+(?:roz|rozana|din)\b/i,
  /\bsubah\s+(?:o\s+|aur\s+)?sh?aa?m\b/i,
  /\bhar\s+\d+\s+(?:ghante|ghantay|ghanta)\b/i,
  /\braat\s+ko\s+(?:sote|sotay|sonay|sone)\b/i,
  /\bkhan[ae]y?\s+(?:ke|k|se)\s+(?:baad|bad|pehle|pehlay|sath|saath)\b/i,
  // Urdu script frequency and timing.
  /دن\s*میں\s*(?:ایک|دو|تین|چار|\d+)\s*(?:بار|دفعہ|مرتبہ)/u,
  /کھانے\s*(?:کے|سے)\s*(?:بعد|پہلے|ساتھ)/u,
  /صبح\s*(?:و\s*|اور\s*)?شام/u,
  /ہر\s*\d+\s*گھنٹے/u,
];

/** A quantity + dose form preceded by sales or stock words is a count, not a dose. */
const COUNT_CONTEXT =
  /\b(?:sell|sells|sold|selling|sale|sales|dispens\w*|stock\w*|order\w*|bought|purchas\w*|received|returned|on hand|units?)\b[^.!?\n]{0,25}$/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?؟۔])\s+|\n+/u).filter((sentence) => sentence.trim());
}

function contextualMatch(sentence: string): boolean {
  if (!DOSE_CONTEXT.test(sentence)) return false;
  for (const pattern of CONTEXTUAL) {
    const match = pattern.exec(sentence);
    if (!match) continue;
    // "Panadol sells 40 tablets a day" is a sales rate.
    if (COUNT_CONTEXT.test(sentence.slice(0, match.index))) continue;
    return true;
  }
  return false;
}

/** Whether `text` contains a dosing instruction. */
export function detectDosingInstruction(text: string): boolean {
  if (!text.trim()) return false;
  for (const sentence of sentences(text)) {
    if (STRONG.some((pattern) => pattern.test(sentence))) return true;
    if (contextualMatch(sentence)) return true;
  }
  return false;
}
