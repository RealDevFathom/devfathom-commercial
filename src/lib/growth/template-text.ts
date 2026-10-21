const ALLOWED = new Set([
  'name',
  'business',
  'discount',
  'code',
  'expires',
  'product',
  'reviewUrl',
  'referralCode',
]);

export const SAMPLE_TEMPLATE_VARS: Record<string, string> = {
  name: 'Ayesha',
  business: 'Sehat Pharmacy',
  discount: '10%',
  code: 'SEHA-DEMO1',
  expires: '4 Nov',
  product: 'Panadol',
  reviewUrl: 'https://g.page/sehat',
  referralCode: 'AYE-1042',
};

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Null when the body can be saved. Unknown {{var}} or a missing STOP line is refused. */
export function templateIssues(body: string): string | null {
  const unknown = new Set<string>();
  for (const match of body.matchAll(TOKEN)) {
    const name = match[1] ?? '';
    if (!ALLOWED.has(name)) unknown.add(name);
  }
  if (unknown.size) {
    const list = [...unknown].map((name) => `{{${name}}}`).join(', ');
    return `${list} cannot be filled. Use ${[...ALLOWED].join(', ')}.`;
  }
  if (!/stop/i.test(body)) {
    return 'Include STOP so a customer can opt out (band karo).';
  }
  return null;
}

export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(TOKEN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? whole) : whole
  );
}
