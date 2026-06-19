// The DevFathom email design system: a bulletproof, brand-matched shell plus a
// small set of composable building blocks. Everything is table-based with inline
// styles so it survives Outlook/Gmail; a <style> head adds progressive
// enhancement (web fonts, responsive, dark mode) for clients that honor it.

import { palette, fonts, layout } from './theme';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Escape user-supplied text before interpolating into email HTML. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type Tone = 'brand' | 'brass' | 'success' | 'warning' | 'danger' | 'neutral';

const TONE: Record<Tone, { fg: string; bg: string; border: string }> = {
  brand: { fg: palette.paper50, bg: palette.abyss700, border: palette.abyss700 },
  brass: { fg: palette.abyss900, bg: palette.brass, border: palette.brass },
  success: { fg: palette.success, bg: '#EAF0EC', border: '#CBDdD2' },
  warning: { fg: palette.warning, bg: '#F4EEDF', border: '#E4D6B4' },
  danger: { fg: palette.destructive, bg: '#F2E4E2', border: '#E2C6C1' },
  neutral: { fg: palette.slate700, bg: palette.paper100, border: palette.paper200 },
};

// ---------------------------------------------------------------------------
// Components — each returns an HTML string fragment
// ---------------------------------------------------------------------------

/** A small uppercase, letter-spaced kicker above the heading. Brass by default. */
export function eyebrow(text: string, color: string = palette.brass): string {
  return `<div style="font-family:${fonts.mono};font-size:11px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${color};margin:0 0 14px;">${esc(text)}</div>`;
}

/** Large display heading in the Oxanium face. */
export function heading(text: string): string {
  return `<h1 style="font-family:${fonts.heading};font-size:26px;line-height:1.25;font-weight:600;color:${palette.abyss800};margin:0 0 16px;letter-spacing:-0.01em;">${esc(text)}</h1>`;
}

/** A body paragraph. Pass `html: true` only with pre-escaped/trusted markup. */
export function paragraph(text: string, opts: { html?: boolean; muted?: boolean } = {}): string {
  const color = opts.muted ? palette.slate500 : palette.slate700;
  const content = opts.html ? text : esc(text);
  return `<p style="font-family:${fonts.body};font-size:16px;line-height:1.65;color:${color};margin:0 0 18px;">${content}</p>`;
}

/** A small inline status/priority chip (architectural, not pill-shaped). */
export function badge(text: string, tone: Tone = 'neutral'): string {
  const t = TONE[tone];
  return `<span style="display:inline-block;font-family:${fonts.mono};font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${t.fg};background:${t.bg};border:1px solid ${t.border};border-radius:${layout.radiusSm}px;padding:4px 10px;">${esc(text)}</span>`;
}

/** A bulletproof CTA button (Outlook VML + standard anchor fallback). */
export function button(label: string, href: string, tone: Tone = 'brand'): string {
  const t = TONE[tone];
  const safeHref = esc(href);
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px;">
    <tr>
      <td align="center" bgcolor="${t.bg}" style="border-radius:${layout.radius}px;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeHref}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="20%" stroke="f" fillcolor="${t.bg}">
        <w:anchorlock/>
        <center style="color:${t.fg};font-family:${fonts.body};font-size:15px;font-weight:600;">${esc(label)}</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-->
        <a href="${safeHref}" target="_blank" style="display:inline-block;font-family:${fonts.body};font-size:15px;font-weight:600;line-height:48px;color:${t.fg};text-decoration:none;padding:0 34px;border-radius:${layout.radius}px;">${esc(label)}</a>
        <!--<![endif]-->
      </td>
    </tr>
  </table>`;
}

export type MetaRow = { label: string; value: string; valueHtml?: boolean };

/** A bordered detail card of key/value metadata rows. */
export function detailCard(rows: MetaRow[]): string {
  const body = rows
    .map((r, i) => {
      const top = i === 0 ? '' : `border-top:1px solid ${palette.paper200};`;
      const value = r.valueHtml ? r.value : esc(r.value);
      return `
      <tr>
        <td style="${top}padding:12px 0;font-family:${fonts.mono};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${palette.slate500};white-space:nowrap;vertical-align:top;width:38%;">${esc(r.label)}</td>
        <td style="${top}padding:12px 0;font-family:${fonts.body};font-size:15px;color:${palette.ink900};vertical-align:top;text-align:right;">${value}</td>
      </tr>`;
    })
    .join('');
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${palette.paper50};border:1px solid ${palette.paper200};border-radius:${layout.radius}px;margin:0 0 26px;">
    <tr><td style="padding:6px 22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>
    </td></tr>
  </table>`;
}

