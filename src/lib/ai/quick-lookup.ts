import type { AITier } from './tiers';

/**
 * Model tier for one Ask Fathom turn (DEV-576). Only a quick lookup gets `cheap`: a
 * short, single, read-only question with no write, analysis or advice intent, on a
 * fresh turn (not an approval continuation or a forced action) with a read tool to
 * answer it. Everything else is `standard`. The router resolves `cheap` to the default
 * model unless small-model lookups are switched on.
 */

export const QUICK_LOOKUP_MAX_CHARS = 120;
export const QUICK_LOOKUP_MAX_WORDS = 15;

const READ_TOOL = /^(?:list|get|find|search|global|ask)[A-Z]/;

const QUESTION_START =
  /^(?:what|what's|whats|which|who|whose|where|when|how (?:many|much)|is|are|was|were|do|does|did|has|have|show|list|give me|tell me|kitna|kitni|kitne|kya|kaun|kahan|kab|کتنا|کتنی|کتنے|کیا|کون|کہاں|کب)(?=[\s?؟,]|$)/iu;

/** Anything that asks for a change, a draft or a message. */
const WRITE_INTENT =
  /\b(?:create|add|new|make|update|edit|change|set|rename|move|mark|assign|unassign|delete|remove|cancel|close|reopen|archive|approve|reject|deny|send|post|reply|message|dm|email|notify|remind|invite|hire|lay ?off|fire|terminate|deactivate|activate|reset|schedule|book|reschedule|request|submit|withdraw|resign|draft|write|compose|record|log|pay|refund|invoice (?:them|him|her)|bana(?:o|do|ein|ain)?|bhej(?:o|do|ein|ain)?|kar(?:o|do|ein|ain)|likh(?:o|do|ein|ain)?|hata(?:o|do|ein|ain)?|badal(?:o|do|ein|ain)?)\b|بناؤ|بھیجو|لکھو|ہٹاؤ|بدلو|کر دو/iu;

/** Questions that need reasoning, not a lookup. */
const ANALYSIS_INTENT =
  /\b(?:why|explain|analy[sz]e|analysis|compare|comparison|versus|vs\.?|trend|forecast|predict|recommend|suggest|advice|advise|should|strategy|plan|improve|optimi[sz]e|summari[sz]e|summary|brief|insight|breakdown|break down|reason|cause|what if|kyun|kyon|kaise)\b|کیوں|کیسے/iu;

export type QuickLookupInput = {
  /** The latest user message only. */
  latestUserText: string;
  isApprovalContinuation: boolean;
  /** True when the route forces a specific tool (for example `requestLeave`). */
  forcedTool: boolean;
  toolNames: readonly string[];
};

export function isQuickLookup(input: QuickLookupInput): boolean {
  if (input.isApprovalContinuation || input.forcedTool) return false;
  const text = input.latestUserText.trim().replace(/\s+/g, ' ');
  if (!text || text.length > QUICK_LOOKUP_MAX_CHARS) return false;
  if (text.split(' ').length > QUICK_LOOKUP_MAX_WORDS) return false;
  // One question, one sentence.
  if ((text.match(/[?؟]/g) ?? []).length > 1 || /[.!;\n]\s*\S/.test(text.replace(/\d\.\d/g, '')))
    return false;
  if (!QUESTION_START.test(text) && !/[?؟]$/.test(text)) return false;
  if (WRITE_INTENT.test(text) || ANALYSIS_INTENT.test(text)) return false;
  return input.toolNames.some((name) => READ_TOOL.test(name));
}

export function assistantTurnTier(input: QuickLookupInput): AITier {
  return isQuickLookup(input) ? 'cheap' : 'standard';
}
