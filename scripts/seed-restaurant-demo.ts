/**
 * Showcase demo data layered on top of the deterministic restaurant E2E fixture.
 *
 * This module adds SEED DATA ONLY. It creates no schema, changes no product
 * behaviour, and every row it writes carries a fixed `demo_*` id so repeated
 * runs converge instead of accumulating. The base fixture ids owned by
 * `seed-restaurant-e2e.ts` (org, branch, devices, operator/manager, drawer,
 * brand, menu, publication, customer, loyalty program/account) are reused, never
 * renumbered, so the Playwright fixture contract keeps holding.
 *
 * The subject is a Pakistani café — Chai Chowk, Gulberg Lahore — priced in PKR,
 * with six business days of trading history so orders, bills, cash, loyalty,
 * inventory and insights all have something real to show.
 */
import { createHash } from 'node:crypto';

import { hashSync } from 'bcryptjs';

import type { PrismaClient } from '../src/generated/prisma/client.js';
import { moduleDefinitionForKey } from '../src/lib/module-catalog.js';
import { adminDepartmentKeyForVertical } from '../src/lib/vertical-catalog.js';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// Reuse the base fixture's bcrypt salt so PIN and password hashes stay
// byte-identical across runs (idempotency, not a security property — these are
// local demo credentials).
const DEMO_SALT = '$2b$12$abcdefghijklmnopqrstuu';

const AT = new Date('2026-08-27T00:00:00.000Z');

/** Business days with completed trading history, oldest first. */
const HISTORY_DATES = [
  '2026-08-21',
  '2026-08-22',
  '2026-08-23',
  '2026-08-24',
  '2026-08-25',
  '2026-08-26',
] as const;
/** The day the demo instance presents as "today" — carries live open orders. */
const TODAY = '2026-08-27';