/** A tinted callout box with a left accent rule — for alerts/notices. */
export function callout(html: string, tone: Tone = 'neutral'): string {
  const t = TONE[tone];
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${t.bg};border:1px solid ${t.border};border-left:3px solid ${t.fg};border-radius:${layout.radiusSm}px;margin:0 0 26px;">
    <tr><td style="padding:16px 18px;font-family:${fonts.body};font-size:15px;line-height:1.6;color:${palette.ink900};">${html}</td></tr>
  </table>`;
}

/** A quoted block — e.g. a comment, note excerpt, or mention context. */
export function quote(text: string, attribution?: string): string {
  const attr = attribution
    ? `<div style="font-family:${fonts.mono};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${palette.slate500};margin-top:10px;">— ${esc(attribution)}</div>`
    : '';
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;">
    <tr><td style="padding:4px 0 4px 20px;border-left:2px solid ${palette.brass};font-family:${fonts.body};font-size:16px;line-height:1.6;font-style:italic;color:${palette.slate700};">${esc(text)}${attr}</td></tr>
  </table>`;
}

/** A hairline divider. */
export function divider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${palette.paper200};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

export interface EmailDocument {
  /** Hidden preview snippet shown in the inbox list. */
  preheader: string;
  /** The composed body (use the component helpers above). */
  body: string;
  /** Footer note line under the brand sign-off (optional). */
  footnote?: string;
}

// Wordmark font stack — hardened so clients that drop web fonts NEVER fall to a
// serif. Oxanium first (Apple Mail honors the web font), then ubiquitous sans.
const WORDMARK_STACK = "'Oxanium', 'Trebuchet MS', 'Segoe UI', Helvetica, Arial, sans-serif";

function header(): string {
  // Typographic wordmark — no logo mark. The real mark is a raster image that
  // email can only show from a live URL; until one exists we lead with the
  // wordmark alone (brand is intentionally typographic/understated). If
  // EMAIL_LOGO_URL is set, the real mark slots in beside the wordmark with no
  // other change.
  const customLogo = process.env.EMAIL_LOGO_URL;
  const wordmark = `<td style="vertical-align:middle;font-family:${WORDMARK_STACK};font-size:24px;font-weight:700;letter-spacing:0.01em;color:${palette.abyss800};">DevFathom</td>`;
  const lockup = customLogo
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
         <td style="vertical-align:middle;padding-right:14px;"><img src="${esc(customLogo)}" width="40" height="40" alt="" style="display:block;border-radius:10px;border:0;outline:none;text-decoration:none;" /></td>
         ${wordmark}
       </tr></table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${wordmark}</tr></table>`;
  return `
  <tr>
    <td style="padding:36px 40px 0;">${lockup}</td>
  </tr>
  <tr><td style="padding:18px 40px 0;"><div style="height:2px;width:36px;background:${palette.brass};font-size:0;line-height:0;">&nbsp;</div></td></tr>`;
}

function footer(footnote?: string): string {
  const extra = footnote
    ? `<p style="font-family:${fonts.body};font-size:13px;line-height:1.6;color:${palette.slate500};margin:0 0 14px;">${footnote}</p>`
    : '';
  return `
  <tr>
    <td style="padding:8px 40px 40px;">
      ${divider()}
      <div style="height:22px;font-size:0;line-height:0;">&nbsp;</div>
      ${extra}
      <p style="font-family:${fonts.body};font-size:12px;line-height:1.6;color:${palette.slate500};margin:0;">
        Sent by <span style="color:${palette.slate700};font-weight:600;">DevFathom</span> · your team's command surface.<br/>
        You're receiving this because you're a member of the workspace.
      </p>
    </td>
  </tr>`;
}

/** Wrap composed body content in the full, client-safe HTML document. */
export function renderDocument(doc: EmailDocument): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>DevFathom</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <link href="https://fonts.googleapis.com/css2?family=Oxanium:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet" />
  <style>
    body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; background:${palette.paper50}; }
    table { border-collapse:collapse !important; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { -ms-interpolation-mode:bicubic; border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
    a { text-decoration:none; }
    .df-link { color:${palette.brassDeep}; text-decoration:underline; }
    @media only screen and (max-width:620px) {
      .df-card { width:100% !important; border-radius:0 !important; }
      .df-pad { padding-left:24px !important; padding-right:24px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${palette.paper50};">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${palette.paper50};opacity:0;">${esc(doc.preheader)}&#8202;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${palette.paper50};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" class="df-card" width="${layout.maxWidth}" cellpadding="0" cellspacing="0" border="0" style="width:${layout.maxWidth}px;max-width:${layout.maxWidth}px;background:${palette.paperWhite};border:1px solid ${palette.paper200};border-radius:${layout.radius}px;overflow:hidden;">
          ${header()}
          <tr>
            <td class="df-pad" style="padding:30px 40px 8px;">
              ${doc.body}
            </td>
          </tr>
          ${footer(doc.footnote)}
        </table>
        <div style="font-family:${fonts.mono};font-size:11px;letter-spacing:0.08em;color:${palette.slate500};padding:20px 0 0;">DEVFATHOM · dev-fathom-hub.vercel.app</div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Render a clickable inline link (use inside paragraph html). */
export function link(label: string, href: string): string {
  return `<a class="df-link" href="${esc(href)}" target="_blank" style="color:${palette.brassDeep};text-decoration:underline;">${esc(label)}</a>`;
}
