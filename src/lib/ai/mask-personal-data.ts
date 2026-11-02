import type {
  JSONValue,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from '@ai-sdk/provider';

/**
 * Personal-data masking for prompts sent to Amazon Bedrock (the third provider in
 * the chain). Masking is one way: the model sees placeholders such as `[phone]`, and
 * nothing is restored in the answer.
 *
 * It must not change ordinary figures: amounts, quantities, dates, times, barcodes
 * and ids pass through untouched. JSON numbers are only replaced when they sit under
 * a personal-data key.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Pakistani IBAN: PK + 2 check digits + 4-letter bank code + 16 digits, optionally in groups of four.
const PK_IBAN = /\bPK\d{2}(?:[ ]?[A-Z0-9]{4}){5}\b/gi;
// CNIC in its printed form 12345-1234567-1.
const CNIC = /(?<![\d-])\d{5}-\d{7}-\d(?![\d-])/g;
// Card numbers: 15-16 contiguous digits, or 4-4-4-4(-3) / Amex 4-6-5 groups; then a Luhn check.
const CARD =
  /(?<![\w.,-])(?:\d{15,16}|\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1\d{3})?|\d{4}([ -])\d{6}\2\d{5})(?![\w-]|[.,]\d)/g;
// International numbers written with a leading + or 00 (8 to 15 digits).
const INTERNATIONAL_PHONE = /(?<![\w+/#-])(?:\+|\b00)\d(?:[ ().-]{0,2}\d){7,14}(?![\w]|[.,]\d)/g;
// Pakistani mobiles 03XX-XXXXXXX (with or without the dash or a space).
const PK_MOBILE = /(?<![\w.,-])03\d{2}[ -]?\d{7}(?![\w-]|[.,]\d)/g;
// Pakistani landlines with an area code and a separator, e.g. 021-34567890, 042 35761234.
const PK_LANDLINE = /(?<![\w.,-])0[2-9]\d{1,2}[ -]\d{6,8}(?![\w-]|[.,]\d)/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function looksLikeCard(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  // Issuer ranges in use: 2 (Mastercard 2-series, PayPak), 3 (Amex, JCB), 4, 5, 6.
  return /^[2-6]/.test(digits) && luhn(digits);
}

/** Mask personal data in free text. */
export function maskPersonalText(text: string): string {
  if (!text) return text;
  return text
    .replace(EMAIL, '[email]')
    .replace(PK_IBAN, '[iban]')
    .replace(CNIC, '[cnic]')
    .replace(CARD, (match) => (looksLikeCard(match) ? '[card]' : match))
    .replace(INTERNATIONAL_PHONE, (match) => {
      const digits = match.replace(/\D/g, '').length - (match.startsWith('00') ? 2 : 0);
      return digits >= 8 && digits <= 15 ? '[phone]' : match;
    })
    .replace(PK_MOBILE, '[phone]')
    .replace(PK_LANDLINE, '[phone]');
}

const PERSONAL_KEYS = new Set([
  'phone',
  'phonenumber',
  'mobile',
  'mobilenumber',
  'cell',
  'cellphone',
  'telephone',
  'whatsapp',
  'whatsappnumber',
  'email',
  'emailaddress',
  'cnic',
  'nic',
  'nationalid',
  'address',
  'customername',
  'patientname',
  'contactname',
  'guardianname',
]);
const PERSONAL_SUFFIXES = [
  'phone',
  'phonenumber',
  'mobile',
  'email',
  'cnic',
  'address',
  'whatsapp',
];

/** Whether a JSON key names personal data, e.g. `phone`, `customerPhone`, `billing_address`. */
export function isPersonalDataKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (PERSONAL_KEYS.has(normalized)) return true;
  if (/^address(line)?\d*$/.test(normalized)) return true;
  return PERSONAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

const REDACTED = '[redacted]';

/** Mask personal data in a JSON value: personal-data keys are redacted, strings are masked. */
export function maskPersonalJson(value: JSONValue): JSONValue {
  if (typeof value === 'string') return maskPersonalText(value);
  if (Array.isArray(value)) return value.map(maskPersonalJson);
  if (value && typeof value === 'object') {
    const masked: Record<string, JSONValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      masked[key] =
        isPersonalDataKey(key) && child !== null && typeof child !== 'boolean'
          ? REDACTED
          : maskPersonalJson(child);
    }
    return masked;
  }
  return value;
}

/** Free text, or a JSON document carried as text (tool results often are). */
function maskTextOrJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as JSONValue;
      const masked = JSON.stringify(maskPersonalJson(parsed));
      // Unchanged JSON keeps its original formatting.
      return masked === JSON.stringify(parsed) ? text : masked;
    } catch {
      // Not JSON after all: mask it as text.
    }
  }
  return maskPersonalText(text);
}

function maskUnknown(value: unknown): unknown {
  if (typeof value === 'string') return maskTextOrJson(value);
  if (value === null || value === undefined) return value;
  try {
    return maskPersonalJson(JSON.parse(JSON.stringify(value)) as JSONValue);
  } catch {
    return value;
  }
}

function maskToolOutput(output: LanguageModelV3ToolResultOutput): LanguageModelV3ToolResultOutput {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return { ...output, value: maskTextOrJson(output.value) };
    case 'json':
    case 'error-json':
      return { ...output, value: maskPersonalJson(output.value) };
    case 'execution-denied':
      return output.reason ? { ...output, reason: maskPersonalText(output.reason) } : output;
    case 'content':
      return {
        ...output,
        value: output.value.map((item) =>
          item.type === 'text' ? { ...item, text: maskTextOrJson(item.text) } : item
        ),
      };
    default:
      return output;
  }
}

/**
 * The prompt with personal data masked in every place text reaches the model: the
 * system prompt, text and reasoning parts, tool-call inputs, tool results and
 * approval reasons. Files and images are passed through unchanged.
 */
export function maskPersonalDataInPrompt(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
  return prompt.map((message) => {
    switch (message.role) {
      case 'system':
        return { ...message, content: maskTextOrJson(message.content) };
      case 'user':
        return {
          ...message,
          content: message.content.map((part) =>
            part.type === 'text' ? { ...part, text: maskTextOrJson(part.text) } : part
          ),
        };
      case 'assistant':
        return {
          ...message,
          content: message.content.map((part) => {
            switch (part.type) {
              case 'text':
              case 'reasoning':
                return { ...part, text: maskTextOrJson(part.text) };
              case 'tool-call':
                return { ...part, input: maskUnknown(part.input) };
              case 'tool-result':
                return { ...part, output: maskToolOutput(part.output) };
              default:
                return part;
            }
          }),
        };
      case 'tool':
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type === 'tool-result')
              return { ...part, output: maskToolOutput(part.output) };
            if (part.type === 'tool-approval-response' && part.reason) {
              return { ...part, reason: maskPersonalText(part.reason) };
            }
            return part;
          }),
        };
      default:
        return message;
    }
  }) as LanguageModelV3Prompt;
}
