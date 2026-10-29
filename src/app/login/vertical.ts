export type LoginVertical = 'pharmacy' | 'restaurant' | 'hotel' | 'agency' | 'default';

/** Presentation only; never changes tenant identity, permissions, or auth routing. */
export function loginVertical(
  query: unknown,
  host?: string | null,
  tenantVertical?: string
): LoginVertical {
  const candidates = [tenantVertical, query, host?.split(':')[0]?.split('.')[0]];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const normalized = value.toLowerCase();
    if (normalized === 'hospitality') return 'hotel';
    if (normalized === 'agency' || normalized === 'studio') return 'agency';
    if (normalized === 'pharmacy' || normalized === 'restaurant' || normalized === 'hotel')
      return normalized;
  }
  return 'default';
}

export const verticalCopy = {
  default: {
    tag: 'Workspace',
    lines: ['Work with', 'the whole', 'picture.'],
    description: 'Your team, your operations and your next decision, in one workspace.',
    signIn: 'Sign in to pick up the work your team is moving forward.',
    setup: 'Request your workspace',
    opening: 'Starting a new workspace?',
  },
  agency: {
    tag: 'Agency / Studio',
    lines: ['Your clients.', 'Your team.', 'One studio.'],
    description: 'Projects, clients and your team’s next decision, together in your workspace.',
    signIn: 'Sign in to continue your client and project work.',
    setup: 'Request your workspace',
    opening: 'Starting a new studio?',
  },
  pharmacy: {
    tag: 'Pharmacy',
    lines: ['Know every', 'batch on', 'the shelf.'],
    description:
      'Counter, stock, khata and day close for your pharmacy, with the licence and pharmacist on record.',
    signIn: 'Sign in to open the counter, check stock and close the day.',
    setup: 'Register your pharmacy',
    opening: 'Opening a new pharmacy?',
  },
  restaurant: {
    tag: 'Restaurants',
    lines: ['Every ticket', 'from till', 'to table.'],
    description:
      'Tills, kitchen display, floor, stock and cash for every branch, with each shift closed against the drawer.',
    signIn: 'Sign in to manage branches, menus, stock and the day’s cash.',
    setup: 'Set up your restaurant',
    opening: 'Opening a new restaurant?',
  },
  hotel: {
    tag: 'Hotels',
    lines: ['Your property,', 'ready for', 'the next step.'],
    description:
      'Set up your property, owner account and operating details. Your workspace starts with a reviewed setup request.',
    signIn: 'Sign in to continue setting up your property workspace.',
    setup: 'Set up your property',
    opening: 'Opening a new property?',
  },
} as const;
export const workspaceEyebrow = (vertical: LoginVertical) =>
  vertical === 'default' ? 'Secure workspace access' : `${vertical} workspace`;
