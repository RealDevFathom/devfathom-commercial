/**
 * Canonical source of the Confidentiality & Non-Replication Agreement.
 *
 * This module has NO server-only dependencies so it can be imported by both the
 * server router (to hash the exact text for the acceptance record) and the
 * client gate (to render it). Keeping a single source guarantees that the text a
 * user sees is exactly the text whose hash we store as evidence of acceptance.
 *
 * NOTE: This is a practical draft, not legal advice. Have counsel review before
 * relying on it. Bump AGREEMENT_VERSION on any material change so prior
 * acceptances remain attributable to the exact text that was accepted.
 */

export const AGREEMENT_VERSION = '1.0';

export const OWNER = {
  legalName: 'Intelligent Health Partners LLC',
  shortName: 'Intelligent Health Partners',
  entityType: 'a Wyoming limited liability company',
  product: 'DevFathom Hub',
  governingState: 'State of Wyoming, USA',
  venue: 'the state and federal courts located in the State of Wyoming',
} as const;

export const AGREEMENT_TITLE = 'Confidentiality & Non-Replication Agreement';

export const AGREEMENT_PREAMBLE =
  `This Confidentiality & Non-Replication Agreement (the "Agreement") is between ` +
  `${OWNER.legalName}, ${OWNER.entityType}, which owns and operates ${OWNER.product} (the "Owner"), ` +
  `and you, the individual or entity accessing or using ${OWNER.product} (the "Recipient"). ` +
  `By typing your name, checking the box, and clicking "Agree and continue", and each time you ` +
  `access or use ${OWNER.product}, you agree to be bound by this Agreement.`;

export const AGREEMENT_CLAUSES: { heading: string; body: string }[] = [
  {
    heading: 'Confidential information',
    body:
      `All non-public information you access or learn through ${OWNER.product} — including its ` +
      `features, design, user interface, workflows, structure, data models, methods, and underlying ` +
      `ideas (collectively, the "Confidential Information") — is the confidential and proprietary ` +
      `property of the Owner. You will hold it in strict confidence, use it only as the Owner permits, ` +
      `and not disclose it to any third party without the Owner's prior written consent.`,
  },
  {
    heading: 'Exclusions',
    body:
      `Confidential Information does not include information that: (a) is or becomes public through no ` +
      `fault of yours; (b) you can document you already knew before receiving it; (c) you independently ` +
      `develop without use of or reference to the Confidential Information; or (d) you are legally ` +
      `compelled to disclose, provided you give the Owner prompt prior notice and cooperate to limit ` +
      `the disclosure.`,
  },
  {
    heading: 'Ownership and intellectual property',
    body:
      `${OWNER.product}, together with its concept, design, and implementation, and all related ` +
      `intellectual property, is and remains the exclusive property of the Owner. This Agreement grants ` +
      `you only a limited, revocable, non-transferable right to access and use ${OWNER.product} as ` +
      `authorized by the Owner, and no other right or license, whether express or implied.`,
  },
  {
    heading: 'Non-replication and non-compete',
    body:
      `You will not, directly or indirectly, and whether alone or with or through any other person or ` +
      `company, build, develop, reproduce, copy, commission, distribute, market, or sell any product or ` +
      `service that is the same as or substantially similar to ${OWNER.product}, in whole or in any ` +
      `material part, where doing so uses, incorporates, or is derived from the Confidential Information, ` +
      `without the Owner's prior written permission. You agree this restriction is reasonable and ` +
      `necessary to protect the Owner's legitimate business interests.`,
  },
  {
    heading: 'No reverse engineering',
    body:
      `You will not reverse engineer, decompile, disassemble, or otherwise attempt to derive the source ` +
      `code, structure, or methods of ${OWNER.product}, except to the extent this restriction is ` +
      `prohibited by applicable law.`,
  },
  {
    heading: 'Term and survival',
    body:
      `These obligations take effect when you first accept, apply each time you access or use ` +
      `${OWNER.product}, continue for so long as the information remains confidential, and survive the ` +
      `end of your access to or use of ${OWNER.product}.`,
  },
  {
    heading: 'Remedies',
    body:
      `You acknowledge that a breach of this Agreement may cause the Owner irreparable harm for which ` +
      `monetary damages alone are inadequate, and that the Owner is entitled to seek injunctive relief ` +
      `in addition to any other remedy available at law or in equity, without the need to post a bond.`,
  },
  {
    heading: 'Disclaimer and limitation of liability',
    body:
      `${OWNER.product} is provided "as is" and "as available", without warranties of any kind, whether ` +
      `express or implied. To the maximum extent permitted by law, the Owner will not be liable for any ` +
      `indirect, incidental, special, consequential, or punitive damages arising from your access to or ` +
      `use of ${OWNER.product}.`,
  },
  {
    heading: 'Governing law and venue',
    body:
      `This Agreement is governed by the laws of the ${OWNER.governingState}, without regard to its ` +
      `conflict-of-laws rules. You consent to the exclusive jurisdiction and venue of ${OWNER.venue} for ` +
      `any dispute arising out of or relating to this Agreement.`,
  },
  {
    heading: 'Electronic signature',
    body:
      `You agree that typing your name and clicking "Agree and continue" is your electronic signature ` +
      `under the U.S. ESIGN Act and the Uniform Electronic Transactions Act (UETA), and has the same ` +
      `legal effect as a handwritten signature. You consent to transact electronically.`,
  },
  {
    heading: 'General',
    body:
      `This Agreement is the entire agreement between you and the Owner regarding its subject matter and ` +
      `supersedes any prior understanding on that subject. If any provision is held unenforceable, the ` +
      `rest remains in effect and the unenforceable provision is enforced to the maximum extent ` +
      `permitted. The Owner's failure to enforce a provision is not a waiver. The Owner may assign this ` +
      `Agreement; you may not without the Owner's consent. The Owner may update these terms, and your ` +
      `continued use after an update is acceptance of the updated terms.`,
  },
];

export const AGREEMENT_SIGNATURE_NOTE =
  `By clicking "Agree and continue", you adopt your typed name as your electronic signature for this ` +
  `Agreement, executed as of the date shown.`;

/**
 * Stable, exact serialization of the agreement. The server hashes this string;
 * the client renders the same parts. Do not reformat casually — a change here
 * changes the stored hash, so bump AGREEMENT_VERSION alongside any real edit.
 */
export const AGREEMENT_CANONICAL_TEXT = [
  `${AGREEMENT_TITLE} (version ${AGREEMENT_VERSION})`,
  `Owner: ${OWNER.legalName}, ${OWNER.entityType}.`,
  AGREEMENT_PREAMBLE,
  ...AGREEMENT_CLAUSES.map((c, i) => `${i + 1}. ${c.heading}\n${c.body}`),
  AGREEMENT_SIGNATURE_NOTE,
].join('\n\n');