function day(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
function at(date: string, hour: number, minute = 0): Date {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return new Date(`${date}T${hh}:${mm}:00.000Z`);
}
function money(value: number): string {
  return value.toFixed(2);
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

type CategorySeed = { key: string; name: string; sortOrder: number };

const CATEGORIES: readonly CategorySeed[] = [
  { key: 'chai', name: 'Chai & Beverages', sortOrder: 1 },
  { key: 'nashta', name: 'Nashta / Breakfast', sortOrder: 2 },
  { key: 'starters', name: 'Starters', sortOrder: 3 },
  { key: 'bbq', name: 'BBQ & Grill', sortOrder: 4 },
  { key: 'mains', name: 'Main Course', sortOrder: 5 },
  { key: 'breads', name: 'Tandoor & Breads', sortOrder: 6 },
  { key: 'desserts', name: 'Desserts', sortOrder: 7 },
];

type ProductSeed = {
  key: string;
  category: string;
  name: string;
  price: number;
  description: string;
  /** Kitchen station the item routes to: grill fires BBQ, expo plates the rest. */
  station: 'grill' | 'expo';
};

const PRODUCTS: readonly ProductSeed[] = [
  // Chai & Beverages
  {
    key: 'doodh-patti',
    category: 'chai',
    name: 'Doodh Patti Chai',
    price: 180,
    description: 'Full-cream tea simmered slow on the stove.',
    station: 'expo',
  },
  {
    key: 'karak-chai',
    category: 'chai',
    name: 'Karak Chai',
    price: 220,
    description: 'Strong cardamom tea, the Chowk house pour.',
    station: 'expo',
  },
  {
    key: 'kashmiri-chai',
    category: 'chai',
    name: 'Kashmiri Chai',
    price: 350,
    description: 'Pink salted tea topped with pistachio.',
    station: 'expo',
  },
  {
    key: 'green-tea',
    category: 'chai',
    name: 'Green Tea',
    price: 150,
    description: 'Kashmiri green leaf with mint.',
    station: 'expo',
  },
  {
    key: 'fresh-lime',
    category: 'chai',
    name: 'Fresh Lime Soda',
    price: 250,
    description: 'Sweet or salted, shaken to order.',
    station: 'expo',
  },
  {
    key: 'mango-lassi',
    category: 'chai',
    name: 'Mango Lassi',
    price: 380,
    description: 'Chaunsa mango churned with thick yogurt.',
    station: 'expo',
  },
  {
    key: 'sweet-lassi',
    category: 'chai',
    name: 'Sweet Lassi',
    price: 300,
    description: 'Hand-churned in the traditional matka.',
    station: 'expo',
  },
  {
    key: 'cold-coffee',
    category: 'chai',
    name: 'Cold Coffee',
    price: 450,
    description: 'Blended cold brew with vanilla cream.',
    station: 'expo',
  },
  // Nashta
  {
    key: 'halwa-puri',
    category: 'nashta',
    name: 'Halwa Puri Platter',
    price: 650,
    description: 'Four puri, sooji halwa, cholay and aloo bhujia.',
    station: 'expo',
  },
  {
    key: 'anda-paratha',
    category: 'nashta',
    name: 'Anda Paratha',
    price: 420,
    description: 'Desi eggs folded into a hand-rolled paratha.',
    station: 'grill',
  },
  {
    key: 'nihari',
    category: 'nashta',
    name: 'Beef Nihari',
    price: 850,
    description: 'Overnight shank nihari with ginger and lemon.',
    station: 'expo',
  },
  {
    key: 'channa-chaat',
    category: 'nashta',
    name: 'Channa Chaat',
    price: 320,
    description: 'Chickpeas, imli chutney and papri.',
    station: 'expo',
  },
  // Starters
  {
    key: 'samosa',
    category: 'starters',
    name: 'Chicken Samosa (2 pcs)',
    price: 180,
    description: 'Crisp folded pastry with spiced chicken.',
    station: 'grill',
  },
  {
    key: 'dahi-bhalla',
    category: 'starters',
    name: 'Dahi Bhalla',
    price: 350,
    description: 'Lentil dumplings under sweetened yogurt.',
    station: 'expo',
  },
  {
    key: 'malai-starter',
    category: 'starters',
    name: 'Malai Boti Starter',
    price: 690,
    description: 'Six pieces of cream-marinated chicken.',
    station: 'grill',
  },
  {
    key: 'masala-fries',
    category: 'starters',
    name: 'Masala Fries',
    price: 320,
    description: 'Chaat masala fries with garlic mayo.',
    station: 'grill',
  },
  // BBQ
  {
    key: 'chicken-seekh',
    category: 'bbq',
    name: 'Chicken Seekh Kabab',
    price: 720,
    description: 'Charcoal seekh with fresh coriander.',
    station: 'grill',
  },
  {
    key: 'beef-seekh',
    category: 'bbq',
    name: 'Beef Seekh Kabab',
    price: 780,
    description: 'Hand-minced beef seekh, four skewers.',
    station: 'grill',
  },
  {
    key: 'chicken-tikka',
    category: 'bbq',
    name: 'Chicken Tikka Boti',
    price: 850,
    description: 'Classic red masala boti off the coals.',
    station: 'grill',
  },
  {
    key: 'malai-boti',
    category: 'bbq',
    name: 'Malai Boti',
    price: 890,
    description: 'Cream and cheese marinade, mild heat.',
    station: 'grill',
  },
  {
    key: 'mutton-champ',
    category: 'bbq',
    name: 'Mutton Champ',
    price: 1450,
    description: 'Flattened lamb chops, Lahori style.',
    station: 'grill',
  },
  // Mains
  {
    key: 'chicken-karahi',
    category: 'mains',
    name: 'Chicken Karahi (Half)',
    price: 1250,
    description: 'Wok-fried with tomato, ginger and green chilli.',
    station: 'expo',
  },
  {
    key: 'mutton-karahi',
    category: 'mains',
    name: 'Mutton Karahi (Half)',
    price: 1850,
    description: 'Slow-cooked mutton in its own stock.',
    station: 'expo',
  },
  {
    key: 'chicken-biryani',
    category: 'mains',
    name: 'Chicken Biryani',
    price: 550,
    description: 'Sindhi-style layered biryani with raita.',
    station: 'expo',
  },
  {
    key: 'beef-pulao',
    category: 'mains',
    name: 'Beef Pulao',
    price: 620,
    description: 'Yakhni pulao with kachumber salad.',
    station: 'expo',
  },
  {
    key: 'daal-makhani',
    category: 'mains',
    name: 'Daal Makhani',
    price: 480,
    description: 'Black lentils finished with butter.',
    station: 'expo',
  },
  {
    key: 'palak-paneer',
    category: 'mains',
    name: 'Palak Paneer',
    price: 620,
    description: 'Spinach and house paneer.',
    station: 'expo',
  },
  // Breads
  {
    key: 'roti',
    category: 'breads',
    name: 'Tandoori Roti',
    price: 40,
    description: 'Fresh from the clay tandoor.',
    station: 'grill',
  },
  {
    key: 'naan',
    category: 'breads',
    name: 'Naan',
    price: 60,
    description: 'Soft white-flour naan.',
    station: 'grill',
  },
  {
    key: 'garlic-naan',
    category: 'breads',
    name: 'Garlic Naan',
    price: 160,
    description: 'Brushed with garlic butter and coriander.',
    station: 'grill',
  },
  {
    key: 'paratha',
    category: 'breads',
    name: 'Paratha',
    price: 120,
    description: 'Layered and pan-crisped.',
    station: 'grill',
  },
  // Desserts
  {
    key: 'gajar-halwa',
    category: 'desserts',
    name: 'Gajar Halwa',
    price: 350,
    description: 'Carrot halwa with khoya and almonds.',
    station: 'expo',
  },
  {
    key: 'kheer',
    category: 'desserts',
    name: 'Kheer',
    price: 300,
    description: 'Rice pudding chilled overnight.',
    station: 'expo',
  },
  {
    key: 'gulab-jamun',
    category: 'desserts',
    name: 'Gulab Jamun (2 pcs)',
    price: 280,
    description: 'Warm, in cardamom syrup.',
    station: 'expo',
  },
  {
    key: 'kulfi',
    category: 'desserts',
    name: 'Malai Kulfi',
    price: 320,
    description: 'Set in the traditional cone mould.',
    station: 'expo',
  },
];

const PRODUCT_BY_KEY = new Map(PRODUCTS.map((product) => [product.key, product]));

// ---------------------------------------------------------------------------
// Floor
// ---------------------------------------------------------------------------

type TableSeed = {
  code: string;
  capacity: number;
  floor: 'ground' | 'terrace';
  section: 'a' | 'b';
};

const TABLES: readonly TableSeed[] = [
  { code: 'T1', capacity: 2, floor: 'ground', section: 'a' },
  { code: 'T2', capacity: 4, floor: 'ground', section: 'a' },
  { code: 'T3', capacity: 4, floor: 'ground', section: 'a' },
  { code: 'T4', capacity: 6, floor: 'ground', section: 'a' },
  { code: 'T5', capacity: 2, floor: 'ground', section: 'b' },
  { code: 'T6', capacity: 4, floor: 'ground', section: 'b' },
  { code: 'T7', capacity: 8, floor: 'ground', section: 'b' },
  { code: 'T8', capacity: 4, floor: 'ground', section: 'b' },
  { code: 'R1', capacity: 4, floor: 'terrace', section: 'b' },
  { code: 'R2', capacity: 4, floor: 'terrace', section: 'b' },
  { code: 'R3', capacity: 6, floor: 'terrace', section: 'b' },
  { code: 'R4', capacity: 2, floor: 'terrace', section: 'b' },
];

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

type StaffSeed = {
  key: string;
  name: string;
  title: string;
  email: string;
  pin: string;
  /** Staff who take tables; orders are attributed round-robin across these. */
  server: boolean;
  manager: boolean;
  /** Kitchen staff authenticate KDS devices with the kitchen role. */
  kitchen: boolean;
};

/** Demo workspace password shared by every seeded login. Local demo only. */
export const DEMO_PASSWORD = 'ChaiChowk#2026';

/** Device secret for the second (expo) KDS this layer registers. Local demo only. */
export const DEMO_EXPO_KDS_SECRET = 'rdk_chai_chowk_demo_kds_expo';

const STAFF: readonly StaffSeed[] = [
  {
    key: 'ayesha',
    name: 'Ayesha Khan',
    title: 'Floor Manager',
    email: 'ayesha@chaichowk.pk',
    pin: '205060',
    server: false,
    manager: true,
    kitchen: false,
  },
  {
    key: 'bilal',
    name: 'Bilal Ahmed',
    title: 'Cashier',
    email: 'bilal@chaichowk.pk',
    pin: '310131',
    server: false,
    manager: false,
    kitchen: false,
  },
  {
    key: 'hina',
    name: 'Hina Raza',
    title: 'Server',
    email: 'hina@chaichowk.pk',
    pin: '445566',
    server: true,
    manager: false,
    kitchen: false,
  },
  {
    key: 'usman',
    name: 'Usman Tariq',
    title: 'Server',
    email: 'usman@chaichowk.pk',
    pin: '778899',
    server: true,
    manager: false,
    kitchen: false,
  },
  {
    key: 'kashif',
    name: 'Kashif Mehmood',
    title: 'Head Chef',
    email: 'kashif@chaichowk.pk',
    pin: '909090',
    server: false,
    manager: false,
    kitchen: true,
  },
];

const OWNER = {
  key: 'owner',
  name: 'Saad Ajmal',
  title: 'Owner',
  email: 'owner@chaichowk.pk',
};

/**
 * The two agency-workspace admins, mirrored into the restaurant organization.
 *
 * `users.organizationId` is a single NOT NULL column and there is no membership
 * join table, so a user belongs to exactly one organization and the product has
 * no cross-organization workspace switcher. The unique key is
 * (`organizationId`, `email`), so the same address can hold one row per
 * organization — that is the only way to let these two reach the restaurant
 * workspace without changing the schema. The agency rows are a different
 * `organizationId` and are never touched by this seed; these rows exist solely
 * under `org_chai_chowk` and carry DEMO_PASSWORD, not the operator-supplied
 * SEED_PASSWORD that the agency rows use.
 */
const GUEST_ADMINS: readonly { key: string; name: string; title: string; email: string }[] = [
  { key: 'alex', name: 'Alex Carter', title: 'Workspace Admin', email: 'alex@company.com' },
  { key: 'jordan', name: 'Jordan Lee', title: 'Workspace Admin', email: 'jordan@company.com' },
];

type CustomerSeed = {
  key: string;
  given: string;
  family: string;
  phone: string;
  email?: string;
  /** Opening loyalty adjustment, before trading history earns anything. */
  openingPoints: number;
};

const CUSTOMERS: readonly CustomerSeed[] = [
  {
    key: 'faisal',
    given: 'Faisal',
    family: 'Iqbal',
    phone: '+923004451122',
    email: 'faisal.iqbal@example.pk',
    openingPoints: 120,
  },
  {
    key: 'sana',
    given: 'Sana',
    family: 'Malik',
    phone: '+923218847733',
    email: 'sana.malik@example.pk',
    openingPoints: 60,
  },
  { key: 'imran', given: 'Imran', family: 'Sheikh', phone: '+923334419988', openingPoints: 0 },
  {
    key: 'zoya',
    given: 'Zoya',
    family: 'Hassan',
    phone: '+923451192244',
    email: 'zoya.hassan@example.pk',
    openingPoints: 240,
  },
  { key: 'adnan', given: 'Adnan', family: 'Qureshi', phone: '+923009983311', openingPoints: 30 },
  {
    key: 'mehwish',
    given: 'Mehwish',
    family: 'Butt',
    phone: '+923217746655',
    email: 'mehwish.butt@example.pk',
    openingPoints: 500,
  },
  { key: 'talha', given: 'Talha', family: 'Nawaz', phone: '+923335567788', openingPoints: 0 },
  {
    key: 'rabia',
    given: 'Rabia',
    family: 'Siddiqui',
    phone: '+923451134477',
    email: 'rabia.s@example.pk',
    openingPoints: 90,
  },
];

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

type UnitSeed = { key: string; name: string; abbreviation: string };
const UNITS: readonly UnitSeed[] = [
  { key: 'kg', name: 'Kilogram', abbreviation: 'kg' },
  { key: 'g', name: 'Gram', abbreviation: 'g' },
  { key: 'l', name: 'Litre', abbreviation: 'L' },
  { key: 'ml', name: 'Millilitre', abbreviation: 'ml' },
  { key: 'pc', name: 'Piece', abbreviation: 'pc' },
];

type IngredientSeed = {
  key: string;
  name: string;
  unit: string;
  cost: number;
  /** Quantity received across the demo window, in the canonical unit. */
  received: number;
  /** Quantity consumed by service across the demo window. */
  consumed: number;
  threshold: number;
};

const INGREDIENTS: readonly IngredientSeed[] = [
  {
    key: 'chicken',
    name: 'Chicken (boneless)',
    unit: 'kg',
    cost: 780,
    received: 120,
    consumed: 96.4,
    threshold: 20,
  },
  {
    key: 'beef',
    name: 'Beef (undercut)',
    unit: 'kg',
    cost: 1250,
    received: 60,
    consumed: 47.2,
    threshold: 10,
  },
  {
    key: 'mutton',
    name: 'Mutton (shoulder)',
    unit: 'kg',
    cost: 2100,
    received: 35,
    consumed: 31.8,
    threshold: 8,
  },
  {
    key: 'rice',
    name: 'Basmati Rice (Super Kernel)',
    unit: 'kg',
    cost: 320,
    received: 150,
    consumed: 118.5,
    threshold: 25,
  },
  {
    key: 'tea',
    name: 'Tea Leaves (Danedar)',
    unit: 'kg',
    cost: 1450,
    received: 18,
    consumed: 14.9,
    threshold: 4,
  },
  {
    key: 'milk',
    name: 'Fresh Milk',
    unit: 'l',
    cost: 210,
    received: 400,
    consumed: 372.5,
    threshold: 60,
  },
  {
    key: 'sugar',
    name: 'Sugar',
    unit: 'kg',
    cost: 175,
    received: 80,
    consumed: 61.2,
    threshold: 15,
  },
  {
    key: 'flour',
    name: 'Wheat Flour (Chakki Atta)',
    unit: 'kg',
    cost: 145,
    received: 200,
    consumed: 173.6,
    threshold: 30,
  },
  {
    key: 'yogurt',
    name: 'Yogurt',
    unit: 'kg',
    cost: 260,
    received: 90,
    consumed: 78.4,
    threshold: 15,
  },
  {
    key: 'tomato',
    name: 'Tomatoes',
    unit: 'kg',
    cost: 190,
    received: 110,
    consumed: 101.7,
    threshold: 20,
  },
  {
    key: 'onion',
    name: 'Onions',
    unit: 'kg',
    cost: 130,
    received: 130,
    consumed: 112.3,
    threshold: 20,
  },
  {
    key: 'oil',
    name: 'Cooking Oil',
    unit: 'l',
    cost: 590,
    received: 100,
    consumed: 88.6,
    threshold: 15,
  },
];

type SupplierSeed = { key: string; name: string; code: string; contact: string; phone: string };
const SUPPLIERS: readonly SupplierSeed[] = [
  {
    key: 'metro',
    name: 'Metro Cash & Carry — Thokar',
    code: 'SUP-001',
    contact: 'Waqas Alam',
    phone: '+924235550101',
  },
  {
    key: 'poultry',
    name: 'Al-Karam Poultry & Meat',
    code: 'SUP-002',
    contact: 'Nadeem Butt',
    phone: '+924235550202',
  },
  {
    key: 'mandi',
    name: 'Badami Bagh Sabzi Mandi Supplies',
    code: 'SUP-003',
    contact: 'Rashid Ali',
    phone: '+924235550303',
  },
];

// ---------------------------------------------------------------------------
// Deterministic id helpers
// ---------------------------------------------------------------------------

const id = {
  category: (key: string) => `demo_cat_${key}`,
  product: (key: string) => `demo_prod_${key}`,
  priceEntry: (key: string) => `demo_price_${key}`,
  menuSection: (key: string) => `demo_section_${key}`,
  menuItem: (key: string) => `demo_menuitem_${key}`,
  routing: (key: string) => `demo_route_${key}`,
  floor: (key: string) => `demo_floor_${key}`,
  table: (code: string) => `demo_table_${code.toLowerCase()}`,
  section: (key: string) => `demo_sect_${key}`,
  sectionTable: (section: string, code: string) => `demo_secttbl_${section}_${code.toLowerCase()}`,
  user: (key: string) => `demo_user_${key}`,
  staff: (key: string) => `demo_staff_${key}`,
  credential: (key: string) => `demo_cred_${key}`,
  assignment: (key: string) => `demo_assign_${key}`,
  customer: (key: string) => `demo_cust_${key}`,
  identifier: (key: string, kind: string) => `demo_ident_${key}_${kind.toLowerCase()}`,
  consent: (key: string, channel: string) => `demo_consent_${key}_${channel.toLowerCase()}`,
  loyaltyAccount: (key: string) => `demo_loyalty_acct_${key}`,
  loyaltyEntry: (suffix: string) => `demo_loyalty_entry_${suffix}`,
  drawer: (date: string) => `demo_drawer_${date}`,
  drawerMovement: (suffix: string) => `demo_drawermv_${suffix}`,
  order: (date: string, seq: number) => `demo_order_${date}_${seq}`,
  orderItem: (date: string, seq: number, index: number) => `demo_oi_${date}_${seq}_${index}`,
  orderTable: (date: string, seq: number) => `demo_ot_${date}_${seq}`,
  orderEvent: (date: string, seq: number, sequence: number) => `demo_oe_${date}_${seq}_${sequence}`,
  ticket: (date: string, seq: number, station: string) => `demo_kot_${date}_${seq}_${station}`,
  ticketItem: (date: string, seq: number, index: number) => `demo_koti_${date}_${seq}_${index}`,
  bill: (date: string, seq: number) => `demo_bill_${date}_${seq}`,
  billLine: (date: string, seq: number, index: number) => `demo_bl_${date}_${seq}_${index}`,
  payment: (date: string, seq: number) => `demo_pay_${date}_${seq}`,
  tender: (date: string, seq: number) => `demo_tender_${date}_${seq}`,
  orderSequence: (date: string) => `demo_orderseq_${date}`,
  receiptSequence: (date: string) => `demo_receiptseq_${date}`,
  dailyClose: (date: string) => `demo_close_${date}`,
  tenderTotal: (date: string, type: string) => `demo_closetender_${date}_${type.toLowerCase()}`,
  dailyRollup: (date: string) => `demo_rollup_${date}`,
  itemMix: (date: string, productKey: string) => `demo_mix_${date}_${productKey}`,
  liability: (date: string) => `demo_liability_${date}`,
  labour: (date: string) => `demo_labour_${date}`,
  unit: (key: string) => `demo_unit_${key}`,
  ingredient: (key: string) => `demo_ing_${key}`,
  stockItem: (key: string) => `demo_stock_${key}`,
  stockLocation: () => 'demo_stockloc_main',
  lowStock: (key: string) => `demo_lowstock_${key}`,
  movement: (suffix: string) => `demo_move_${suffix}`,
  supplier: (key: string) => `demo_supplier_${key}`,
  purchaseOrder: (key: string) => `demo_po_${key}`,
  purchaseOrderLine: (poKey: string, key: string) => `demo_pol_${poKey}_${key}`,
};

// Base fixture ids this layer builds on. Kept in one place so the coupling is
// visible rather than sprinkled through the writes below.
const BASE = {
  // Must match RESTAURANT_E2E.organizationId in seed-restaurant-e2e.ts, which
  // creates the organization this showcase layer decorates. (Not imported from
  // there: that module imports this one.)
  organizationId: 'org_chai_chowk',
  branchId: 'branch_restaurant_e2e',
  posDeviceId: 'device_restaurant_e2e_pos',
  kdsDeviceId: 'device_restaurant_e2e_kds',
  operatorStaffId: 'staff_restaurant_e2e_operator',
  managerStaffId: 'staff_restaurant_e2e_manager',
  managerRoleId: 'role_restaurant_e2e_manager',
  operatorRoleId: 'role_restaurant_e2e_operator',
  grillStationId: 'station_restaurant_e2e_grill',
  expoStationId: 'station_restaurant_e2e_expo',
  brandId: 'brand_restaurant_e2e',
  menuId: 'menu_restaurant_e2e',
  priceListId: 'price_list_restaurant_e2e',
  priceVersionId: 'price_version_restaurant_e2e_v1',
  publicationId: 'menu_publication_restaurant_e2e',
  loyaltyProgramId: 'loyalty_program_restaurant_e2e_v1',
} as const;

// WHA-278: `User.department` is a composite FK onto the tenant's department
// catalog, and a RESTAURANT organization has no LEADERSHIP department — its
// catalog is front of house and kitchen. Every demo user works the floor.
const DEMO_ADMIN_DEPARTMENT = adminDepartmentKeyForVertical('RESTAURANT');

const DEMO_ORG = {
  slug: 'chai-chowk',
  displayName: 'Chai Chowk Café',
  legalName: 'Chai Chowk Hospitality (Pvt) Ltd',
  branchName: 'Chai Chowk — Gulberg',
  timezone: 'Asia/Karachi',
  currency: 'PKR',
} as const;

/** Points per rupee spent, and rupee value of one point. */
const EARN_RATE = 0.01;
/** Version 2 of the loyalty program — the PKR-rated one this layer posts against. */
const DEMO_LOYALTY_PROGRAM_ID = 'demo_loyalty_program_v2';
const REDEMPTION_VALUE = 1;

// ---------------------------------------------------------------------------
// Order plan — derived, not random, so every run produces the same trading day
// ---------------------------------------------------------------------------

type PlannedItem = { productKey: string; quantity: number };
type PlannedOrder = {
  date: string;
  seq: number;
  channel: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  status: 'CLOSED' | 'SENT' | 'IN_PREPARATION' | 'READY';
  tableCode: string | null;
  customerKey: string | null;
  serverKey: string;
  coverCount: number | null;
  items: PlannedItem[];
  tenderType: 'CASH' | 'CARD';
  tipAmount: number;
  openHour: number;
};

const CHANNELS = ['DINE_IN', 'DINE_IN', 'TAKEAWAY', 'DINE_IN', 'DELIVERY'] as const;
const SERVER_KEYS = STAFF.filter((member) => member.server).map((member) => member.key);
const ORDERS_PER_DAY = 5;

function planItems(dayIndex: number, seq: number): PlannedItem[] {
  const count = 2 + ((dayIndex + seq) % 3); // 2..4 lines
  const items: PlannedItem[] = [];
  for (let line = 0; line < count; line += 1) {
    const product = PRODUCTS[(dayIndex * 7 + seq * 5 + line * 11) % PRODUCTS.length]!;
    const quantity = 1 + ((dayIndex + seq + line) % 3);
    const existing = items.find((item) => item.productKey === product.key);
    if (existing) existing.quantity += quantity;
    else items.push({ productKey: product.key, quantity });
  }
  return items;
}

function planDay(date: string, dayIndex: number, live: boolean): PlannedOrder[] {
  const orders: PlannedOrder[] = [];
  const count = live ? 4 : ORDERS_PER_DAY;
  for (let seq = 1; seq <= count; seq += 1) {
    const channel = CHANNELS[(dayIndex + seq) % CHANNELS.length]!;
    const table = channel === 'DINE_IN' ? TABLES[(dayIndex * 5 + seq) % TABLES.length]! : null;
    const hasCustomer = (dayIndex * 3 + seq) % 10 < 7;
    const customer = hasCustomer ? CUSTOMERS[(dayIndex * 3 + seq) % CUSTOMERS.length]! : null;
    const tenderType = (dayIndex + seq) % 3 === 0 ? 'CARD' : 'CASH';
    // Only the last three of the live day stay open, so the floor and KDS both
    // have something to show while the day still has a settled order behind it.
    const liveStatus = (['SENT', 'IN_PREPARATION', 'READY'] as const)[seq - 2];
    orders.push({
      date,
      seq,
      channel,
      status: live && seq >= 2 ? (liveStatus ?? 'SENT') : 'CLOSED',
      tableCode: table?.code ?? null,
      customerKey: customer?.key ?? null,
      serverKey: SERVER_KEYS[(dayIndex + seq) % SERVER_KEYS.length]!,
      coverCount: table ? Math.min(table.capacity, 1 + ((dayIndex + seq) % table.capacity)) : null,
      items: planItems(dayIndex, seq),
      tenderType,
      tipAmount: tenderType === 'CARD' && (dayIndex + seq) % 2 === 0 ? 100 : 0,
      openHour: 11 + seq * 2,
    });
  }
  return orders;
}

type PricedOrder = PlannedOrder & {
  lines: Array<{
    index: number;
    productKey: string;
    name: string;
    unitPrice: number;
    quantity: number;
    lineSubtotal: number;
    compAmount: number;
    lineTotal: number;
    station: 'grill' | 'expo';
  }>;
  subtotal: number;
  compTotal: number;
  grandTotal: number;
};

/**
 * Money is computed the way `src/lib/restaurant/bills.ts` computes it, because
 * the settlement guard reconciles against exactly that identity:
 *
 *   Σ non-void bills of (grandTotal + compTotal + discountTotal) ≡ Σ line subtotals
 *
 * Bills cut at this base carry no tax or service charge of their own, so the
 * menu price is the all-in price the guest pays — which is also how a Pakistani
 * café prints its card ("prices inclusive of all taxes"). Seeding a separate tax
 * component would have left every settled bill reporting TOTAL_MISMATCH.
 */
function priceOrder(order: PlannedOrder): PricedOrder {
  // One comped line on a slice of the orders, so the money screens show the comp
  // path (and the invariant holding across it) rather than a flat ledger.
  const compIndex = order.seq === 3 && /[25]$/.test(order.date) ? 0 : -1;

  const lines = order.items.map((item, index) => {
    const product = PRODUCT_BY_KEY.get(item.productKey)!;
    const lineSubtotal = product.price * item.quantity;
    // A single unit off the line, the way a manager actually comps a round —
    // not the whole line, which would read like a pricing fault on the report.
    const compAmount = index === compIndex ? product.price : 0;
    return {
      index,
      productKey: product.key,
      name: product.name,
      unitPrice: product.price,
      quantity: item.quantity,
      lineSubtotal,
      compAmount,
      lineTotal: lineSubtotal - compAmount,
      station: product.station,
    };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.lineSubtotal, 0);
  const compTotal = lines.reduce((sum, line) => sum + line.compAmount, 0);
  return { ...order, lines, subtotal, compTotal, grandTotal: subtotal - compTotal };
}

const ALL_ORDERS: PricedOrder[] = [
  ...HISTORY_DATES.flatMap((date, index) => planDay(date, index, false)),
  ...planDay(TODAY, HISTORY_DATES.length, true),
].map(priceOrder);

const CLOSED_ORDERS = ALL_ORDERS.filter((order) => order.status === 'CLOSED');

// ---------------------------------------------------------------------------
// Control-plane seeding: restaurant module catalog + package
// ---------------------------------------------------------------------------

type ModuleDefinition = { key: string; name: string; category: string; routePrefix: string };

/**
 * The ten commercial restaurant modules. The live instance was bootstrapped with
 * `prisma/seed.ts`, which only ships the Agency registry, so without these rows
 * every restaurant surface stays unentitled and the tour has nothing to open.
 * Values mirror `src/lib/vertical-catalog.ts` — this is the catalog's data, not
 * a second definition of it.
 */
const RESTAURANT_MODULE_ROWS: readonly ModuleDefinition[] = [
  { key: 'restaurant-core', name: 'Restaurant Core', category: 'Core', routePrefix: '/restaurant' },
  {
    key: 'restaurant-pos',
    name: 'POS and Fulfilment',
    category: 'Operations',
    routePrefix: '/restaurant/pos',
  },
  {
    key: 'restaurant-menu',
    name: 'Menu and Costing',
    category: 'Menu',
    routePrefix: '/restaurant/menu',
  },
  {
    key: 'restaurant-inventory',
    name: 'Inventory',
    category: 'Inventory',
    routePrefix: '/restaurant/inventory',
  },
  {
    key: 'restaurant-purchasing',
    name: 'Purchasing',
    category: 'Purchasing',
    routePrefix: '/restaurant/purchasing',
  },
  {
    key: 'restaurant-workforce',
    name: 'Restaurant Workforce',
    category: 'People',
    routePrefix: '/restaurant/workforce',
  },
  {
    key: 'restaurant-sop',
    name: 'SOP and Compliance',
    category: 'Compliance',
    routePrefix: '/restaurant/sop',
  },
  {
    key: 'restaurant-loyalty',
    name: 'Customers and Loyalty',
    category: 'Loyalty',
    routePrefix: '/restaurant/loyalty',
  },
  {
    key: 'restaurant-insights',
    name: 'Restaurant Insights',
    category: 'Insights',
    routePrefix: '/restaurant/insights',
  },
  {
    key: 'restaurant-integrations',
    name: 'Integrations and Devices',
    category: 'Integrations',
    routePrefix: '/restaurant/integrations',
  },
];

const DEMO_PACKAGE_KEY = 'restaurant-operations';
const DEMO_PACKAGE_LIMITS: Record<string, number> = {
  'restaurant.locations.max': 5,
  'restaurant.brands.max': 3,
  'pos.terminals.max': 10,
  'pos.registeredDevices.max': 25,
  'pos.orders.monthly': 50000,
  'pos.concurrentRegisters.max': 10,
  'restaurant.operators.max': 100,
  'inventory.stockLocations.max': 10,
  'sop.templates.max': 100,
  'sop.evidenceRetentionDays': 365,
  'loyalty.activeCustomers.max': 25000,
  'integrations.connections.max': 10,
  'restaurantInsights.retentionMonths': 24,
};

/**
 * Runs under the platform-admin RLS context. Registers the restaurant module
 * catalog and the Operations package, then stamps the demo organization with it
 * so entitlements resolve from the package the way a real tenant's would.
 */
export async function seedRestaurantDemoControlPlane(tx: Tx): Promise<void> {
  const moduleIds = new Map<string, string>();
  for (const [index, module] of RESTAURANT_MODULE_ROWS.entries()) {
    // `band` (and the owning vertical) are required registry facts since the
    // banded module catalog landed, and they are read from the catalog rather
    // than restated here for the same reason the rows above mirror it: this is
    // the catalog's data, not a second definition of it.
    const definition = moduleDefinitionForKey(module.key);
    if (!definition) throw new Error(`Unknown module key: ${module.key}`);
    const row = await tx.platformModule.upsert({
      where: { key: module.key },
      update: {
        name: module.name,
        category: module.category,
        routePrefix: module.routePrefix,
        active: true,
      },
      create: {
        id: `demo_module_${module.key}`,
        key: module.key,
        name: module.name,
        category: module.category,
        routePrefix: module.routePrefix,
        band: definition.band,
        vertical: definition.vertical,
        sortOrder: 100 + index,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    moduleIds.set(module.key, row.id);
  }

  const platformPackage = await tx.platformPackage.upsert({
    where: { key: DEMO_PACKAGE_KEY },
    update: { name: 'Restaurant Operations', vertical: 'RESTAURANT', active: true },
    create: {
      id: `demo_package_${DEMO_PACKAGE_KEY}`,
      key: DEMO_PACKAGE_KEY,
      name: 'Restaurant Operations',
      description:
        'Full-service restaurant operations: POS, menu, inventory, loyalty and insights.',
      vertical: 'RESTAURANT',
      defaultSeats: 25,
      createdAt: AT,
      updatedAt: AT,
    },
  });

  for (const module of RESTAURANT_MODULE_ROWS) {
    const moduleId = moduleIds.get(module.key)!;
    await tx.platformPackageModule.upsert({
      where: { packageId_moduleId: { packageId: platformPackage.id, moduleId } },
      update: { enabled: true },
      create: {
        id: `demo_pkgmod_${module.key}`,
        packageId: platformPackage.id,
        moduleId,
        enabled: true,
        limits: module.key === 'restaurant-core' ? DEMO_PACKAGE_LIMITS : undefined,
      },
    });
  }

  // Presentation + commercial stamping on the organization itself. The id and
  // vertical are the base fixture's; only the display surface and package move.
  await tx.organization.update({
    where: { id: BASE.organizationId },
    data: {
      slug: DEMO_ORG.slug,
      displayName: DEMO_ORG.displayName,
      legalName: DEMO_ORG.legalName,
      timezone: DEMO_ORG.timezone,
      currency: DEMO_ORG.currency,
      locale: 'en',
      seatLimit: 25,
      status: 'ACTIVE',
      activatedAt: AT,
      packageId: platformPackage.id,
      primaryContactName: OWNER.name,
      primaryContactEmail: OWNER.email,
      updatedAt: AT,
    },
  });
}

// ---------------------------------------------------------------------------
// Tenant-scoped seeding
// ---------------------------------------------------------------------------

/** Runs under the demo organization's tenant RLS context. */
export async function seedRestaurantDemoTenant(tx: Tx): Promise<Record<string, number>> {
  await dressBaseFixture(tx);
  await seedBranchAndFloor(tx);
  await seedPeople(tx);
  await seedCatalog(tx);
  await seedCustomersAndLoyalty(tx);
  await seedInventory(tx);
  await seedTrading(tx);
  await seedInsights(tx);
  return countSeeded();
}

/**
 * The base fixture's rows are named for CI ("Test Kitchen", "Test Burger",
 * "E2E Operator") and priced in dollars. Their ids are the Playwright contract
 * and stay exactly as they are; only the display surface and the one price move,
 * so the tour never opens on a screen that reads like a test harness.
 */
async function dressBaseFixture(tx: Tx): Promise<void> {
  await tx.restaurantCategory.update({
    where: { id: 'category_restaurant_e2e_mains' },
    data: { name: "Chef's Specials", sortOrder: 8, updatedAt: AT },
  });
  await tx.restaurantMenuSection.update({
    where: { id: 'menu_section_restaurant_e2e_mains' },
    data: { name: "Chef's Specials", sortOrder: 8, updatedAt: AT },
  });
  await tx.restaurantProduct.update({
    where: { id: 'product_restaurant_e2e_burger' },
    data: {
      name: 'Chowk Smash Burger',
      description: 'Double beef patty, house chutney mayo, sesame bun.',
      updatedAt: AT,
    },
  });
  await tx.restaurantPriceListEntry.update({
    where: { id: 'price_entry_restaurant_e2e_burger' },
    data: { price: money(950), updatedAt: AT },
  });

  await tx.restaurantRegisteredDevice.update({
    where: { id: BASE.posDeviceId },
    data: { name: 'Front Counter Register', updatedAt: AT },
  });
  await tx.restaurantRegisteredDevice.update({
    where: { id: BASE.kdsDeviceId },
    data: { name: 'Grill KDS', updatedAt: AT },
  });

  const baseStaff = [
    {
      staffId: BASE.operatorStaffId,
      userId: 'user_restaurant_e2e_operator',
      name: 'Nadia Aslam',
      title: 'Register Operator',
      email: 'nadia@chaichowk.pk',
    },
    {
      staffId: BASE.managerStaffId,
      userId: 'user_restaurant_e2e_manager',
      name: 'Imtiaz Warraich',
      title: 'General Manager',
      email: 'imtiaz@chaichowk.pk',
    },
  ];
  for (const member of baseStaff) {
    await tx.user.update({
      where: { id: member.userId },
      data: {
        name: member.name,
        email: member.email,
        title: member.title,
        password: hashSync(DEMO_PASSWORD, DEMO_SALT),
        updatedAt: AT,
      },
    });
    await tx.restaurantStaffProfile.update({
      where: { id: member.staffId },
      data: { displayName: member.name, email: member.email, updatedAt: AT },
    });
  }

  await tx.restaurantKitchenStation.update({
    where: { id: BASE.grillStationId },
    data: { name: 'Grill & Tandoor', updatedAt: AT },
  });
  await tx.restaurantKitchenStation.update({
    where: { id: BASE.expoStationId },
    data: { name: 'Expo & Cold Pass', updatedAt: AT },
  });
}

async function seedBranchAndFloor(tx: Tx): Promise<void> {
  await tx.restaurantBranch.update({
    where: { id: BASE.branchId },
    data: { name: DEMO_ORG.branchName, timezone: DEMO_ORG.timezone, updatedAt: AT },
  });

  for (const key of ['ground', 'terrace'] as const) {
    await tx.restaurantFloor.upsert({
      where: { id: id.floor(key) },
      update: {},
      create: {
        id: id.floor(key),
        branchId: BASE.branchId,
        name: key === 'ground' ? 'Ground Floor' : 'Rooftop Terrace',
        sortOrder: key === 'ground' ? 1 : 2,
        createdAt: AT,
        updatedAt: AT,
      },
    });
  }

  for (const key of ['a', 'b'] as const) {
    await tx.restaurantServerSection.upsert({
      where: { id: id.section(key) },
      update: {},
      create: {
        id: id.section(key),
        branchId: BASE.branchId,
        name: key === 'a' ? 'Section A — Front' : 'Section B — Garden & Terrace',
        createdAt: AT,
        updatedAt: AT,
      },
    });
  }

  for (const table of TABLES) {
    await tx.restaurantTable.upsert({
      where: { id: id.table(table.code) },
      update: {},
      create: {
        id: id.table(table.code),
        floorId: id.floor(table.floor),
        code: table.code,
        capacity: table.capacity,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantServerSectionTable.upsert({
      where: { id: id.sectionTable(table.section, table.code) },
      update: {},
      create: {
        id: id.sectionTable(table.section, table.code),
        sectionId: id.section(table.section),
        tableId: id.table(table.code),
        createdAt: AT,
        updatedAt: AT,
      },
    });
  }
}

async function seedPeople(tx: Tx): Promise<void> {
  const passwordHash = hashSync(DEMO_PASSWORD, DEMO_SALT);
  const kitchenRole = await tx.organizationRole.findUniqueOrThrow({
    where: {
      organizationId_key: { organizationId: BASE.organizationId, key: 'kitchen' },
    },
    select: { id: true },
  });

  // Workspace owner: an ADMIN login for the console tour, on the manager role
  // the base fixture already granted `*` to.
  await tx.user.upsert({
    where: { id: id.user(OWNER.key) },
    update: { password: passwordHash, name: OWNER.name, title: OWNER.title, updatedAt: AT },
    create: {
      id: id.user(OWNER.key),
      organizationRoleId: BASE.managerRoleId,
      name: OWNER.name,
      email: OWNER.email,
      password: passwordHash,
      role: 'ADMIN',
      department: DEMO_ADMIN_DEPARTMENT,
      title: OWNER.title,
      startDate: AT,
      createdAt: AT,
      updatedAt: AT,
    },
  });
  await tx.restaurantBranchAssignment.upsert({
    where: { branchId_userId: { branchId: BASE.branchId, userId: id.user(OWNER.key) } },
    update: {},
    create: {
      id: id.assignment(OWNER.key),
      branchId: BASE.branchId,
      userId: id.user(OWNER.key),
      createdAt: AT,
      updatedAt: AT,
    },
  });

  // Same shape as the owner above: ADMIN on the manager role, assigned to the
  // one branch so branch-scoped consoles resolve for them too.
  for (const guest of GUEST_ADMINS) {
    // Keyed on the tenant-unique email, not on this script's own id: the base
    // Chai Chowk fixture already mirrors alex@company.com under an id of its
    // own, so an id-keyed upsert would miss it and then collide on
    // (organizationId, email).
    const guestUser = await tx.user.upsert({
      where: {
        organizationId_email: { organizationId: BASE.organizationId, email: guest.email },
      },
      update: { password: passwordHash, name: guest.name, title: guest.title, updatedAt: AT },
      create: {
        id: id.user(guest.key),
        organizationRoleId: BASE.managerRoleId,
        name: guest.name,
        email: guest.email,
        password: passwordHash,
        role: 'ADMIN',
        department: DEMO_ADMIN_DEPARTMENT,
        title: guest.title,
        startDate: AT,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantBranchAssignment.upsert({
      where: { branchId_userId: { branchId: BASE.branchId, userId: guestUser.id } },
      update: {},
      create: {
        id: id.assignment(guest.key),
        branchId: BASE.branchId,
        userId: guestUser.id,
        createdAt: AT,
        updatedAt: AT,
      },
    });
  }

  for (const member of STAFF) {
    const organizationRoleId =
      member.kitchen
        ? kitchenRole.id
        : member.manager
          ? BASE.managerRoleId
          : BASE.operatorRoleId;
    await tx.user.upsert({
      where: { id: id.user(member.key) },
      update: {
        organizationRoleId,
        password: passwordHash,
        name: member.name,
        title: member.title,
        updatedAt: AT,
      },
      create: {
        id: id.user(member.key),
        organizationRoleId,
        name: member.name,
        email: member.email,
        password: passwordHash,
        role: 'EMPLOYEE',
        department: DEMO_ADMIN_DEPARTMENT,
        title: member.title,
        startDate: AT,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantBranchAssignment.upsert({
      where: { branchId_userId: { branchId: BASE.branchId, userId: id.user(member.key) } },
      update: {},
      create: {
        id: id.assignment(member.key),
        branchId: BASE.branchId,
        userId: id.user(member.key),
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantStaffProfile.upsert({
      where: { id: id.staff(member.key) },
      update: { displayName: member.name, updatedAt: AT },
      create: {
        id: id.staff(member.key),
        userId: id.user(member.key),
        email: member.email,
        displayName: member.name,
        primaryBranchId: BASE.branchId,
        status: 'ACTIVE',
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantOperatorCredential.upsert({
      where: { id: id.credential(member.key) },
      update: {},
      create: {
        id: id.credential(member.key),
        staffProfileId: id.staff(member.key),
        type: 'PIN',
        credentialHash: hashSync(member.pin, DEMO_SALT),
        createdAt: AT,
        updatedAt: AT,
      },
    });
  }

  // A second KDS so the expo pass has its own screen alongside the base grill.
  await tx.restaurantRegisteredDevice.upsert({
    where: { id: 'demo_device_kds_expo' },
    update: {},
    create: {
      id: 'demo_device_kds_expo',
      branchId: BASE.branchId,
      name: 'Expo KDS',
      kind: 'KDS',
      stationId: BASE.expoStationId,
      deviceSecretHash: createHash('sha256').update(DEMO_EXPO_KDS_SECRET).digest('hex'),
      createdAt: AT,
      updatedAt: AT,
    },
  });
}

async function seedCatalog(tx: Tx): Promise<void> {
  await tx.restaurantBrand.update({
    where: { id: BASE.brandId },
    data: { name: 'Chai Chowk', updatedAt: AT },
  });
  await tx.restaurantMenu.update({
    where: { id: BASE.menuId },
    data: { name: 'Chai Chowk All-Day Menu', updatedAt: AT },
  });
  await tx.restaurantPriceList.update({
    where: { id: BASE.priceListId },
    data: { name: 'Gulberg Dine-In Prices (PKR)', updatedAt: AT },
  });

  for (const category of CATEGORIES) {
    await tx.restaurantCategory.upsert({
      where: { id: id.category(category.key) },
      update: { name: category.name, sortOrder: category.sortOrder, updatedAt: AT },
      create: {
        id: id.category(category.key),
        name: category.name,
        sortOrder: category.sortOrder,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantMenuSection.upsert({
      where: { id: id.menuSection(category.key) },
      update: { name: category.name, sortOrder: category.sortOrder, updatedAt: AT },
      create: {
        id: id.menuSection(category.key),
        menuId: BASE.menuId,
        name: category.name,
        sortOrder: category.sortOrder,
        createdAt: AT,
        updatedAt: AT,
      },
    });
  }

  for (const [index, product] of PRODUCTS.entries()) {
    await tx.restaurantProduct.upsert({
      where: { id: id.product(product.key) },
      update: { name: product.name, description: product.description, updatedAt: AT },
      create: {
        id: id.product(product.key),
        categoryId: id.category(product.category),
        name: product.name,
        description: product.description,
        sortOrder: index + 1,
        status: 'ACTIVE',
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantPriceListEntry.upsert({
      where: { id: id.priceEntry(product.key) },
      update: { price: money(product.price), updatedAt: AT },
      create: {
        id: id.priceEntry(product.key),
        priceListVersionId: BASE.priceVersionId,
        productId: id.product(product.key),
        price: money(product.price),
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantMenuItem.upsert({
      where: { id: id.menuItem(product.key) },
      update: { sortOrder: index + 1, updatedAt: AT },
      create: {
        id: id.menuItem(product.key),
        sectionId: id.menuSection(product.category),
        productId: id.product(product.key),
        sortOrder: index + 1,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantStationRoutingRule.upsert({
      where: { id: id.routing(product.key) },
      update: {},
      create: {
        id: id.routing(product.key),
        stationId: product.station === 'grill' ? BASE.grillStationId : BASE.expoStationId,
        productId: id.product(product.key),
        priority: 100 + index,
        createdAt: AT,
        updatedAt: AT,
      },
    });
  }
}

async function seedCustomersAndLoyalty(tx: Tx): Promise<void> {
  // Re-rate the program for PKR: 1 point per PKR 100 spent, 1 point = PKR 1.
  // The base fixture's placeholder (1 point per rupee, worth PKR 0.01 each)
  // would show six-figure balances against rupee tickets.
  //
  // The base version cannot be edited in place — `restaurant_loyalty_program_
  // versions` carries an immutability trigger once `effectiveFrom` has passed,
  // which is exactly right for a ledger's rate table. So the demo supersedes it
  // with version 2, effective one second later, and every entry this layer posts
  // references that. Created only when absent, because the same trigger blocks
  // the UPDATE half of an upsert on a re-run.
  const existingProgram = await tx.loyaltyProgramVersion.findUnique({
    where: { id: DEMO_LOYALTY_PROGRAM_ID },
    select: { id: true },
  });
  if (!existingProgram) {
    await tx.loyaltyProgramVersion.create({
      data: {
        id: DEMO_LOYALTY_PROGRAM_ID,
        versionNumber: 2,
        effectiveFrom: new Date('2026-08-27T00:00:01.000Z'),
        earnRate: EARN_RATE.toFixed(6),
        redemptionValue: REDEMPTION_VALUE.toFixed(6),
        expiryDays: 365,
        createdAt: AT,
        updatedAt: AT,
      },
    });
  }
  await tx.restaurantCustomer.update({
    where: { id: 'customer_restaurant_e2e' },
    data: { displayName: 'Walk-in Guest', updatedAt: AT },
  });

  for (const customer of CUSTOMERS) {
    await tx.restaurantCustomer.upsert({
      where: { id: id.customer(customer.key) },
      update: { updatedAt: AT },
      create: {
        id: id.customer(customer.key),
        displayName: `${customer.given} ${customer.family}`,
        givenName: customer.given,
        familyName: customer.family,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.customerIdentifier.upsert({
      where: { id: id.identifier(customer.key, 'PHONE') },
      update: {},
      create: {
        id: id.identifier(customer.key, 'PHONE'),
        customerId: id.customer(customer.key),
        kind: 'PHONE',
        normalizedValue: customer.phone,
        verifiedAt: AT,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    if (customer.email) {
      await tx.customerIdentifier.upsert({
        where: { id: id.identifier(customer.key, 'EMAIL') },
        update: {},
        create: {
          id: id.identifier(customer.key, 'EMAIL'),
          customerId: id.customer(customer.key),
          kind: 'EMAIL',
          normalizedValue: customer.email,
          createdAt: AT,
          updatedAt: AT,
        },
      });
    }
    // Marketing consent: granted for the contactable majority, refused for two
    // so the consent surface shows both states.
    const granted = !['imran', 'talha'].includes(customer.key);
    for (const channel of ['SMS', 'WHATSAPP'] as const) {
      await tx.customerConsent.upsert({
        where: { id: id.consent(customer.key, channel) },
        update: {},
        create: {
          id: id.consent(customer.key, channel),
          customerId: id.customer(customer.key),
          channel,
          granted,
          source: 'IN_STORE_SIGNUP',
          actorId: BASE.managerStaffId,
          policyVersion: 'privacy-2026-06',
          occurredAt: AT,
          idempotencyKey: `demo-consent-${customer.key}-${channel.toLowerCase()}`,
          createdAt: AT,
        },
      });
    }
    await tx.loyaltyAccount.upsert({
      where: { id: id.loyaltyAccount(customer.key) },
      update: {},
      create: {
        id: id.loyaltyAccount(customer.key),
        customerId: id.customer(customer.key),
        enrolledAt: AT,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    if (customer.openingPoints > 0) {
      await tx.loyaltyPointsEntry.upsert({
        where: { id: id.loyaltyEntry(`opening_${customer.key}`) },
        update: {},
        create: {
          id: id.loyaltyEntry(`opening_${customer.key}`),
          accountId: id.loyaltyAccount(customer.key),
          programVersionId: DEMO_LOYALTY_PROGRAM_ID,
          kind: 'ADJUSTMENT',
          points: customer.openingPoints,
          actorId: BASE.managerStaffId,
          reason: 'Loyalty balance migrated from the punch-card scheme',
          occurredAt: new Date('2026-08-20T09:00:00.000Z'),
          idempotencyKey: `demo-loyalty-opening-${customer.key}`,
          createdAt: AT,
        },
      });
    }
  }
}

async function seedInventory(tx: Tx): Promise<void> {
  for (const unit of UNITS) {
    await tx.restaurantUnit.upsert({
      where: { id: id.unit(unit.key) },
      update: {},
      create: {
        id: id.unit(unit.key),
        name: unit.name,
        abbreviation: unit.abbreviation,
        createdAt: AT,
        updatedAt: AT,
      },
    });
  }

  await tx.restaurantStockLocation.upsert({
    where: { id: id.stockLocation() },
    update: {},
    create: {
      id: id.stockLocation(),
      branchId: BASE.branchId,
      name: 'Gulberg Main Store',
      code: 'STORE-01',
      createdAt: AT,
      updatedAt: AT,
    },
  });

  for (const supplier of SUPPLIERS) {
    await tx.restaurantSupplier.upsert({
      where: { id: id.supplier(supplier.key) },
      update: {},
      create: {
        id: id.supplier(supplier.key),
        name: supplier.name,
        code: supplier.code,
        contactName: supplier.contact,
        contactPhone: supplier.phone,
        createdAt: AT,
        updatedAt: AT,
      },
    });
  }

  for (const ingredient of INGREDIENTS) {
    await tx.restaurantIngredient.upsert({
      where: { id: id.ingredient(ingredient.key) },
      update: { referenceCost: ingredient.cost.toFixed(4), updatedAt: AT },
      create: {
        id: id.ingredient(ingredient.key),
        name: ingredient.name,
        baseUnitId: id.unit(ingredient.unit),
        referenceCost: ingredient.cost.toFixed(4),
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantStockItem.upsert({
      where: { id: id.stockItem(ingredient.key) },
      update: {},
      create: {
        id: id.stockItem(ingredient.key),
        ingredientId: id.ingredient(ingredient.key),
        canonicalUnitId: id.unit(ingredient.unit),
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantLowStockRule.upsert({
      where: { id: id.lowStock(ingredient.key) },
      update: { threshold: ingredient.threshold.toFixed(6), updatedAt: AT },
      create: {
        id: id.lowStock(ingredient.key),
        stockItemId: id.stockItem(ingredient.key),
        locationId: id.stockLocation(),
        threshold: ingredient.threshold.toFixed(6),
        createdAt: AT,
        updatedAt: AT,
      },
    });

    // Two goods-in movements and one service-consumption movement per item, so
    // on-hand is a ledger result rather than a stored number.
    const firstReceipt = ingredient.received * 0.6;
    const secondReceipt = ingredient.received - firstReceipt;
    await tx.restaurantStockMovement.upsert({
      where: { id: id.movement(`in1_${ingredient.key}`) },
      update: {},
      create: {
        id: id.movement(`in1_${ingredient.key}`),
        stockItemId: id.stockItem(ingredient.key),
        locationId: id.stockLocation(),
        reason: 'PURCHASE_RECEIPT',
        quantity: firstReceipt.toFixed(6),
        unitCost: ingredient.cost.toFixed(6),
        occurredAt: at('2026-08-20', 8),
        recordedAt: at('2026-08-20', 8),
        staffProfileId: BASE.managerStaffId,
      },
    });
    await tx.restaurantStockMovement.upsert({
      where: { id: id.movement(`in2_${ingredient.key}`) },
      update: {},
      create: {
        id: id.movement(`in2_${ingredient.key}`),
        stockItemId: id.stockItem(ingredient.key),
        locationId: id.stockLocation(),
        reason: 'PURCHASE_RECEIPT',
        quantity: secondReceipt.toFixed(6),
        // A modest cost rise between deliveries, so weighted-average cost is not
        // trivially equal to the reference cost.
        unitCost: (ingredient.cost * 1.05).toFixed(6),
        occurredAt: at('2026-08-24', 8),
        recordedAt: at('2026-08-24', 8),
        staffProfileId: BASE.managerStaffId,
      },
    });
    await tx.restaurantStockMovement.upsert({
      where: { id: id.movement(`out_${ingredient.key}`) },
      update: {},
      create: {
        id: id.movement(`out_${ingredient.key}`),
        stockItemId: id.stockItem(ingredient.key),
        locationId: id.stockLocation(),
        reason: 'RECIPE_CONSUMPTION',
        quantity: (-ingredient.consumed).toFixed(6),
        occurredAt: at('2026-08-26', 23),
        recordedAt: at('2026-08-26', 23),
        staffProfileId: BASE.operatorStaffId,
      },
    });
  }

  // One approved purchase order per supplier grouping, so the purchasing console
  // opens on real documents.
  const poPlan = [
    {
      key: 'metro',
      supplier: 'metro',
      items: ['rice', 'sugar', 'flour', 'oil'],
      status: 'RECEIVED' as const,
    },
    {
      key: 'poultry',
      supplier: 'poultry',
      items: ['chicken', 'beef', 'mutton'],
      status: 'APPROVED' as const,
    },
    { key: 'mandi', supplier: 'mandi', items: ['tomato', 'onion'], status: 'SUBMITTED' as const },
  ];
  for (const po of poPlan) {
    await tx.restaurantPurchaseOrder.upsert({
      where: { id: id.purchaseOrder(po.key) },
      update: {},
      create: {
        id: id.purchaseOrder(po.key),
        supplierId: id.supplier(po.supplier),
        branchId: BASE.branchId,
        locationId: id.stockLocation(),
        status: po.status,
        reference: `PO-2026-${po.key.toUpperCase().slice(0, 3)}`,
        expectedDate: day('2026-08-28'),
        submittedAt: at('2026-08-25', 10),
        approvedAt: po.status === 'SUBMITTED' ? null : at('2026-08-25', 12),
        closedAt: po.status === 'RECEIVED' ? at('2026-08-26', 9) : null,
        createdByStaffProfileId: BASE.managerStaffId,
        approvedByStaffProfileId: po.status === 'SUBMITTED' ? null : BASE.managerStaffId,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    for (const itemKey of po.items) {
      const ingredient = INGREDIENTS.find((entry) => entry.key === itemKey)!;
      await tx.restaurantPurchaseOrderLine.upsert({
        where: { id: id.purchaseOrderLine(po.key, itemKey) },
        update: {},
        create: {
          id: id.purchaseOrderLine(po.key, itemKey),
          purchaseOrderId: id.purchaseOrder(po.key),
          stockItemId: id.stockItem(itemKey),
          orderedQuantity: (ingredient.threshold * 3).toFixed(6),
          unitId: id.unit(ingredient.unit),
          unitCost: ingredient.cost.toFixed(6),
          createdAt: AT,
          updatedAt: AT,
        },
      });
    }
  }
}

async function seedTrading(tx: Tx): Promise<void> {
  const dates = [...HISTORY_DATES, TODAY];

  for (const date of dates) {
    const dayOrders = ALL_ORDERS.filter((order) => order.date === date);
    const closed = dayOrders.filter((order) => order.status === 'CLOSED');
    const isToday = date === TODAY;

    await tx.restaurantOrderNumberSequence.upsert({
      where: { branchId_businessDate: { branchId: BASE.branchId, businessDate: day(date) } },
      update: {},
      create: {
        id: id.orderSequence(date),
        branchId: BASE.branchId,
        businessDate: day(date),
        nextNumber: dayOrders.length + 1,
        createdAt: AT,
        updatedAt: AT,
      },
    });
    await tx.restaurantReceiptNumberSequence.upsert({
      where: { branchId_businessDate: { branchId: BASE.branchId, businessDate: day(date) } },
      update: {},
      create: {
        id: id.receiptSequence(date),
        branchId: BASE.branchId,
        businessDate: day(date),
        nextNumber: closed.length + 1,
        createdAt: AT,
        updatedAt: AT,
      },
    });

    const cashTotal = closed
      .filter((order) => order.tenderType === 'CASH')
      .reduce((sum, order) => sum + order.grandTotal, 0);
    const openingFloat = 5000;

    // The live day's drawer is the base fixture's own open drawer; history gets
    // its own closed session per date.
    if (!isToday) {
      await tx.restaurantDrawerSession.upsert({
        where: { id: id.drawer(date) },
        update: {},
        create: {
          id: id.drawer(date),
          branchId: BASE.branchId,
          deviceId: BASE.posDeviceId,
          staffProfileId: id.staff('bilal'),
          businessDate: day(date),
          status: 'CLOSED',
          openedAt: at(date, 10),
          closedAt: at(date, 23, 30),
          openingFloat: money(openingFloat),
          expectedCash: money(openingFloat + cashTotal),
          countedCash: money(openingFloat + cashTotal),
          variance: money(0),
          createdAt: AT,
          updatedAt: AT,
        },
      });
      await tx.restaurantDrawerMovement.upsert({
        where: { id: id.drawerMovement(`open_${date}`) },
        update: {},
        create: {
          id: id.drawerMovement(`open_${date}`),
          drawerSessionId: id.drawer(date),
          kind: 'OPENING_FLOAT',
          amount: money(openingFloat),
          reason: 'Shift opening float',
          staffProfileId: id.staff('bilal'),
          deviceId: BASE.posDeviceId,
          createdAt: at(date, 10),
        },
      });
    }

    for (const order of dayOrders) {
      await seedOrder(tx, order, isToday ? null : id.drawer(date));
    }

    if (!isToday) {
      await tx.restaurantDrawerMovement.upsert({
        where: { id: id.drawerMovement(`close_${date}`) },
        update: {},
        create: {
          id: id.drawerMovement(`close_${date}`),
          drawerSessionId: id.drawer(date),
          kind: 'CLOSING_COUNT',
          amount: money(openingFloat + cashTotal),
          reason: 'End-of-day count',
          staffProfileId: id.staff('bilal'),
          deviceId: BASE.posDeviceId,
          createdAt: at(date, 23, 30),
        },
      });
      await seedDailyClose(tx, date, closed);
    }
  }
}

async function seedOrder(
  tx: Tx,
  order: PricedOrder,
  drawerSessionId: string | null
): Promise<void> {
  const orderId = id.order(order.date, order.seq);
  const closed = order.status === 'CLOSED';
  const openedAt = at(order.date, order.openHour);
  const closedAt = at(order.date, order.openHour + 1);

  await tx.restaurantOrder.upsert({
    where: { id: orderId },
    update: {},
    create: {
      id: orderId,
      branchId: BASE.branchId,
      orderNumber: order.seq,
      businessDate: day(order.date),
      status: order.status,
      channel: order.channel,
      coverCount: order.coverCount,
      sectionId: order.tableCode
        ? id.section(TABLES.find((table) => table.code === order.tableCode)!.section)
        : null,
      serverStaffProfileId: id.staff(order.serverKey),
      staffProfileId: BASE.operatorStaffId,
      deviceId: BASE.posDeviceId,
      publicationId: BASE.publicationId,
      priceListVersionId: BASE.priceVersionId,
      customerId: order.customerKey ? id.customer(order.customerKey) : null,
      openedAt,
      closedAt: closed ? closedAt : null,
      createdAt: openedAt,
      updatedAt: closed ? closedAt : openedAt,
    },
  });

  if (order.tableCode) {
    await tx.restaurantOrderTable.upsert({
      where: { id: id.orderTable(order.date, order.seq) },
      update: {},
      create: {
        id: id.orderTable(order.date, order.seq),
        orderId,
        tableId: id.table(order.tableCode),
        active: !closed,
        linkReason: 'SEATED',
        linkedAt: openedAt,
        unlinkedAt: closed ? closedAt : null,
        createdAt: openedAt,
        updatedAt: closed ? closedAt : openedAt,
      },
    });
  }

  const itemStatus =
    order.status === 'CLOSED'
      ? 'SERVED'
      : order.status === 'SENT'
        ? 'QUEUED'
        : order.status === 'IN_PREPARATION'
          ? 'FIRING'
          : 'PREPARED';

  for (const line of order.lines) {
    await tx.restaurantOrderItem.upsert({
      where: { id: id.orderItem(order.date, order.seq, line.index) },
      update: {},
      create: {
        id: id.orderItem(order.date, order.seq, line.index),
        orderId,
        course: line.index < 2 ? 1 : 2,
        productId: id.product(line.productKey),
        name: line.name,
        unitPrice: money(line.unitPrice),
        quantity: line.quantity,
        status: itemStatus,
        createdAt: openedAt,
        updatedAt: openedAt,
      },
    });
  }

  // Kitchen tickets, one per station the order actually touches.
  for (const station of ['grill', 'expo'] as const) {
    const stationLines = order.lines.filter((line) => line.station === station);
    if (stationLines.length === 0) continue;
    const ticketId = id.ticket(order.date, order.seq, station);
    await tx.restaurantKitchenTicket.upsert({
      where: { id: ticketId },
      update: {},
      create: {
        id: ticketId,
        orderId,
        stationId: station === 'grill' ? BASE.grillStationId : BASE.expoStationId,
        businessDate: day(order.date),
        // Distinct per station and date; the order sequence is already unique
        // within the day, and the two stations never share a ticket number.
        ticketNumber: order.seq,
        createdAt: openedAt,
        updatedAt: openedAt,
      },
    });
    for (const line of stationLines) {
      await tx.restaurantKitchenTicketItem.upsert({
        where: { id: id.ticketItem(order.date, order.seq, line.index) },
        update: {},
        create: {
          id: id.ticketItem(order.date, order.seq, line.index),
          ticketId,
          orderItemId: id.orderItem(order.date, order.seq, line.index),
          quantity: line.quantity,
          createdAt: openedAt,
        },
      });
    }
  }

  const events: Array<{ sequence: number; eventType: string; at: Date }> = [
    { sequence: 1, eventType: 'ORDER_OPENED', at: openedAt },
    { sequence: 2, eventType: 'ITEMS_FIRED', at: at(order.date, order.openHour, 6) },
  ];
  if (closed) {
    events.push({ sequence: 3, eventType: 'ORDER_SERVED', at: at(order.date, order.openHour, 35) });
    events.push({ sequence: 4, eventType: 'ORDER_CLOSED', at: closedAt });
  }
  for (const event of events) {
    await tx.restaurantOrderEvent.upsert({
      where: { id: id.orderEvent(order.date, order.seq, event.sequence) },
      update: {},
      create: {
        id: id.orderEvent(order.date, order.seq, event.sequence),
        orderId,
        sequence: event.sequence,
        eventType: event.eventType,
        actorStaffProfileId: BASE.operatorStaffId,
        actorDeviceId: BASE.posDeviceId,
        payload: { channel: order.channel, table: order.tableCode },
        createdAt: event.at,
      },
    });
  }

  if (!closed) return;

  const billId = id.bill(order.date, order.seq);
  await tx.restaurantBill.upsert({
    where: { id: billId },
    update: {},
    create: {
      id: billId,
      orderId,
      branchId: BASE.branchId,
      businessDate: day(order.date),
      status: 'SETTLED',
      splitKind: 'NONE',
      subtotal: money(order.subtotal),
      compTotal: money(order.compTotal),
      grandTotal: money(order.grandTotal),
      receiptNumber: order.seq,
      settledAt: closedAt,
      openerStaffProfileId: id.staff('bilal'),
      deviceId: BASE.posDeviceId,
      createdAt: openedAt,
      updatedAt: closedAt,
    },
  });

  for (const line of order.lines) {
    await tx.restaurantBillLine.upsert({
      where: { id: id.billLine(order.date, order.seq, line.index) },
      update: {},
      create: {
        id: id.billLine(order.date, order.seq, line.index),
        billId,
        orderItemId: id.orderItem(order.date, order.seq, line.index),
        name: line.name,
        quantity: line.quantity,
        unitPrice: money(line.unitPrice),
        lineSubtotal: money(line.lineSubtotal),
        compAmount: money(line.compAmount),
        compReason: line.compAmount > 0 ? 'Manager comp — regular guest' : null,
        lineTotal: money(line.lineTotal),
        createdAt: closedAt,
        updatedAt: closedAt,
      },
    });
  }

  let paymentId: string | null = null;
  if (order.tenderType === 'CARD') {
    paymentId = id.payment(order.date, order.seq);
    await tx.restaurantPayment.upsert({
      where: { id: paymentId },
      update: {},
      create: {
        id: paymentId,
        billId,
        provider: 'MOCK',
        capability: 'SALE',
        status: 'CAPTURED',
        amount: money(order.grandTotal),
        tipAmount: money(order.tipAmount),
        providerRef: `MOCK-${order.date.replace(/-/g, '')}-${order.seq}`,
        staffProfileId: id.staff('bilal'),
        deviceId: BASE.posDeviceId,
        createdAt: closedAt,
        updatedAt: closedAt,
      },
    });
  }

  const cashReceived = Math.ceil(order.grandTotal / 100) * 100;
  await tx.restaurantTender.upsert({
    where: { id: id.tender(order.date, order.seq) },
    update: {},
    create: {
      id: id.tender(order.date, order.seq),
      billId,
      type: order.tenderType,
      amount: money(order.grandTotal),
      tipAmount: money(order.tipAmount),
      cashReceived: order.tenderType === 'CASH' ? money(cashReceived) : null,
      changeGiven: order.tenderType === 'CASH' ? money(cashReceived - order.grandTotal) : null,
      drawerSessionId,
      paymentId,
      businessDate: day(order.date),
      staffProfileId: id.staff('bilal'),
      deviceId: BASE.posDeviceId,
      createdAt: closedAt,
    },
  });

  if (order.tenderType === 'CASH' && drawerSessionId) {
    await tx.restaurantDrawerMovement.upsert({
      where: { id: id.drawerMovement(`sale_${order.date}_${order.seq}`) },
      update: {},
      create: {
        id: id.drawerMovement(`sale_${order.date}_${order.seq}`),
        drawerSessionId,
        kind: 'CASH_SALE',
        amount: money(order.grandTotal),
        tenderId: id.tender(order.date, order.seq),
        staffProfileId: id.staff('bilal'),
        deviceId: BASE.posDeviceId,
        createdAt: closedAt,
      },
    });
  }

  if (order.customerKey) {
    await tx.customerInteraction.upsert({
      where: { id: `demo_interaction_${order.date}_${order.seq}` },
      update: {},
      create: {
        id: `demo_interaction_${order.date}_${order.seq}`,
        customerId: id.customer(order.customerKey),
        branchId: BASE.branchId,
        orderId,
        type: 'VISIT',
        payload: { channel: order.channel, grandTotal: money(order.grandTotal) },
        occurredAt: closedAt,
        idempotencyKey: `demo-visit-${order.date}-${order.seq}`,
        createdAt: closedAt,
      },
    });
    const points = Math.floor(order.grandTotal * EARN_RATE);
    if (points > 0) {
      await tx.loyaltyPointsEntry.upsert({
        where: { id: id.loyaltyEntry(`earn_${order.date}_${order.seq}`) },
        update: {},
        create: {
          id: id.loyaltyEntry(`earn_${order.date}_${order.seq}`),
          accountId: id.loyaltyAccount(order.customerKey),
          programVersionId: DEMO_LOYALTY_PROGRAM_ID,
          kind: 'EARN',
          points,
          billId,
          occurredAt: closedAt,
          idempotencyKey: `demo-earn-${order.date}-${order.seq}`,
          createdAt: closedAt,
        },
      });
    }
  }
}

async function seedDailyClose(tx: Tx, date: string, closed: PricedOrder[]): Promise<void> {
  const grossSales = closed.reduce((sum, order) => sum + order.subtotal, 0);
  const compTotal = closed.reduce((sum, order) => sum + order.compTotal, 0);
  const tipTotal = closed.reduce((sum, order) => sum + order.tipAmount, 0);
  const cashSales = closed
    .filter((order) => order.tenderType === 'CASH')
    .reduce((sum, order) => sum + order.grandTotal, 0);
  const openingFloat = 5000;

  await tx.restaurantDailyClose.upsert({
    where: { id: id.dailyClose(date) },
    update: {},
    create: {
      id: id.dailyClose(date),
      branchId: BASE.branchId,
      businessDate: day(date),
      cutByStaffProfileId: BASE.managerStaffId,
      deviceId: BASE.posDeviceId,
      grossSales: money(grossSales),
      netSales: money(grossSales - compTotal),
      compTotal: money(compTotal),
      tipTotal: money(tipTotal),
      cashExpected: money(openingFloat + cashSales),
      cashCounted: money(openingFloat + cashSales),
      cashVariance: money(0),
      createdAt: at(date, 23, 45),
    },
  });

  for (const type of ['CASH', 'CARD'] as const) {
    const forType = closed.filter((order) => order.tenderType === type);
    await tx.restaurantDailyCloseTenderTotal.upsert({
      where: { id: id.tenderTotal(date, type) },
      update: {},
      create: {
        id: id.tenderTotal(date, type),
        dailyCloseId: id.dailyClose(date),
        tenderType: type,
        amount: money(forType.reduce((sum, order) => sum + order.grandTotal, 0)),
        tipAmount: money(forType.reduce((sum, order) => sum + order.tipAmount, 0)),
        count: forType.length,
        createdAt: at(date, 23, 45),
      },
    });
  }
}

async function seedInsights(tx: Tx): Promise<void> {
  // Loyalty liability accumulates across the window: every day's cutoff sees all
  // entries posted up to and including that day.
  let runningPoints = CUSTOMERS.reduce((sum, customer) => sum + customer.openingPoints, 0);

  for (const date of HISTORY_DATES) {
    const closed = CLOSED_ORDERS.filter((order) => order.date === date);
    const grossSales = closed.reduce((sum, order) => sum + order.subtotal, 0);
    const compTotal = closed.reduce((sum, order) => sum + order.compTotal, 0);
    const coverCount = closed.reduce((sum, order) => sum + (order.coverCount ?? 1), 0);

    await tx.insightDailyRollup.upsert({
      where: { id: id.dailyRollup(date) },
      update: {},
      create: {
        id: id.dailyRollup(date),
        branchId: BASE.branchId,
        businessDate: day(date),
        sourceDailyCloseId: id.dailyClose(date),
        orderCount: closed.length,
        coverCount,
        grossSales: money(grossSales),
        netSales: money(grossSales - compTotal),
        compTotal: money(compTotal),
        computedAt: at(date, 23, 55),
        createdAt: AT,
        updatedAt: AT,
      },
    });

    const mix = new Map<string, { quantity: number; sales: number; comp: number }>();
    for (const order of closed) {
      for (const line of order.lines) {
        const current = mix.get(line.productKey) ?? { quantity: 0, sales: 0, comp: 0 };
        current.quantity += line.quantity;
        current.sales += line.lineSubtotal;
        current.comp += line.compAmount;
        mix.set(line.productKey, current);
      }
    }
    for (const [productKey, totals] of mix) {
      await tx.insightItemMixRollup.upsert({
        where: { id: id.itemMix(date, productKey) },
        update: {},
        create: {
          id: id.itemMix(date, productKey),
          branchId: BASE.branchId,
          businessDate: day(date),
          productId: id.product(productKey),
          sourceDailyCloseId: id.dailyClose(date),
          quantity: totals.quantity,
          grossSales: money(totals.sales),
          netSales: money(totals.sales - totals.comp),
          compTotal: money(totals.comp),
          computedAt: at(date, 23, 55),
          createdAt: AT,
          updatedAt: AT,
        },
      });
    }

    runningPoints += closed
      .filter((order) => order.customerKey)
      .reduce((sum, order) => sum + Math.floor(order.grandTotal * EARN_RATE), 0);

    await tx.insightLoyaltyLiability.upsert({
      where: { id: id.liability(date) },
      update: {},
      create: {
        id: id.liability(date),
        businessDate: day(date),
        cutoffAt: at(date, 23, 59),
        programVersionId: DEMO_LOYALTY_PROGRAM_ID,
        redemptionValue: REDEMPTION_VALUE.toFixed(6),
        positivePoints: BigInt(runningPoints),
        signedPoints: BigInt(runningPoints),
        liability: money(runningPoints * REDEMPTION_VALUE),
        computedAt: at(date, 23, 55),
        createdAt: AT,
        updatedAt: AT,
      },
    });

    // Labour is imported from the (out-of-scope) rota system; a fixed two-shift
    // day at the Punjab minimum wage keeps the labour-cost panel populated.
    await tx.labourCostFact.upsert({
      where: { id: id.labour(date) },
      update: {},
      create: {
        id: id.labour(date),
        branchId: BASE.branchId,
        businessDate: day(date),
        labourHours: money(96),
        labourCost: money(28800),
        source: 'DEMO_ROTA_IMPORT',
        idempotencyKey: `demo-labour-${date}`,
        importedAt: at(date, 23, 50),
        createdAt: AT,
      },
    });
  }
}

function countSeeded(): Record<string, number> {
  return {
    categories: CATEGORIES.length,
    products: PRODUCTS.length,
    menuItems: PRODUCTS.length,
    priceEntries: PRODUCTS.length,
    floors: 2,
    tables: TABLES.length,
    serverSections: 2,
    staffProfiles: STAFF.length,
    logins: STAFF.length + 1 + GUEST_ADMINS.length,
    customers: CUSTOMERS.length,
    loyaltyAccounts: CUSTOMERS.length,
    orders: ALL_ORDERS.length,
    closedOrders: CLOSED_ORDERS.length,
    openOrders: ALL_ORDERS.length - CLOSED_ORDERS.length,
    orderItems: ALL_ORDERS.reduce((sum, order) => sum + order.lines.length, 0),
    bills: CLOSED_ORDERS.length,
    dailyCloses: HISTORY_DATES.length,
    insightDailyRollups: HISTORY_DATES.length,
    stockItems: INGREDIENTS.length,
    suppliers: SUPPLIERS.length,
    purchaseOrders: 3,
  };
}

export const DEMO_SUMMARY = {
  organization: DEMO_ORG,
  owner: { ...OWNER, password: DEMO_PASSWORD },
  guestAdmins: GUEST_ADMINS.map((guest) => ({ ...guest, password: DEMO_PASSWORD })),
  staff: STAFF,
  historyDates: HISTORY_DATES,
  today: TODAY,
};
