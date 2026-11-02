/**
 * Answer language for Ask Fathom (DEV-582).
 *
 * The only stored language preference today is the workspace locale
 * (`Organization.locale`, e.g. `ur` or `ur-PK`); users have no per-user locale until
 * the app-wide i18n foundation (DEV-504) lands. Ask Fathom also answers in the language
 * the user writes in, so an Urdu-script chat message selects Urdu even in an English
 * workspace. The server resolves this once into the assistant context; tools read it
 * from there and never infer a language themselves. Only English and Urdu are
 * supported; anything else is English, which keeps every existing English prompt and
 * tool result unchanged.
 */
export type AIOutputLocale = 'en' | 'ur';

/** Map a stored workspace locale to a supported answer locale. */
export function aiOutputLocale(locale: string | null | undefined): AIOutputLocale {
  return /^ur(?:[-_]|$)/i.test(locale?.trim() ?? '') ? 'ur' : 'en';
}

// A letter in Arabic script (Urdu is written in it); digits and punctuation do not count.
const URDU_SCRIPT_LETTER = /(?=\p{L})\p{Script=Arabic}/u;

/** True when the text contains Urdu (Arabic-script) letters. */
export function containsUrduScript(text: string): boolean {
  return URDU_SCRIPT_LETTER.test(text);
}

/** Chat locale: an Urdu-script message is answered in Urdu; otherwise the workspace locale. */
export function resolveAssistantLocale(
  workspaceLocale: string | null | undefined,
  latestUserText: string
): AIOutputLocale {
  return containsUrduScript(latestUserText) ? 'ur' : aiOutputLocale(workspaceLocale);
}

export const URDU_OUTPUT_INSTRUCTION =
  'Write in Urdu (اردو) using Urdu script. If the user writes in English or Roman Urdu, reply in the language they wrote in. Keep returned figures, dates, ids, metric keys, links and source names exactly as returned; translate only your own wording, and never soften a refusal, limitation or unknown in translation.';

/** The system-prompt language directive, or null for the English default. */
export function aiLanguageInstruction(locale: AIOutputLocale | null | undefined): string | null {
  return locale === 'ur' ? URDU_OUTPUT_INSTRUCTION : null;
}

/** Attached to tool results so the answer language sits next to the data it describes. */
export function aiToolOutputLanguage(locale: AIOutputLocale | null | undefined) {
  return locale === 'ur' ? { locale: 'ur' as const, instruction: URDU_OUTPUT_INSTRUCTION } : null;
}
