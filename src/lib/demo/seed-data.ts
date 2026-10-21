import type { DemoSeatIdentity } from '@/lib/platform/command-types';
export type { DemoSeatIdentity } from '@/lib/platform/command-types';

import { resolveBusinessDate } from '@/lib/restaurant/business-date';

const RANDOM_SEED = 0x4b4b_2026;

export const DEFAULT_DEMO_SEATS = 5;
export const MAX_DEMO_SEATS = 25;
export const DEMO_TIME_ZONE = 'Asia/Karachi';
export const DEMO_CURRENCY = 'PKR';

export type DemoBaseUnit = 'kg' | 'litre' | 'piece';
export type DemoRecipeUnit = 'g' | 'ml' | 'piece';

interface DemoTable {
  id: string;
  name: string;
  capacity: number;
  enabled: boolean;
}

interface DemoFloor {
  id: string;
  name: string;
  tables: DemoTable[];
}

interface DemoBranch {
  id: string;
  key: string;
  name: string;
  city: 'Lahore' | 'Karachi';
  address: string;
  enabled: boolean;
  floors: DemoFloor[];
}

interface DemoModifierOption {
  id: string;
  key: string;
  name: string;
  pricePkr: number;
}

interface DemoModifierGroup {
  id: string;
  key: string;
  name: string;
  required: boolean;
  minimumSelections: number;
  maximumSelections: number;
  options: DemoModifierOption[];
}

export interface DemoMenuProduct {
  id: string;
  key: string;
  name: string;
  category: 'karahi' | 'BBQ' | 'biryani' | 'breads' | 'drinks' | 'desserts';
  enabled: boolean;
  taxRate: number;
  popularityWeight: number;
  modifierGroupIds: string[];
  variants: Array<{
    id: string;
    key: string;
    name: string;
    pricePkr: number;
    serves: number;
    isDefault: boolean;
  }>;
}

export interface DemoIngredient {
  id: string;
  key: string;
  name: string;
  baseUnit: DemoBaseUnit;
  referenceCostPkr: number;
  defaultOpeningQuantity: number;
  enabled: boolean;
}

export interface DemoRecipe {
  id: string;
  productId: string;
  name: string;
  yieldQuantity: number;
  yieldUnit: 'serving';
  estimatedCostPkr: number;
  lines: Array<{
    id: string;
    ingredientId: string;
    quantity: number;
    unit: DemoRecipeUnit;
    baseQuantity: number;
    baseUnit: DemoBaseUnit;
    estimatedCostPkr: number;
  }>;
}

interface DemoSupplier {
  id: string;
  key: string;
  name: string;
  email: string;
  phone: string;
  ingredientIds: string[];
  enabled: boolean;
}

interface DemoPurchaseReceipt {
  id: string;
  receiptNumber: string;
  receivedAt: string;
  lines: Array<{
    purchaseOrderLineId: string;
    ingredientId: string;
    quantity: number;
    baseUnit: DemoBaseUnit;
    accepted: boolean;
  }>;
}

interface DemoPurchaseOrder {
  id: string;
  purchaseOrderNumber: string;
  branchId: string;
  supplierId: string;
  orderedAt: string;
  expectedAt: string;
  status: 'RECEIVED';
  totalPkr: number;
  lines: Array<{
    id: string;
    ingredientId: string;
    quantity: number;
    baseUnit: DemoBaseUnit;
    unitCostPkr: number;
    lineTotalPkr: number;
  }>;
  receipts: DemoPurchaseReceipt[];
}

interface DemoStockBalance {
  id: string;
  branchId: string;
  ingredientId: string;
  onHandQuantity: number;
  baseUnit: DemoBaseUnit;
  valuedAtPkr: number;
}

interface DemoStockMovement {
  id: string;
  branchId: string;
  ingredientId: string;
  kind: 'OPENING' | 'COUNT' | 'WASTAGE' | 'SPOILAGE' | 'STAFF_MEAL';
  quantityDelta: number;
  baseUnit: DemoBaseUnit;
  occurredAt: string;
  reason: string;
}

interface DemoStockCount {
  id: string;
  branchId: string;
  countedAt: string;
  status: 'POSTED';
  lines: Array<{
    ingredientId: string;
    expectedQuantity: number;
    countedQuantity: number;
    varianceQuantity: number;
    baseUnit: DemoBaseUnit;
  }>;
}

interface DemoLowStockRule {
  id: string;
  branchId: string;
  ingredientId: string;
  thresholdQuantity: number;
  currentQuantity: number;
  baseUnit: DemoBaseUnit;
  triggered: boolean;
}

interface DemoCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
  joinedAt: string;
  points: number;
  visitCount: number;
  tier: 'GREEN' | 'SILVER' | 'GOLD';
  marketingConsent: boolean;
  isSynthetic: true;
}

interface DemoOrderModifier {
  modifierGroupId: string;
  optionId: string;
  name: string;
  pricePkr: number;
}

interface DemoOrderLine {
  id: string;
  productId: string;
  variantId: string;
  name: string;
  variantName: string;
  quantity: number;
  unitPricePkr: number;
  lineTotalPkr: number;
  modifiers: DemoOrderModifier[];
}

export interface DemoHistoricalOrder {
  id: string;
  orderNumber: string;
  branchId: string;
  businessDate: string;
  placedAt: string;
  completedAt: string;
  localHour: number;
  channel: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  status: 'CLOSED';
  customerId: string | null;
  tableId: string | null;
  promotionId: string | null;
  subtotalPkr: number;
  discountPkr: number;
  serviceChargePkr: number;
  taxPkr: number;
  totalPkr: number;
  lines: DemoOrderLine[];
}

interface DemoBill {
  id: string;
  orderId: string;
  status: 'SETTLED' | 'PARTIALLY_REFUNDED';
  subtotalPkr: number;
  discountPkr: number;
  serviceChargePkr: number;
  taxPkr: number;
  totalPkr: number;
  settledAt: string;
}

interface DemoSettlement {
  id: string;
  orderId: string;
  billId: string;
  method: 'CASH' | 'CARD';
  provider: 'MOCK';
  amountPkr: number;
  status: 'CAPTURED';
  externalReference: string;
  settledAt: string;
}

interface DemoRefund {
  id: string;
  orderId: string;
  billId: string;
  settlementId: string;
  amountPkr: number;
  provider: 'MOCK';
  status: 'COMPLETED';
  reason: string;
  refundedAt: string;
}

interface DemoDailyCloseCorrection {
  id: string;
  sequence: number;
  reason: string;
  cashDeltaPkr: number;
  approvedByStaffId: string;
  createdAt: string;
}

interface DemoDailyClose {
  id: string;
  branchId: string;
  businessDate: string;
  closedAt: string;
  status: 'CLOSED';
  orderCount: number;
  splitTenderOrderCount: number;
  grossSalesPkr: number;
  refundsPkr: number;
  netSalesPkr: number;
  cashPkr: number;
  cardPkr: number;
  corrections: DemoDailyCloseCorrection[];
}

interface DemoLiveOrder {
  id: string;
  orderNumber: string;
  branchId: string;
  tableId: string | null;
  channel: 'DINE_IN' | 'TAKEAWAY';
  status: 'IN_PREPARATION' | 'PAYMENT_PENDING';
  openedAt: string;
  subtotalPkr: number;
  discountPkr: number;
  serviceChargePkr: number;
  taxPkr: number;
  totalPkr: number;
  lines: DemoOrderLine[];
  bill: {
    id: string;
    status: 'OPEN' | 'PAYMENT_PENDING';
    totalPkr: number;
  };
}

interface DemoKdsTicket {
  id: string;
  orderId: string;
  branchId: string;
  status: 'SENT';
  station: 'HOT_KITCHEN';
  sentAt: string;
  priority: 'NORMAL';
  orderLineIds: string[];
}

interface DemoPromotion {
  id: string;
  name: string;
  code: string;
  status: 'RUNNING';
  percentageOff: number;
  minimumSpendPkr: number;
  startsAt: string;
  endsAt: string;
  branchIds: string[];
}

interface DemoStaff {
  id: string;
  branchId: string;
  name: string;
  role: 'BRANCH_MANAGER' | 'SHIFT_SUPERVISOR' | 'CASHIER' | 'SERVER' | 'COOK';
  email: string;
  phone: string;
  isSynthetic: true;
}

interface DemoRosterShift {
  id: string;
  branchId: string;
  staffId: string;
  role: DemoStaff['role'];
  businessDate: string;
  startsAt: string;
  endsAt: string;
}

interface DemoSopTemplate {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  steps: Array<{
    id: string;
    position: number;
    instruction: string;
    evidenceRequired: boolean;
  }>;
}

interface DemoSopOccurrence {
  id: string;
  templateId: string;
  branchId: string;
  assignedStaffId: string;
  scheduledFor: string;
  status: 'COMPLETED';
  completedAt: string;
}

interface DemoSopEvidence {
  id: string;
  occurrenceId: string;
  stepId: string;
  kind: 'NOTE';
  value: string;
  capturedAt: string;
  isSynthetic: true;
}

interface DemoNotification {
  id: string;
  branchId: string;
  recipientStaffId: string;
  type: 'LOW_STOCK' | 'PURCHASE_RECEIVED' | 'DAILY_CLOSE_CORRECTED' | 'SOP_COMPLETED';
  title: string;
  body: string;
  subjectId: string;
  createdAt: string;
  read: boolean;
}

export interface DemoRestaurantSeed {
  identity: DemoSeatIdentity;
  generatedAt: string;
  timeZone: typeof DEMO_TIME_ZONE;
  currency: typeof DEMO_CURRENCY;
  brand: { id: string; name: 'Karahi Khaas' };
  historicalBusinessDates: string[];
  branches: DemoBranch[];
  menu: {
    modifierGroups: DemoModifierGroup[];
    products: DemoMenuProduct[];
  };
  inventory: {
    unitConversions: Array<{
      fromUnit: DemoRecipeUnit;
      fromName: string;
      toUnit: DemoBaseUnit;
      toName: string;
      factor: number;
    }>;
    ingredients: DemoIngredient[];
    recipes: DemoRecipe[];
    stockBalances: DemoStockBalance[];
    stockMovements: DemoStockMovement[];
    stockCounts: DemoStockCount[];
    lowStockRules: DemoLowStockRule[];
  };
  purchasing: {
    suppliers: DemoSupplier[];
    purchaseOrders: DemoPurchaseOrder[];
  };
  sales: {
    historicalOrders: DemoHistoricalOrder[];
    bills: DemoBill[];
    settlements: DemoSettlement[];
    refunds: DemoRefund[];
    dailyCloses: DemoDailyClose[];
    liveOrders: DemoLiveOrder[];
    kdsTickets: DemoKdsTicket[];
  };
  loyalty: {
    customers: DemoCustomer[];
    promotions: DemoPromotion[];
  };
  workforce: {
    staff: DemoStaff[];
    roster: DemoRosterShift[];
  };
  operations: {
    sopTemplates: DemoSopTemplate[];
    sopOccurrences: DemoSopOccurrence[];
    sopEvidence: DemoSopEvidence[];
    notifications: DemoNotification[];
  };
}

export interface DemoSeedCounts {
  branches: number;
  floors: number;
  tables: number;
  modifierGroups: number;
  modifierOptions: number;
  products: number;
  ingredients: number;
  recipes: number;
  recipeLines: number;
  suppliers: number;
  purchaseOrders: number;
  purchaseReceipts: number;
  stockBalances: number;
  stockMovements: number;
  stockCounts: number;
  stockCountLines: number;
  lowStockRules: number;
  triggeredLowStockRules: number;
  historicalBusinessDates: number;
  historicalOrders: number;
  historicalOrderLines: number;
  bills: number;
  settlements: number;
  splitTenderOrders: number;
  refunds: number;
  dailyCloses: number;
  dailyCloseCorrections: number;
  liveOrders: number;
  kdsTickets: number;
  loyaltyCustomers: number;
  promotions: number;
  staff: number;
  rosterShifts: number;
  sopTemplates: number;
  sopSteps: number;
  sopOccurrences: number;
  sopEvidence: number;
  notifications: number;
}

type MenuSpec = {
  key: string;
  name: string;
  category: DemoMenuProduct['category'];
  popularityWeight: number;
  modifierKeys: string[];
  variants: Array<[key: string, name: string, pricePkr: number, serves: number]>;
};

type IngredientSpec = {
  key: string;
  name: string;
  baseUnit: DemoBaseUnit;
  referenceCostPkr: number;
  defaultOpeningQuantity: number;
};

type RecipeLineSpec = [ingredientKey: string, quantity: number, unit: DemoRecipeUnit];

const BRANCH_SPECS = [
  {
    key: 'lahore_dha',
    name: 'Lahore DHA',
    city: 'Lahore' as const,
    address: 'DHA Phase 6, Lahore (synthetic demo location)',
    floors: [
      ['Ground Floor', 8],
      ['Family Floor', 6],
      ['Rooftop', 6],
    ] as Array<[string, number]>,
  },
  {
    key: 'lahore_gulberg',
    name: 'Lahore Gulberg',
    city: 'Lahore' as const,
    address: 'Gulberg III, Lahore (synthetic demo location)',
    floors: [
      ['Ground Floor', 8],
      ['First Floor', 8],
    ] as Array<[string, number]>,
  },
  {
    key: 'karachi_clifton',
    name: 'Karachi Clifton',
    city: 'Karachi' as const,
    address: 'Clifton Block 5, Karachi (synthetic demo location)',
    floors: [
      ['Ground Floor', 8],
      ['Terrace', 8],
    ] as Array<[string, number]>,
  },
] as const;

const MODIFIER_SPECS = [
  {
    key: 'spice_level',
    name: 'Spice level',
    required: true,
    minimumSelections: 1,
    maximumSelections: 1,
    options: [
      ['mild', 'Mild', 0],
      ['medium', 'Medium', 0],
      ['desi_hot', 'Desi hot', 0],
    ],
  },
  {
    key: 'karahi_finish',
    name: 'Karahi finish',
    required: false,
    minimumSelections: 0,
    maximumSelections: 2,
    options: [
      ['extra_ginger', 'Extra ginger', 80],
      ['extra_green_chilli', 'Extra green chilli', 60],
      ['extra_butter', 'Extra butter', 150],
    ],
  },
  {
    key: 'bbq_sides',
    name: 'BBQ accompaniments',
    required: false,
    minimumSelections: 0,
    maximumSelections: 2,
    options: [
      ['mint_raita', 'Mint raita', 120],
      ['imli_chutney', 'Imli chutney', 100],
      ['fresh_salad', 'Fresh salad', 140],
    ],
  },
  {
    key: 'biryani_sides',
    name: 'Biryani sides',
    required: false,
    minimumSelections: 0,
    maximumSelections: 2,
    options: [
      ['raita', 'Raita', 120],
      ['shami_kebab', 'Shami kebab', 220],
      ['boiled_egg', 'Boiled egg', 100],
    ],
  },
  {
    key: 'bread_finish',
    name: 'Bread finish',
    required: false,
    minimumSelections: 0,
    maximumSelections: 1,
    options: [
      ['butter_brush', 'Butter brush', 60],
      ['sesame', 'Sesame topping', 40],
    ],
  },
  {
    key: 'drink_preferences',
    name: 'Drink preferences',
    required: false,
    minimumSelections: 0,
    maximumSelections: 1,
    options: [
      ['no_ice', 'No ice', 0],
      ['less_sugar', 'Less sugar', 0],
      ['no_sugar', 'No sugar', 0],
    ],
  },
  {
    key: 'dessert_toppings',
    name: 'Dessert toppings',
    required: false,
    minimumSelections: 0,
    maximumSelections: 2,
    options: [
      ['rabri', 'Rabri', 180],
      ['pistachio', 'Pistachio', 120],
      ['rose_syrup', 'Rose syrup', 80],
    ],
  },
] as const;

const MENU_SPECS: MenuSpec[] = [
  {
    key: 'chicken_karahi',
    name: 'Chicken Karahi',
    category: 'karahi',
    popularityWeight: 10,
    modifierKeys: ['spice_level', 'karahi_finish'],
    variants: [
      ['half', 'Half (500 g)', 1_850, 2],
      ['full', 'Full (1 kg)', 3_450, 4],
    ],
  },
  {
    key: 'chicken_white_karahi',
    name: 'Chicken White Karahi',
    category: 'karahi',
    popularityWeight: 7,
    modifierKeys: ['spice_level', 'karahi_finish'],
    variants: [
      ['half', 'Half (500 g)', 2_050, 2],
      ['full', 'Full (1 kg)', 3_850, 4],
    ],
  },
  {
    key: 'chicken_achari_karahi',
    name: 'Chicken Achari Karahi',
    category: 'karahi',
    popularityWeight: 6,
    modifierKeys: ['spice_level', 'karahi_finish'],
    variants: [
      ['half', 'Half (500 g)', 1_950, 2],
      ['full', 'Full (1 kg)', 3_650, 4],
    ],
  },
  {
    key: 'mutton_karahi',
    name: 'Mutton Karahi',
    category: 'karahi',
    popularityWeight: 8,
    modifierKeys: ['spice_level', 'karahi_finish'],
    variants: [
      ['half', 'Half (500 g)', 3_250, 2],
      ['full', 'Full (1 kg)', 6_150, 4],
    ],
  },
  {
    key: 'mutton_shinwari_karahi',
    name: 'Mutton Shinwari Karahi',
    category: 'karahi',
    popularityWeight: 5,
    modifierKeys: ['spice_level', 'karahi_finish'],
    variants: [
      ['half', 'Half (500 g)', 3_350, 2],
      ['full', 'Full (1 kg)', 6_350, 4],
    ],
  },
  {
    key: 'mutton_black_pepper_karahi',
    name: 'Mutton Black Pepper Karahi',
    category: 'karahi',
    popularityWeight: 4,
    modifierKeys: ['spice_level', 'karahi_finish'],
    variants: [
      ['half', 'Half (500 g)', 3_450, 2],
      ['full', 'Full (1 kg)', 6_550, 4],
    ],
  },
  {
    key: 'desi_chicken_karahi',
    name: 'Desi Chicken Karahi',
    category: 'karahi',
    popularityWeight: 5,
    modifierKeys: ['spice_level', 'karahi_finish'],
    variants: [
      ['half', 'Half (500 g)', 2_450, 2],
      ['full', 'Full (1 kg)', 4_650, 4],
    ],
  },
  {
    key: 'paneer_karahi',
    name: 'Paneer Karahi',
    category: 'karahi',
    popularityWeight: 3,
    modifierKeys: ['spice_level', 'karahi_finish'],
    variants: [
      ['regular', 'Regular', 1_450, 2],
      ['family', 'Family', 2_650, 4],
    ],
  },
  {
    key: 'chicken_tikka',
    name: 'Chicken Tikka',
    category: 'BBQ',
    popularityWeight: 9,
    modifierKeys: ['spice_level', 'bbq_sides'],
    variants: [['quarter', 'Quarter chicken', 780, 1]],
  },
  {
    key: 'malai_boti',
    name: 'Malai Boti',
    category: 'BBQ',
    popularityWeight: 9,
    modifierKeys: ['bbq_sides'],
    variants: [
      ['six_skewers', '6 pieces', 890, 1],
      ['twelve_skewers', '12 pieces', 1_650, 2],
    ],
  },
  {
    key: 'chicken_boti',
    name: 'Chicken Boti',
    category: 'BBQ',
    popularityWeight: 8,
    modifierKeys: ['spice_level', 'bbq_sides'],
    variants: [
      ['six_skewers', '6 pieces', 820, 1],
      ['twelve_skewers', '12 pieces', 1_520, 2],
    ],
  },
  {
    key: 'beef_seekh_kebab',
    name: 'Beef Seekh Kebab',
    category: 'BBQ',
    popularityWeight: 7,
    modifierKeys: ['spice_level', 'bbq_sides'],
    variants: [
      ['two', '2 skewers', 720, 1],
      ['four', '4 skewers', 1_350, 2],
    ],
  },
  {
    key: 'chicken_seekh_kebab',
    name: 'Chicken Seekh Kebab',
    category: 'BBQ',
    popularityWeight: 6,
    modifierKeys: ['spice_level', 'bbq_sides'],
    variants: [
      ['two', '2 skewers', 650, 1],
      ['four', '4 skewers', 1_220, 2],
    ],
  },
  {
    key: 'chapli_kebab',
    name: 'Chapli Kebab',
    category: 'BBQ',
    popularityWeight: 6,
    modifierKeys: ['spice_level', 'bbq_sides'],
    variants: [
      ['two', '2 kebabs', 780, 1],
      ['four', '4 kebabs', 1_450, 2],
    ],
  },
  {
    key: 'mutton_chops',
    name: 'Mutton Chops',
    category: 'BBQ',
    popularityWeight: 5,
    modifierKeys: ['spice_level', 'bbq_sides'],
    variants: [
      ['four', '4 chops', 1_950, 2],
      ['eight', '8 chops', 3_650, 4],
    ],
  },
  {
    key: 'reshmi_kebab',
    name: 'Reshmi Kebab',
    category: 'BBQ',
    popularityWeight: 5,
    modifierKeys: ['bbq_sides'],
    variants: [
      ['two', '2 skewers', 690, 1],
      ['four', '4 skewers', 1_290, 2],
    ],
  },
  {
    key: 'bbq_platter',
    name: 'Karahi Khaas BBQ Platter',
    category: 'BBQ',
    popularityWeight: 6,
    modifierKeys: ['spice_level', 'bbq_sides'],
    variants: [
      ['small', 'Small platter', 2_850, 3],
      ['large', 'Large platter', 5_250, 6],
    ],
  },
  {
    key: 'chicken_biryani',
    name: 'Chicken Biryani',
    category: 'biryani',
    popularityWeight: 10,
    modifierKeys: ['spice_level', 'biryani_sides'],
    variants: [
      ['single', 'Single', 520, 1],
      ['family', 'Family box', 1_850, 4],
    ],
  },
  {
    key: 'beef_biryani',
    name: 'Beef Biryani',
    category: 'biryani',
    popularityWeight: 7,
    modifierKeys: ['spice_level', 'biryani_sides'],
    variants: [
      ['single', 'Single', 620, 1],
      ['family', 'Family box', 2_250, 4],
    ],
  },
  {
    key: 'mutton_biryani',
    name: 'Mutton Biryani',
    category: 'biryani',
    popularityWeight: 7,
    modifierKeys: ['spice_level', 'biryani_sides'],
    variants: [
      ['single', 'Single', 720, 1],
      ['family', 'Family box', 2_650, 4],
    ],
  },
  {
    key: 'sindhi_biryani',
    name: 'Sindhi Biryani',
    category: 'biryani',
    popularityWeight: 8,
    modifierKeys: ['spice_level', 'biryani_sides'],
    variants: [
      ['single', 'Single', 580, 1],
      ['family', 'Family box', 2_050, 4],
    ],
  },
  {
    key: 'vegetable_biryani',
    name: 'Vegetable Biryani',
    category: 'biryani',
    popularityWeight: 4,
    modifierKeys: ['spice_level', 'biryani_sides'],
    variants: [
      ['single', 'Single', 450, 1],
      ['family', 'Family box', 1_550, 4],
    ],
  },
  {
    key: 'plain_naan',
    name: 'Plain Naan',
    category: 'breads',
    popularityWeight: 10,
    modifierKeys: ['bread_finish'],
    variants: [['single', 'Single', 90, 1]],
  },
  {
    key: 'garlic_naan',
    name: 'Garlic Naan',
    category: 'breads',
    popularityWeight: 8,
    modifierKeys: ['bread_finish'],
    variants: [['single', 'Single', 160, 1]],
  },
  {
    key: 'roghni_naan',
    name: 'Roghni Naan',
    category: 'breads',
    popularityWeight: 7,
    modifierKeys: ['bread_finish'],
    variants: [['single', 'Single', 180, 1]],
  },
  {
    key: 'cheese_naan',
    name: 'Cheese Naan',
    category: 'breads',
    popularityWeight: 5,
    modifierKeys: ['bread_finish'],
    variants: [['single', 'Single', 390, 1]],
  },
  {
    key: 'tandoori_roti',
    name: 'Tandoori Roti',
    category: 'breads',
    popularityWeight: 8,
    modifierKeys: ['bread_finish'],
    variants: [['single', 'Single', 70, 1]],
  },
  {
    key: 'paratha',
    name: 'Lachha Paratha',
    category: 'breads',
    popularityWeight: 6,
    modifierKeys: ['bread_finish'],
    variants: [['single', 'Single', 220, 1]],
  },
  {
    key: 'mint_margarita',
    name: 'Mint Margarita',
    category: 'drinks',
    popularityWeight: 9,
    modifierKeys: ['drink_preferences'],
    variants: [
      ['glass', 'Glass', 350, 1],
      ['jug', 'Jug', 1_150, 4],
    ],
  },
  {
    key: 'fresh_lime',
    name: 'Fresh Lime',
    category: 'drinks',
    popularityWeight: 7,
    modifierKeys: ['drink_preferences'],
    variants: [
      ['glass', 'Glass', 280, 1],
      ['jug', 'Jug', 950, 4],
    ],
  },
  {
    key: 'sweet_lassi',
    name: 'Sweet Lassi',
    category: 'drinks',
    popularityWeight: 7,
    modifierKeys: ['drink_preferences'],
    variants: [
      ['glass', 'Glass', 320, 1],
      ['jug', 'Jug', 1_050, 4],
    ],
  },
  {
    key: 'salted_lassi',
    name: 'Salted Lassi',
    category: 'drinks',
    popularityWeight: 5,
    modifierKeys: ['drink_preferences'],
    variants: [
      ['glass', 'Glass', 300, 1],
      ['jug', 'Jug', 980, 4],
    ],
  },
  {
    key: 'doodh_patti',
    name: 'Doodh Patti Chai',
    category: 'drinks',
    popularityWeight: 6,
    modifierKeys: ['drink_preferences'],
    variants: [
      ['cup', 'Cup', 220, 1],
      ['pot', 'Pot', 750, 4],
    ],
  },
  {
    key: 'soft_drink',
    name: 'Soft Drink',
    category: 'drinks',
    popularityWeight: 10,
    modifierKeys: ['drink_preferences'],
    variants: [
      ['glass', 'Glass', 180, 1],
      ['jug', 'Jug', 650, 4],
    ],
  },
  {
    key: 'mineral_water',
    name: 'Mineral Water',
    category: 'drinks',
    popularityWeight: 8,
    modifierKeys: [],
    variants: [
      ['small', '500 ml', 120, 1],
      ['large', '1.5 litre', 220, 3],
    ],
  },
  {
    key: 'gulab_jamun',
    name: 'Gulab Jamun',
    category: 'desserts',
    popularityWeight: 8,
    modifierKeys: ['dessert_toppings'],
    variants: [
      ['two', '2 pieces', 320, 1],
      ['six', '6 pieces', 850, 3],
    ],
  },
  {
    key: 'kheer',
    name: 'Kheer',
    category: 'desserts',
    popularityWeight: 7,
    modifierKeys: ['dessert_toppings'],
    variants: [
      ['bowl', 'Bowl', 380, 1],
      ['family', 'Family bowl', 1_250, 4],
    ],
  },
  {
    key: 'gajrela',
    name: 'Gajrela',
    category: 'desserts',
    popularityWeight: 5,
    modifierKeys: ['dessert_toppings'],
    variants: [
      ['bowl', 'Bowl', 420, 1],
      ['family', 'Family bowl', 1_390, 4],
    ],
  },
  {
    key: 'kulfi_falooda',
    name: 'Kulfi Falooda',
    category: 'desserts',
    popularityWeight: 7,
    modifierKeys: ['dessert_toppings'],
    variants: [
      ['glass', 'Glass', 520, 1],
      ['sharing', 'Sharing', 950, 2],
    ],
  },
  {
    key: 'shahi_tukray',
    name: 'Shahi Tukray',
    category: 'desserts',
    popularityWeight: 5,
    modifierKeys: ['dessert_toppings'],
    variants: [
      ['two', '2 pieces', 450, 1],
      ['six', '6 pieces', 1_190, 3],
    ],
  },
];

const INGREDIENT_SPECS: IngredientSpec[] = [
  ['chicken_bone_in', 'Chicken, bone-in', 'kg', 920, 45],
  ['chicken_boneless', 'Chicken, boneless', 'kg', 1_120, 32],
  ['mutton_bone_in', 'Mutton, bone-in', 'kg', 2_650, 24],
  ['mutton_chops', 'Mutton chops', 'kg', 2_950, 16],
  ['beef_mince', 'Beef mince', 'kg', 1_450, 20],
  ['chicken_mince', 'Chicken mince', 'kg', 1_180, 16],
  ['beef_boneless', 'Beef, boneless', 'kg', 1_650, 20],
  ['basmati_rice', 'Basmati rice', 'kg', 480, 80],
  ['flour_maida', 'Refined flour (maida)', 'kg', 220, 45],
  ['flour_atta', 'Whole-wheat flour (atta)', 'kg', 190, 45],
  ['gram_flour', 'Gram flour (besan)', 'kg', 310, 12],
  ['paneer', 'Paneer', 'kg', 1_650, 10],
  ['mozzarella', 'Mozzarella cheese', 'kg', 2_100, 8],
  ['yogurt', 'Yogurt', 'litre', 340, 32],
  ['milk', 'Fresh milk', 'litre', 310, 40],
  ['cream', 'Cooking cream', 'litre', 1_150, 14],
  ['cooking_oil', 'Cooking oil', 'litre', 610, 55],
  ['desi_ghee', 'Desi ghee', 'kg', 1_750, 14],
  ['butter', 'Butter', 'kg', 2_150, 10],
  ['tomatoes', 'Tomatoes', 'kg', 240, 55],
  ['onions', 'Onions', 'kg', 190, 60],
  ['potatoes', 'Potatoes', 'kg', 180, 30],
  ['ginger', 'Fresh ginger', 'kg', 720, 9],
  ['garlic', 'Fresh garlic', 'kg', 650, 9],
  ['green_chillies', 'Green chillies', 'kg', 520, 7],
  ['lemons', 'Lemons', 'piece', 35, 90],
  ['fresh_coriander', 'Fresh coriander', 'kg', 360, 7],
  ['fresh_mint', 'Fresh mint', 'kg', 420, 6],
  ['capsicum', 'Capsicum', 'kg', 420, 9],
  ['carrots', 'Carrots', 'kg', 210, 18],
  ['peas', 'Green peas', 'kg', 480, 12],
  ['cucumber', 'Cucumber', 'kg', 190, 18],
  ['eggs', 'Eggs', 'piece', 38, 120],
  ['bread_slices', 'Milk bread slices', 'piece', 28, 80],
  ['naan_dough_ball', 'Naan dough ball', 'piece', 42, 180],
  ['roti_dough_ball', 'Roti dough ball', 'piece', 30, 180],
  ['filtered_water', 'Filtered water', 'litre', 8, 180],
  ['cumin', 'Cumin', 'kg', 1_250, 4],
  ['coriander_seed', 'Coriander seed', 'kg', 720, 4],
  ['black_pepper', 'Black pepper', 'kg', 2_800, 3],
  ['red_chilli_powder', 'Red chilli powder', 'kg', 980, 4],
  ['turmeric', 'Turmeric', 'kg', 760, 3],
  ['garam_masala', 'Garam masala', 'kg', 1_850, 3],
  ['biryani_masala', 'Biryani masala', 'kg', 1_350, 4],
  ['chaat_masala', 'Chaat masala', 'kg', 1_100, 3],
  ['salt', 'Salt', 'kg', 90, 20],
  ['sugar', 'Sugar', 'kg', 190, 28],
  ['cardamom', 'Green cardamom', 'kg', 6_500, 2],
  ['cinnamon', 'Cinnamon', 'kg', 1_650, 2],
  ['cloves', 'Cloves', 'kg', 2_300, 2],
  ['saffron', 'Saffron', 'kg', 180_000, 0.12],
  ['almonds', 'Almonds', 'kg', 3_200, 5],
  ['pistachios', 'Pistachios', 'kg', 4_200, 4],
  ['raisins', 'Raisins', 'kg', 1_150, 4],
  ['rose_water', 'Rose water', 'litre', 520, 5],
  ['kewra_water', 'Kewra water', 'litre', 680, 4],
  ['soft_drink_syrup', 'Soft-drink syrup', 'litre', 780, 24],
  ['bottled_water', 'Bottled mineral water', 'piece', 82, 160],
  ['tea_leaves', 'Tea leaves', 'kg', 1_850, 6],
  ['vermicelli', 'Falooda vermicelli', 'kg', 420, 8],
].map(([key, name, baseUnit, referenceCostPkr, defaultOpeningQuantity]) => ({
  key: key as string,
  name: name as string,
  baseUnit: baseUnit as DemoBaseUnit,
  referenceCostPkr: referenceCostPkr as number,
  defaultOpeningQuantity: defaultOpeningQuantity as number,
}));

const RECIPE_SPECS: Record<string, RecipeLineSpec[]> = {
  chicken_karahi: [
    ['chicken_bone_in', 500, 'g'],
    ['tomatoes', 220, 'g'],
    ['onions', 70, 'g'],
    ['ginger', 18, 'g'],
    ['garlic', 18, 'g'],
    ['green_chillies', 12, 'g'],
    ['cooking_oil', 70, 'ml'],
    ['garam_masala', 5, 'g'],
  ],
  chicken_white_karahi: [
    ['chicken_bone_in', 500, 'g'],
    ['yogurt', 160, 'ml'],
    ['cream', 90, 'ml'],
    ['onions', 100, 'g'],
    ['ginger', 16, 'g'],
    ['garlic', 16, 'g'],
    ['black_pepper', 6, 'g'],
    ['butter', 35, 'g'],
  ],
  chicken_achari_karahi: [
    ['chicken_bone_in', 500, 'g'],
    ['tomatoes', 200, 'g'],
    ['yogurt', 80, 'ml'],
    ['cooking_oil', 70, 'ml'],
    ['coriander_seed', 7, 'g'],
    ['red_chilli_powder', 6, 'g'],
    ['turmeric', 3, 'g'],
    ['green_chillies', 14, 'g'],
  ],
  mutton_karahi: [
    ['mutton_bone_in', 500, 'g'],
    ['tomatoes', 250, 'g'],
    ['ginger', 20, 'g'],
    ['garlic', 20, 'g'],
    ['green_chillies', 14, 'g'],
    ['cooking_oil', 80, 'ml'],
    ['black_pepper', 5, 'g'],
  ],
  mutton_shinwari_karahi: [
    ['mutton_bone_in', 500, 'g'],
    ['tomatoes', 280, 'g'],
    ['green_chillies', 18, 'g'],
    ['salt', 8, 'g'],
    ['cooking_oil', 75, 'ml'],
    ['black_pepper', 7, 'g'],
  ],
  mutton_black_pepper_karahi: [
    ['mutton_bone_in', 500, 'g'],
    ['tomatoes', 220, 'g'],
    ['onions', 80, 'g'],
    ['black_pepper', 12, 'g'],
    ['ginger', 18, 'g'],
    ['garlic', 18, 'g'],
    ['cooking_oil', 75, 'ml'],
  ],
  desi_chicken_karahi: [
    ['chicken_bone_in', 550, 'g'],
    ['tomatoes', 240, 'g'],
    ['onions', 60, 'g'],
    ['ginger', 20, 'g'],
    ['garlic', 20, 'g'],
    ['desi_ghee', 55, 'g'],
    ['garam_masala', 6, 'g'],
  ],
  paneer_karahi: [
    ['paneer', 300, 'g'],
    ['tomatoes', 180, 'g'],
    ['onions', 100, 'g'],
    ['capsicum', 100, 'g'],
    ['cream', 50, 'ml'],
    ['cooking_oil', 45, 'ml'],
    ['garam_masala', 4, 'g'],
  ],
  chicken_tikka: [
    ['chicken_bone_in', 350, 'g'],
    ['yogurt', 100, 'ml'],
    ['lemons', 1, 'piece'],
    ['ginger', 10, 'g'],
    ['garlic', 10, 'g'],
    ['red_chilli_powder', 5, 'g'],
    ['garam_masala', 4, 'g'],
  ],
  malai_boti: [
    ['chicken_boneless', 500, 'g'],
    ['yogurt', 120, 'ml'],
    ['cream', 80, 'ml'],
    ['lemons', 1, 'piece'],
    ['ginger', 12, 'g'],
    ['garlic', 12, 'g'],
    ['green_chillies', 12, 'g'],
    ['black_pepper', 4, 'g'],
  ],
  chicken_boti: [
    ['chicken_boneless', 450, 'g'],
    ['yogurt', 100, 'ml'],
    ['lemons', 1, 'piece'],
    ['ginger', 10, 'g'],
    ['garlic', 10, 'g'],
    ['red_chilli_powder', 6, 'g'],
    ['cumin', 4, 'g'],
  ],
  beef_seekh_kebab: [
    ['beef_mince', 400, 'g'],
    ['onions', 80, 'g'],
    ['fresh_coriander', 20, 'g'],
    ['green_chillies', 12, 'g'],
    ['garam_masala', 5, 'g'],
    ['cumin', 4, 'g'],
  ],
  chicken_seekh_kebab: [
    ['chicken_mince', 400, 'g'],
    ['onions', 70, 'g'],
    ['fresh_coriander', 20, 'g'],
    ['green_chillies', 10, 'g'],
    ['garam_masala', 5, 'g'],
    ['coriander_seed', 4, 'g'],
  ],
  chapli_kebab: [
    ['beef_mince', 400, 'g'],
    ['gram_flour', 35, 'g'],
    ['onions', 90, 'g'],
    ['tomatoes', 80, 'g'],
    ['eggs', 1, 'piece'],
    ['fresh_coriander', 20, 'g'],
    ['coriander_seed', 6, 'g'],
  ],
  mutton_chops: [
    ['mutton_chops', 500, 'g'],
    ['yogurt', 120, 'ml'],
    ['lemons', 1, 'piece'],
    ['ginger', 12, 'g'],
    ['garlic', 12, 'g'],
    ['red_chilli_powder', 5, 'g'],
    ['garam_masala', 5, 'g'],
  ],
  reshmi_kebab: [
    ['chicken_mince', 400, 'g'],
    ['cream', 70, 'ml'],
    ['eggs', 1, 'piece'],
    ['onions', 60, 'g'],
    ['green_chillies', 10, 'g'],
    ['black_pepper', 4, 'g'],
  ],
  bbq_platter: [
    ['chicken_boneless', 350, 'g'],
    ['mutton_chops', 300, 'g'],
    ['beef_mince', 250, 'g'],
    ['yogurt', 160, 'ml'],
    ['lemons', 2, 'piece'],
    ['ginger', 18, 'g'],
    ['garlic', 18, 'g'],
    ['garam_masala', 8, 'g'],
  ],
  chicken_biryani: [
    ['basmati_rice', 180, 'g'],
    ['chicken_bone_in', 180, 'g'],
    ['yogurt', 60, 'ml'],
    ['tomatoes', 70, 'g'],
    ['onions', 60, 'g'],
    ['cooking_oil', 35, 'ml'],
    ['biryani_masala', 8, 'g'],
  ],
  beef_biryani: [
    ['basmati_rice', 180, 'g'],
    ['beef_boneless', 180, 'g'],
    ['yogurt', 60, 'ml'],
    ['tomatoes', 70, 'g'],
    ['onions', 60, 'g'],
    ['cooking_oil', 35, 'ml'],
    ['biryani_masala', 8, 'g'],
  ],
  mutton_biryani: [
    ['basmati_rice', 180, 'g'],
    ['mutton_bone_in', 190, 'g'],
    ['yogurt', 60, 'ml'],
    ['tomatoes', 70, 'g'],
    ['onions', 60, 'g'],
    ['cooking_oil', 35, 'ml'],
    ['biryani_masala', 8, 'g'],
  ],
  sindhi_biryani: [
    ['basmati_rice', 180, 'g'],
    ['chicken_bone_in', 180, 'g'],
    ['potatoes', 90, 'g'],
    ['yogurt', 60, 'ml'],
    ['tomatoes', 60, 'g'],
    ['green_chillies', 8, 'g'],
    ['biryani_masala', 9, 'g'],
  ],
  vegetable_biryani: [
    ['basmati_rice', 180, 'g'],
    ['potatoes', 70, 'g'],
    ['carrots', 60, 'g'],
    ['peas', 50, 'g'],
    ['capsicum', 40, 'g'],
    ['cooking_oil', 30, 'ml'],
    ['biryani_masala', 7, 'g'],
  ],
  plain_naan: [
    ['naan_dough_ball', 1, 'piece'],
    ['butter', 8, 'g'],
  ],
  garlic_naan: [
    ['naan_dough_ball', 1, 'piece'],
    ['garlic', 12, 'g'],
    ['butter', 10, 'g'],
    ['fresh_coriander', 3, 'g'],
  ],
  roghni_naan: [
    ['naan_dough_ball', 1, 'piece'],
    ['eggs', 1, 'piece'],
    ['butter', 12, 'g'],
  ],
  cheese_naan: [
    ['naan_dough_ball', 1, 'piece'],
    ['mozzarella', 90, 'g'],
    ['butter', 10, 'g'],
  ],
  tandoori_roti: [['roti_dough_ball', 1, 'piece']],
  paratha: [
    ['flour_atta', 120, 'g'],
    ['desi_ghee', 28, 'g'],
    ['filtered_water', 55, 'ml'],
    ['salt', 2, 'g'],
  ],
  mint_margarita: [
    ['filtered_water', 260, 'ml'],
    ['lemons', 2, 'piece'],
    ['fresh_mint', 18, 'g'],
    ['sugar', 35, 'g'],
    ['salt', 1, 'g'],
  ],
  fresh_lime: [
    ['filtered_water', 280, 'ml'],
    ['lemons', 2, 'piece'],
    ['sugar', 28, 'g'],
    ['salt', 1, 'g'],
  ],
  sweet_lassi: [
    ['yogurt', 220, 'ml'],
    ['milk', 80, 'ml'],
    ['sugar', 32, 'g'],
    ['cardamom', 1, 'g'],
  ],
  salted_lassi: [
    ['yogurt', 220, 'ml'],
    ['milk', 80, 'ml'],
    ['salt', 2, 'g'],
    ['cumin', 2, 'g'],
  ],
  doodh_patti: [
    ['milk', 180, 'ml'],
    ['filtered_water', 80, 'ml'],
    ['tea_leaves', 7, 'g'],
    ['sugar', 18, 'g'],
    ['cardamom', 1, 'g'],
  ],
  soft_drink: [
    ['soft_drink_syrup', 45, 'ml'],
    ['filtered_water', 255, 'ml'],
  ],
  mineral_water: [['bottled_water', 1, 'piece']],
  gulab_jamun: [
    ['flour_maida', 55, 'g'],
    ['milk', 35, 'ml'],
    ['desi_ghee', 18, 'g'],
    ['sugar', 90, 'g'],
    ['cardamom', 1, 'g'],
  ],
  kheer: [
    ['milk', 350, 'ml'],
    ['basmati_rice', 35, 'g'],
    ['sugar', 55, 'g'],
    ['cardamom', 1, 'g'],
    ['almonds', 8, 'g'],
    ['pistachios', 6, 'g'],
  ],
  gajrela: [
    ['carrots', 180, 'g'],
    ['milk', 250, 'ml'],
    ['sugar', 50, 'g'],
    ['desi_ghee', 22, 'g'],
    ['almonds', 8, 'g'],
    ['raisins', 7, 'g'],
  ],
  kulfi_falooda: [
    ['milk', 240, 'ml'],
    ['cream', 70, 'ml'],
    ['vermicelli', 40, 'g'],
    ['sugar', 45, 'g'],
    ['pistachios', 8, 'g'],
    ['rose_water', 5, 'ml'],
  ],
  shahi_tukray: [
    ['bread_slices', 2, 'piece'],
    ['milk', 220, 'ml'],
    ['cream', 40, 'ml'],
    ['sugar', 45, 'g'],
    ['desi_ghee', 20, 'g'],
    ['cardamom', 1, 'g'],
    ['pistachios', 6, 'g'],
  ],
};

const SUPPLIER_SPECS = [
  {
    key: 'punjab_proteins',
    name: 'Punjab Proteins (Demo)',
    ingredients: [
      'chicken_bone_in',
      'chicken_boneless',
      'mutton_bone_in',
      'mutton_chops',
      'beef_mince',
      'chicken_mince',
      'beef_boneless',
    ],
  },
  {
    key: 'mandi_fresh',
    name: 'Mandi Fresh Produce (Demo)',
    ingredients: [
      'tomatoes',
      'onions',
      'potatoes',
      'ginger',
      'garlic',
      'green_chillies',
      'lemons',
      'fresh_coriander',
      'fresh_mint',
      'capsicum',
      'carrots',
      'peas',
      'cucumber',
    ],
  },
  {
    key: 'indus_grains',
    name: 'Indus Rice & Grains (Demo)',
    ingredients: ['basmati_rice', 'flour_maida', 'flour_atta', 'gram_flour', 'sugar', 'vermicelli'],
  },
  {
    key: 'desi_dairy_bakery',
    name: 'Desi Dairy & Bakery Supply (Demo)',
    ingredients: [
      'paneer',
      'mozzarella',
      'yogurt',
      'milk',
      'cream',
      'desi_ghee',
      'butter',
      'eggs',
      'bread_slices',
      'naan_dough_ball',
      'roti_dough_ball',
    ],
  },
  {
    key: 'spice_route',
    name: 'Spice Route Wholesale (Demo)',
    ingredients: [
      'cumin',
      'coriander_seed',
      'black_pepper',
      'red_chilli_powder',
      'turmeric',
      'garam_masala',
      'biryani_masala',
      'chaat_masala',
      'salt',
      'cardamom',
      'cinnamon',
      'cloves',
      'saffron',
      'almonds',
      'pistachios',
      'raisins',
      'tea_leaves',
    ],
  },
  {
    key: 'pak_beverage',
    name: 'Pak Beverage & Pantry (Demo)',
    ingredients: [
      'cooking_oil',
      'filtered_water',
      'rose_water',
      'kewra_water',
      'soft_drink_syrup',
      'bottled_water',
    ],
  },
] as const;

const SOP_SPECS = [
  {
    key: 'opening_food_safety',
    name: 'Opening & food safety',
    steps: [
      'Record cold-storage temperatures.',
      'Confirm hand-wash stations are stocked.',
      'Inspect prep surfaces and utensils.',
      'Release kitchen for service.',
    ],
  },
  {
    key: 'closing_cash_handover',
    name: 'Closing & cash handover',
    steps: [
      'Reconcile POS tenders with drawer totals.',
      'Record and explain any variance.',
      'Seal the cash handover envelope.',
      'Supervisor approves the daily close.',
    ],
  },
  {
    key: 'allergen_incident_response',
    name: 'Allergen & incident response',
    steps: [
      'Stop preparation and isolate affected items.',
      'Notify the shift supervisor.',
      'Record guest and order details without medical claims.',
      'Document corrective action and sign-off.',
    ],
  },
] as const;

export function parseDemoSeatCount(value: unknown = process.env.DEMO_SEATS): number {
  if (value === undefined) return DEFAULT_DEMO_SEATS;

  const normalized = typeof value === 'string' ? value.trim() : value;
  const seatCount =
    typeof normalized === 'number'
      ? normalized
      : typeof normalized === 'string' && /^[1-9]\d*$/.test(normalized)
        ? Number(normalized)
        : Number.NaN;

  if (!Number.isSafeInteger(seatCount) || seatCount < 1 || seatCount > MAX_DEMO_SEATS) {
    throw new RangeError(`DEMO_SEATS must be an integer from 1 to ${MAX_DEMO_SEATS}`);
  }

  return seatCount;
}

export function demoSeatIdentity(seat: number): DemoSeatIdentity {
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > MAX_DEMO_SEATS) {
    throw new RangeError(`seat must be an integer from 1 to ${MAX_DEMO_SEATS}`);
  }

  return {
    seatNumber: seat,
    organizationId: `org_demo_restaurant_seat_${seat}`,
    slug: `demo-restaurant-seat-${seat}`,
    displayName: `Demo Restaurant — Seat ${seat}`,
    managerUserId: `user_demo_restaurant_seat_${seat}_manager`,
    managerEmail: `manager.seat${seat}@demo.devfathom.invalid`,
  };
}

export function demoSeatIdentities(value: unknown = process.env.DEMO_SEATS): DemoSeatIdentity[] {
  return Array.from({ length: parseDemoSeatCount(value) }, (_, index) =>
    demoSeatIdentity(index + 1)
  );
}

function seatId(seat: number, kind: string, key: string | number): string {
  return `demo_s${seat}_${kind}_${key}`;
}

function round(value: number, places = 2): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function addDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function localTimestamp(date: string, hour: number, minute = 0): string {
  const targetDate = hour >= 24 ? addDate(date, Math.floor(hour / 24)) : date;
  const normalizedHour = hour % 24;
  return `${targetDate}T${String(normalizedHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:00`;
}

function shiftIso(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b_79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pickWeighted<T>(random: () => number, items: T[], weight: (item: T) => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let remaining = random() * total;
  for (const item of items) {
    remaining -= weight(item);
    if (remaining <= 0) return item;
  }
  return items[items.length - 1]!;
}

function buildBranches(seat: number): DemoBranch[] {
  return BRANCH_SPECS.map((branch, branchIndex) => ({
    id: seatId(seat, 'branch', branch.key),
    key: branch.key,
    name: branch.name,
    city: branch.city,
    address: branch.address,
    enabled: true,
    floors: branch.floors.map(([name, tableCount], floorIndex) => {
      const floorKey = `${branch.key}_${floorIndex + 1}`;
      return {
        id: seatId(seat, 'floor', floorKey),
        name,
        tables: Array.from({ length: tableCount }, (_, tableIndex) => ({
          id: seatId(seat, 'table', `${floorKey}_${tableIndex + 1}`),
          name: `${String.fromCharCode(65 + branchIndex)}${floorIndex + 1}-${String(
            tableIndex + 1
          ).padStart(2, '0')}`,
          capacity: [2, 4, 4, 6, 4, 8][tableIndex % 6]!,
          enabled: true,
        })),
      };
    }),
  }));
}

function buildMenu(seat: number): DemoRestaurantSeed['menu'] {
  const modifierGroups = MODIFIER_SPECS.map((group) => ({
    id: seatId(seat, 'modifier_group', group.key),
    key: group.key,
    name: group.name,
    required: group.required,
    minimumSelections: group.minimumSelections,
    maximumSelections: group.maximumSelections,
    options: group.options.map(([key, name, pricePkr]) => ({
      id: seatId(seat, 'modifier_option', `${group.key}_${key}`),
      key,
      name,
      pricePkr,
    })),
  }));
  const modifierIdByKey = new Map<string, string>(
    modifierGroups.map((group) => [group.key, group.id])
  );

  return {
    modifierGroups,
    products: MENU_SPECS.map((product) => ({
      id: seatId(seat, 'product', product.key),
      key: product.key,
      name: product.name,
      category: product.category,
      enabled: true,
      taxRate: 0.16,
      popularityWeight: product.popularityWeight,
      modifierGroupIds: product.modifierKeys.map((key) => modifierIdByKey.get(key)!),
      variants: product.variants.map(([key, name, pricePkr, serves], index) => ({
        id: seatId(seat, 'variant', `${product.key}_${key}`),
        key,
        name,
        pricePkr,
        serves,
        isDefault: index === 0,
      })),
    })),
  };
}

function buildIngredients(seat: number): DemoIngredient[] {
  return INGREDIENT_SPECS.map((ingredient) => ({
    id: seatId(seat, 'ingredient', ingredient.key),
    key: ingredient.key,
    name: ingredient.name,
    baseUnit: ingredient.baseUnit,
    referenceCostPkr: ingredient.referenceCostPkr,
    defaultOpeningQuantity: ingredient.defaultOpeningQuantity,
    enabled: true,
  }));
}

function buildRecipes(
  seat: number,
  products: DemoMenuProduct[],
  ingredients: DemoIngredient[]
): DemoRecipe[] {
  const ingredientByKey = new Map(ingredients.map((ingredient) => [ingredient.key, ingredient]));

  return products.map((product) => {
    const specs = RECIPE_SPECS[product.key];
    if (!specs) throw new Error(`Missing recipe for ${product.key}`);

    const lines = specs.map(([ingredientKey, quantity, unit], index) => {
      const ingredient = ingredientByKey.get(ingredientKey);
      if (!ingredient) throw new Error(`Unknown recipe ingredient ${ingredientKey}`);
      const baseQuantity = unit === 'piece' ? quantity : quantity * 0.001;
      const compatible =
        (unit === 'g' && ingredient.baseUnit === 'kg') ||
        (unit === 'ml' && ingredient.baseUnit === 'litre') ||
        (unit === 'piece' && ingredient.baseUnit === 'piece');
      if (!compatible) throw new Error(`Incompatible unit ${unit} for ${ingredient.key}`);

      return {
        id: seatId(seat, 'recipe_line', `${product.key}_${index + 1}`),
        ingredientId: ingredient.id,
        quantity,
        unit,
        baseQuantity: round(baseQuantity, 4),
        baseUnit: ingredient.baseUnit,
        estimatedCostPkr: round(baseQuantity * ingredient.referenceCostPkr),
      };
    });

    return {
      id: seatId(seat, 'recipe', product.key),
      productId: product.id,
      name: `${product.name} standard recipe`,
      yieldQuantity: 1,
      yieldUnit: 'serving',
      estimatedCostPkr: round(lines.reduce((sum, line) => sum + line.estimatedCostPkr, 0)),
      lines,
    };
  });
}

function buildPurchasing(
  seat: number,
  branches: DemoBranch[],
  ingredients: DemoIngredient[],
  latestBusinessDate: string
): DemoRestaurantSeed['purchasing'] {
  const random = mulberry32(RANDOM_SEED ^ 0x5050);
  const ingredientByKey = new Map(ingredients.map((ingredient) => [ingredient.key, ingredient]));
  const suppliers: DemoSupplier[] = SUPPLIER_SPECS.map((supplier, index) => ({
    id: seatId(seat, 'supplier', supplier.key),
    key: supplier.key,
    name: supplier.name,
    email: `${supplier.key}.s${seat}@demo.devfathom.invalid`,
    phone: `+9200099${String(seat).padStart(2, '0')}${String(index + 1).padStart(3, '0')}`,
    ingredientIds: supplier.ingredients.map((key) => ingredientByKey.get(key)!.id),
    enabled: true,
  }));

  const purchaseOrders: DemoPurchaseOrder[] = Array.from({ length: 20 }, (_, index) => {
    const supplierIndex = index % suppliers.length;
    const supplier = suppliers[supplierIndex]!;
    const supplierSpec = SUPPLIER_SPECS[supplierIndex]!;
    const branch = branches[(index * 2) % branches.length]!;
    const orderedDate = addDate(latestBusinessDate, -59 + index * 3);
    const expectedDate = addDate(orderedDate, 1);
    const orderId = seatId(seat, 'purchase_order', index + 1);
    const lineCount = supplierSpec.ingredients.length >= 6 ? 4 : 3;
    const lines = Array.from({ length: lineCount }, (_, lineIndex) => {
      const key =
        supplierSpec.ingredients[
          (Math.floor(index / suppliers.length) * 3 + lineIndex) % supplierSpec.ingredients.length
        ]!;
      const ingredient = ingredientByKey.get(key)!;
      const quantity =
        ingredient.baseUnit === 'piece'
          ? 48 + Math.floor(random() * 80)
          : round(8 + random() * (ingredient.baseUnit === 'litre' ? 35 : 24));
      const unitCostPkr = round(ingredient.referenceCostPkr * (0.95 + random() * 0.1));
      return {
        id: seatId(seat, 'purchase_order_line', `${index + 1}_${lineIndex + 1}`),
        ingredientId: ingredient.id,
        quantity,
        baseUnit: ingredient.baseUnit,
        unitCostPkr,
        lineTotalPkr: round(quantity * unitCostPkr),
      };
    });
    const receipt: DemoPurchaseReceipt = {
      id: seatId(seat, 'purchase_receipt', index + 1),
      receiptNumber: `KK-S${seat}-GRN-${String(index + 1).padStart(4, '0')}`,
      receivedAt: localTimestamp(expectedDate, 11, 15 + (index % 4) * 10),
      lines: lines.map((line) => ({
        purchaseOrderLineId: line.id,
        ingredientId: line.ingredientId,
        quantity: line.quantity,
        baseUnit: line.baseUnit,
        accepted: true,
      })),
    };

    return {
      id: orderId,
      purchaseOrderNumber: `KK-S${seat}-PO-${orderedDate.replaceAll('-', '')}-${String(
        index + 1
      ).padStart(3, '0')}`,
      branchId: branch.id,
      supplierId: supplier.id,
      orderedAt: localTimestamp(orderedDate, 9, 20),
      expectedAt: localTimestamp(expectedDate, 10),
      status: 'RECEIVED',
      totalPkr: round(lines.reduce((sum, line) => sum + line.lineTotalPkr, 0)),
      lines,
      receipts: [receipt],
    };
  });

  return { suppliers, purchaseOrders };
}

function buildInventoryState(
  seat: number,
  branches: DemoBranch[],
  ingredients: DemoIngredient[],
  firstBusinessDate: string,
  latestBusinessDate: string
): Pick<
  DemoRestaurantSeed['inventory'],
  'stockBalances' | 'stockMovements' | 'stockCounts' | 'lowStockRules'
> {
  const random = mulberry32(RANDOM_SEED ^ 0x1a2b);
  const stockBalances: DemoStockBalance[] = [];
  const stockMovements: DemoStockMovement[] = [];
  const ingredientByKey = new Map(ingredients.map((ingredient) => [ingredient.key, ingredient]));

  for (const [branchIndex, branch] of branches.entries()) {
    for (const [ingredientIndex, ingredient] of ingredients.entries()) {
      const openingQuantity = round(
        ingredient.defaultOpeningQuantity * (0.92 + branchIndex * 0.06 + random() * 0.12)
      );
      const onHandQuantity = round(openingQuantity * (0.38 + random() * 0.34));
      stockBalances.push({
        id: seatId(seat, 'stock_balance', `${branch.key}_${ingredient.key}`),
        branchId: branch.id,
        ingredientId: ingredient.id,
        onHandQuantity,
        baseUnit: ingredient.baseUnit,
        valuedAtPkr: round(onHandQuantity * ingredient.referenceCostPkr),
      });
      stockMovements.push({
        id: seatId(seat, 'stock_movement', `opening_${branch.key}_${ingredientIndex + 1}`),
        branchId: branch.id,
        ingredientId: ingredient.id,
        kind: 'OPENING',
        quantityDelta: openingQuantity,
        baseUnit: ingredient.baseUnit,
        occurredAt: localTimestamp(addDate(firstBusinessDate, -1), 7, 30),
        reason: 'Deterministic demo opening stock',
      });
    }
  }

  const movementSpecs: Array<{
    kind: Exclude<DemoStockMovement['kind'], 'OPENING'>;
    ingredientKeys: string[];
    reasons: string[];
  }> = [
    {
      kind: 'COUNT',
      ingredientKeys: ['tomatoes', 'chicken_bone_in', 'milk', 'basmati_rice', 'bottled_water'],
      reasons: [
        'Weekly count adjustment',
        'Prep-store recount',
        'Cold-room recount',
        'Dry-store recount',
        'Beverage-store recount',
      ],
    },
    {
      kind: 'WASTAGE',
      ingredientKeys: ['tomatoes', 'naan_dough_ball', 'basmati_rice', 'fresh_mint', 'cream'],
      reasons: [
        'Tomato trimming loss',
        'Damaged dough during shaping',
        'Unsold cooked rice',
        'Wilted garnish during prep',
        'Measured cream spill',
      ],
    },
    {
      kind: 'SPOILAGE',
      ingredientKeys: ['yogurt', 'paneer', 'chicken_bone_in', 'milk', 'fresh_coriander'],
      reasons: [
        'Yogurt failed temperature check',
        'Paneer passed use-by time',
        'Chicken rejected at cold-room check',
        'Milk passed use-by time',
        'Coriander quality rejection',
      ],
    },
    {
      kind: 'STAFF_MEAL',
      ingredientKeys: ['chicken_bone_in', 'basmati_rice', 'flour_atta', 'yogurt', 'tea_leaves'],
      reasons: [
        'Approved staff meal protein',
        'Approved staff meal rice',
        'Approved staff meal bread',
        'Approved staff meal raita',
        'Approved staff tea',
      ],
    },
  ];

  for (const [branchIndex, branch] of branches.entries()) {
    for (const [kindIndex, spec] of movementSpecs.entries()) {
      spec.ingredientKeys.forEach((key, itemIndex) => {
        const ingredient = ingredientByKey.get(key)!;
        const magnitude =
          ingredient.baseUnit === 'piece'
            ? 1 + ((branchIndex + itemIndex) % 3)
            : round(0.2 + ((branchIndex + itemIndex) % 4) * 0.15);
        const direction = spec.kind === 'COUNT' && itemIndex % 2 === 0 ? 1 : -1;
        stockMovements.push({
          id: seatId(
            seat,
            'stock_movement',
            `${spec.kind.toLowerCase()}_${branch.key}_${itemIndex + 1}`
          ),
          branchId: branch.id,
          ingredientId: ingredient.id,
          kind: spec.kind,
          quantityDelta: round(direction * magnitude),
          baseUnit: ingredient.baseUnit,
          occurredAt: localTimestamp(
            addDate(latestBusinessDate, -13 + kindIndex * 3 + itemIndex),
            16 + (itemIndex % 4),
            10
          ),
          reason: spec.reasons[itemIndex]!,
        });
      });
    }
  }

  const lowStockIngredientKeys = [
    'chicken_bone_in',
    'mutton_bone_in',
    'basmati_rice',
    'cooking_oil',
  ];
  const lowStockRules: DemoLowStockRule[] = [];
  for (const branch of branches) {
    lowStockIngredientKeys.forEach((key, index) => {
      const ingredient = ingredientByKey.get(key)!;
      const thresholdQuantity = ingredient.baseUnit === 'litre' ? 12 : index < 2 ? 10 : 18;
      const triggered = index === 0;
      const currentQuantity = round(thresholdQuantity * (triggered ? 0.45 : 1.55));
      const balance = stockBalances.find(
        (item) => item.branchId === branch.id && item.ingredientId === ingredient.id
      )!;
      balance.onHandQuantity = currentQuantity;
      balance.valuedAtPkr = round(currentQuantity * ingredient.referenceCostPkr);
      lowStockRules.push({
        id: seatId(seat, 'low_stock_rule', `${branch.key}_${key}`),
        branchId: branch.id,
        ingredientId: ingredient.id,
        thresholdQuantity,
        currentQuantity,
        baseUnit: ingredient.baseUnit,
        triggered,
      });
    });
  }

  const stockCounts: DemoStockCount[] = branches.map((branch, branchIndex) => ({
    id: seatId(seat, 'stock_count', branch.key),
    branchId: branch.id,
    countedAt: localTimestamp(addDate(latestBusinessDate, -6 + branchIndex), 8, 15),
    status: 'POSTED',
    lines: ingredients.map((ingredient, ingredientIndex) => {
      const balance = stockBalances.find(
        (item) => item.branchId === branch.id && item.ingredientId === ingredient.id
      )!;
      const varianceQuantity =
        ingredient.baseUnit === 'piece'
          ? ((ingredientIndex + branchIndex) % 5) - 2
          : round((((ingredientIndex + branchIndex) % 5) - 2) * 0.1);
      return {
        ingredientId: ingredient.id,
        expectedQuantity: round(balance.onHandQuantity - varianceQuantity),
        countedQuantity: balance.onHandQuantity,
        varianceQuantity,
        baseUnit: ingredient.baseUnit,
      };
    }),
  }));

  return { stockBalances, stockMovements, stockCounts, lowStockRules };
}

function buildCustomers(seat: number, today: string): DemoCustomer[] {
  const firstNames = [
    'Ayesha',
    'Bilal',
    'Hira',
    'Hamza',
    'Sana',
    'Usman',
    'Maham',
    'Ali',
    'Zainab',
    'Fahad',
    'Iqra',
    'Saad',
    'Mehwish',
    'Danish',
    'Rabia',
    'Omar',
    'Amna',
    'Taha',
    'Noor',
    'Sameer',
  ];
  const lastNames = [
    'Ahmed',
    'Khan',
    'Malik',
    'Sheikh',
    'Raza',
    'Siddiqui',
    'Butt',
    'Qureshi',
    'Iqbal',
    'Farooq',
  ];

  return Array.from({ length: 200 }, (_, index) => {
    const visits = 2 + ((index * 7) % 43);
    const points = 80 + visits * 37 + ((index * 19) % 200);
    return {
      id: seatId(seat, 'customer', index + 1),
      name: `${firstNames[index % firstNames.length]} ${lastNames[Math.floor(index / 20)]}`,
      email: `customer.s${seat}.${String(index + 1).padStart(3, '0')}@demo.devfathom.invalid`,
      phone: `+92000${String(seat).padStart(2, '0')}${String(index + 1).padStart(5, '0')}`,
      joinedAt: localTimestamp(addDate(today, -(30 + ((index * 13) % 330))), 12),
      points,
      visitCount: visits,
      tier: points >= 1_500 ? 'GOLD' : points >= 750 ? 'SILVER' : 'GREEN',
      marketingConsent: index % 3 !== 0,
      isSynthetic: true,
    };
  });
}

function buildWorkforce(
  seat: number,
  branches: DemoBranch[],
  today: string
): DemoRestaurantSeed['workforce'] {
  const staffNames = [
    'Ayesha Khan',
    'Bilal Ahmed',
    'Sana Iqbal',
    'Hamza Malik',
    'Hira Raza',
    'Usman Qureshi',
    'Maham Siddiqui',
    'Ali Farooq',
    'Zainab Sheikh',
    'Fahad Butt',
  ];
  const roles: DemoStaff['role'][] = [
    'BRANCH_MANAGER',
    'SHIFT_SUPERVISOR',
    'CASHIER',
    'CASHIER',
    'SERVER',
    'SERVER',
    'SERVER',
    'COOK',
    'COOK',
    'COOK',
  ];
  const shifts = [
    [10, 18],
    [16, 24],
    [11, 19],
    [16, 24],
    [11, 19],
    [14, 22],
    [16, 24],
    [10, 18],
    [14, 22],
    [16, 24],
  ] as const;
  const staff: DemoStaff[] = [];
  const roster: DemoRosterShift[] = [];

  branches.forEach((branch, branchIndex) => {
    roles.forEach((role, staffIndex) => {
      const id = seatId(seat, 'staff', `${branch.key}_${staffIndex + 1}`);
      staff.push({
        id,
        branchId: branch.id,
        name: `${staffNames[staffIndex]} ${branchIndex + 1}`,
        role,
        email: `staff.s${seat}.${branch.key}.${staffIndex + 1}@demo.devfathom.invalid`,
        phone: `+92001${String(seat).padStart(2, '0')}${String(branchIndex + 1)}${String(
          staffIndex + 1
        ).padStart(4, '0')}`,
        isSynthetic: true,
      });

      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
        const businessDate = addDate(today, dayIndex);
        roster.push({
          id: seatId(seat, 'roster', `${branch.key}_${staffIndex + 1}_${dayIndex + 1}`),
          branchId: branch.id,
          staffId: id,
          role,
          businessDate,
          startsAt: localTimestamp(businessDate, shifts[staffIndex]![0]),
          endsAt: localTimestamp(businessDate, shifts[staffIndex]![1]),
        });
      }
    });
  });

  return { staff, roster };
}

function buildPromotion(seat: number, branches: DemoBranch[], today: string): DemoPromotion {
  return {
    id: seatId(seat, 'promotion', 'karahi_family_10'),
    name: 'Karahi Family Table 10%',
    code: 'KARAHI10',
    status: 'RUNNING',
    percentageOff: 10,
    minimumSpendPkr: 2_500,
    startsAt: localTimestamp(addDate(today, -14), 0),
    endsAt: localTimestamp(addDate(today, 30), 23, 59),
    branchIds: branches.map((branch) => branch.id),
  };
}

function buildHistoricalSales(
  seat: number,
  branches: DemoBranch[],
  menu: DemoRestaurantSeed['menu'],
  customers: DemoCustomer[],
  promotion: DemoPromotion,
  businessDates: string[],
  staff: DemoStaff[]
): Pick<
  DemoRestaurantSeed['sales'],
  'historicalOrders' | 'bills' | 'settlements' | 'refunds' | 'dailyCloses'
> {
  const random = mulberry32(RANDOM_SEED);
  const historicalOrders: DemoHistoricalOrder[] = [];
  const bills: DemoBill[] = [];
  const settlements: DemoSettlement[] = [];
  const refunds: DemoRefund[] = [];
  const dailyCloses: DemoDailyClose[] = [];
  const modifierById = new Map(menu.modifierGroups.map((group) => [group.id, group]));
  const hourWeights = [
    [11, 3],
    [12, 7],
    [13, 12],
    [14, 8],
    [15, 4],
    [18, 8],
    [19, 15],
    [20, 20],
    [21, 16],
    [22, 6],
    [23, 1],
  ] as Array<[number, number]>;
  const channels: Array<[DemoHistoricalOrder['channel'], number]> = [
    ['DINE_IN', 58],
    ['TAKEAWAY', 24],
    ['DELIVERY', 18],
  ];
  let orderOrdinal = 0;
  let settlementOrdinal = 0;
  let refundOrdinal = 0;

  for (const [dateIndex, businessDate] of businessDates.entries()) {
    const dayOfWeek = new Date(`${businessDate}T00:00:00.000Z`).getUTCDay();
    const multiplier = dayOfWeek === 5 ? 1.45 : dayOfWeek === 6 ? 1.3 : dayOfWeek === 0 ? 1.15 : 1;

    for (const [branchIndex, branch] of branches.entries()) {
      const orderCount = Math.round([6, 5, 6][branchIndex]! * multiplier);
      let grossSalesPkr = 0;
      let refundsPkr = 0;
      let cashPkr = 0;
      let cardPkr = 0;
      let splitTenderOrderCount = 0;

      for (let branchOrderIndex = 0; branchOrderIndex < orderCount; branchOrderIndex += 1) {
        orderOrdinal += 1;
        const orderId = seatId(seat, 'order', orderOrdinal);
        const hour = pickWeighted(random, hourWeights, (item) => item[1])[0];
        const minute = Math.floor(random() * 60);
        const placedAt = localTimestamp(businessDate, hour, minute);
        const channel = pickWeighted(random, channels, (item) => item[1])[0];
        const lineCountRoll = random();
        const lineCount =
          lineCountRoll < 0.12 ? 1 : lineCountRoll < 0.72 ? 2 : lineCountRoll < 0.94 ? 3 : 4;
        const lines: DemoOrderLine[] = Array.from({ length: lineCount }, (_, lineIndex) => {
          const product = pickWeighted(random, menu.products, (item) => item.popularityWeight);
          const variant = product.variants[Math.floor(random() * product.variants.length)]!;
          const modifiers: DemoOrderModifier[] = [];
          for (const modifierGroupId of product.modifierGroupIds) {
            const group = modifierById.get(modifierGroupId)!;
            if (group.required || random() < 0.38) {
              const option = group.options[Math.floor(random() * group.options.length)]!;
              modifiers.push({
                modifierGroupId: group.id,
                optionId: option.id,
                name: option.name,
                pricePkr: option.pricePkr,
              });
            }
          }
          const quantity = random() < 0.12 ? 2 : 1;
          const unitPricePkr =
            variant.pricePkr + modifiers.reduce((sum, item) => sum + item.pricePkr, 0);
          return {
            id: seatId(seat, 'order_line', `${orderOrdinal}_${lineIndex + 1}`),
            productId: product.id,
            variantId: variant.id,
            name: product.name,
            variantName: variant.name,
            quantity,
            unitPricePkr,
            lineTotalPkr: unitPricePkr * quantity,
            modifiers,
          };
        });
        const subtotalPkr = lines.reduce((sum, line) => sum + line.lineTotalPkr, 0);
        const usesPromotion = orderOrdinal % 20 === 0 && subtotalPkr >= promotion.minimumSpendPkr;
        const discountPkr = usesPromotion ? Math.round(subtotalPkr * 0.1) : 0;
        const serviceChargePkr =
          channel === 'DINE_IN' ? Math.round((subtotalPkr - discountPkr) * 0.05) : 0;
        const taxPkr = Math.round((subtotalPkr - discountPkr + serviceChargePkr) * 0.16);
        const totalPkr = subtotalPkr - discountPkr + serviceChargePkr + taxPkr;
        const customer =
          random() < 0.78 ? customers[Math.floor(random() * customers.length)]! : null;
        const tables = branch.floors.flatMap((floor) => floor.tables);
        const table = channel === 'DINE_IN' ? tables[Math.floor(random() * tables.length)]! : null;
        const completedAt = shiftIso(placedAt, 24 + Math.floor(random() * 34));
        const order: DemoHistoricalOrder = {
          id: orderId,
          orderNumber: `KK-S${seat}-${businessDate.replaceAll('-', '')}-${branchIndex + 1}-${String(
            branchOrderIndex + 1
          ).padStart(3, '0')}`,
          branchId: branch.id,
          businessDate,
          placedAt,
          completedAt,
          localHour: hour,
          channel,
          status: 'CLOSED',
          customerId: customer?.id ?? null,
          tableId: table?.id ?? null,
          promotionId: usesPromotion ? promotion.id : null,
          subtotalPkr,
          discountPkr,
          serviceChargePkr,
          taxPkr,
          totalPkr,
          lines,
        };
        historicalOrders.push(order);

        const billId = seatId(seat, 'bill', orderOrdinal);
        const refundable = orderOrdinal % 113 === 0;
        bills.push({
          id: billId,
          orderId,
          status: refundable ? 'PARTIALLY_REFUNDED' : 'SETTLED',
          subtotalPkr,
          discountPkr,
          serviceChargePkr,
          taxPkr,
          totalPkr,
          settledAt: completedAt,
        });

        const splitTender = orderOrdinal % 17 === 0;
        const orderSettlements: DemoSettlement[] = [];
        if (splitTender) {
          splitTenderOrderCount += 1;
          const cashAmount = Math.floor((totalPkr * 0.42) / 10) * 10;
          const amounts: Array<['CASH' | 'CARD', number]> = [
            ['CASH', cashAmount],
            ['CARD', totalPkr - cashAmount],
          ];
          for (const [method, amountPkr] of amounts) {
            settlementOrdinal += 1;
            orderSettlements.push({
              id: seatId(seat, 'settlement', settlementOrdinal),
              orderId,
              billId,
              method,
              provider: 'MOCK',
              amountPkr,
              status: 'CAPTURED',
              externalReference: `MOCK-S${seat}-${String(settlementOrdinal).padStart(7, '0')}`,
              settledAt: completedAt,
            });
          }
        } else {
          settlementOrdinal += 1;
          const method: 'CASH' | 'CARD' =
            random() < (channel === 'DELIVERY' ? 0.28 : 0.57) ? 'CASH' : 'CARD';
          orderSettlements.push({
            id: seatId(seat, 'settlement', settlementOrdinal),
            orderId,
            billId,
            method,
            provider: 'MOCK',
            amountPkr: totalPkr,
            status: 'CAPTURED',
            externalReference: `MOCK-S${seat}-${String(settlementOrdinal).padStart(7, '0')}`,
            settledAt: completedAt,
          });
        }
        settlements.push(...orderSettlements);
        cashPkr += orderSettlements
          .filter((settlement) => settlement.method === 'CASH')
          .reduce((sum, settlement) => sum + settlement.amountPkr, 0);
        cardPkr += orderSettlements
          .filter((settlement) => settlement.method === 'CARD')
          .reduce((sum, settlement) => sum + settlement.amountPkr, 0);
        grossSalesPkr += totalPkr;

        if (refundable) {
          refundOrdinal += 1;
          const settlement =
            orderSettlements.find((item) => item.method === 'CARD') ?? orderSettlements[0]!;
          const amountPkr = Math.max(100, Math.round(totalPkr * 0.25));
          refundsPkr += amountPkr;
          refunds.push({
            id: seatId(seat, 'refund', refundOrdinal),
            orderId,
            billId,
            settlementId: settlement.id,
            amountPkr,
            provider: 'MOCK',
            status: 'COMPLETED',
            reason: 'Demo guest item-quality adjustment',
            refundedAt: shiftIso(completedAt, 18),
          });
        }
      }

      const closeId = seatId(seat, 'daily_close', `${businessDate}_${branch.key}`);
      const approver = staff.find(
        (person) => person.branchId === branch.id && person.role === 'BRANCH_MANAGER'
      )!;
      const hasCorrection = (dateIndex + branchIndex * 7) % 43 === 0;
      dailyCloses.push({
        id: closeId,
        branchId: branch.id,
        businessDate,
        closedAt: localTimestamp(businessDate, 23, 50),
        status: 'CLOSED',
        orderCount,
        splitTenderOrderCount,
        grossSalesPkr,
        refundsPkr,
        netSalesPkr: grossSalesPkr - refundsPkr,
        cashPkr,
        cardPkr,
        corrections: hasCorrection
          ? [
              {
                id: seatId(seat, 'daily_close_correction', `${businessDate}_${branch.key}`),
                sequence: 1,
                reason: 'Supervisor-approved cash drawer recount',
                cashDeltaPkr: dateIndex % 2 === 0 ? 500 : -500,
                approvedByStaffId: approver.id,
                createdAt: localTimestamp(addDate(businessDate, 1), 9, 15),
              },
            ]
          : [],
      });
    }
  }

  return { historicalOrders, bills, settlements, refunds, dailyCloses };
}

function makeLiveLine(
  seat: number,
  orderKey: string,
  product: DemoMenuProduct,
  modifierGroups: DemoModifierGroup[]
): DemoOrderLine {
  const variant = product.variants[0]!;
  const firstGroup = modifierGroups.find((group) => product.modifierGroupIds.includes(group.id));
  const option =
    firstGroup?.options.find((item) => item.key === 'medium') ?? firstGroup?.options[0];
  const modifiers: DemoOrderModifier[] =
    firstGroup && option
      ? [
          {
            modifierGroupId: firstGroup.id,
            optionId: option.id,
            name: option.name,
            pricePkr: option.pricePkr,
          },
        ]
      : [];
  const unitPricePkr = variant.pricePkr + modifiers.reduce((sum, item) => sum + item.pricePkr, 0);
  return {
    id: seatId(seat, 'live_order_line', orderKey),
    productId: product.id,
    variantId: variant.id,
    name: product.name,
    variantName: variant.name,
    quantity: 1,
    unitPricePkr,
    lineTotalPkr: unitPricePkr,
    modifiers,
  };
}

function buildLiveSales(
  seat: number,
  now: Date,
  branches: DemoBranch[],
  menu: DemoRestaurantSeed['menu']
): Pick<DemoRestaurantSeed['sales'], 'liveOrders' | 'kdsTickets'> {
  const kdsProduct = menu.products.find((product) => product.key === 'chicken_karahi')!;
  const paymentProduct = menu.products.find((product) => product.key === 'malai_boti')!;
  const kdsLine = makeLiveLine(seat, 'kds_1', kdsProduct, menu.modifierGroups);
  const paymentLine = makeLiveLine(seat, 'payment_1', paymentProduct, menu.modifierGroups);
  const kdsOrderId = seatId(seat, 'live_order', 'kds');
  const paymentOrderId = seatId(seat, 'live_order', 'payment_pending');

  const createLiveOrder = (
    id: string,
    branch: DemoBranch,
    line: DemoOrderLine,
    status: DemoLiveOrder['status'],
    openedMinutesAgo: number
  ): DemoLiveOrder => {
    const candidateOpenedAt = new Date(now.getTime() - openedMinutesAgo * 60_000);
    const openedAt =
      resolveBusinessDate(candidateOpenedAt, DEMO_TIME_ZONE, '05:00') ===
      resolveBusinessDate(now, DEMO_TIME_ZONE, '05:00')
        ? candidateOpenedAt
        : now;
    const subtotalPkr = line.lineTotalPkr;
    const serviceChargePkr = Math.round(subtotalPkr * 0.05);
    const taxPkr = Math.round((subtotalPkr + serviceChargePkr) * 0.16);
    const totalPkr = subtotalPkr + serviceChargePkr + taxPkr;
    return {
      id,
      orderNumber: `KK-S${seat}-LIVE-${status === 'PAYMENT_PENDING' ? 'PAY' : 'KDS'}`,
      branchId: branch.id,
      tableId: branch.floors[0]!.tables[0]!.id,
      channel: 'DINE_IN',
      status,
      openedAt: openedAt.toISOString(),
      subtotalPkr,
      discountPkr: 0,
      serviceChargePkr,
      taxPkr,
      totalPkr,
      lines: [line],
      bill: {
        id: seatId(seat, 'live_bill', status === 'PAYMENT_PENDING' ? 'payment' : 'kds'),
        status: status === 'PAYMENT_PENDING' ? 'PAYMENT_PENDING' : 'OPEN',
        totalPkr,
      },
    };
  };

  return {
    liveOrders: [
      createLiveOrder(kdsOrderId, branches[0]!, kdsLine, 'IN_PREPARATION', 8),
      createLiveOrder(paymentOrderId, branches[0]!, paymentLine, 'PAYMENT_PENDING', 4),
    ],
    kdsTickets: [
      {
        id: seatId(seat, 'kds_ticket', 'sent'),
        orderId: kdsOrderId,
        branchId: branches[0]!.id,
        status: 'SENT',
        station: 'HOT_KITCHEN',
        sentAt: new Date(now.getTime() - 7 * 60_000).toISOString(),
        priority: 'NORMAL',
        orderLineIds: [kdsLine.id],
      },
    ],
  };
}

function buildOperations(
  seat: number,
  branches: DemoBranch[],
  staff: DemoStaff[],
  lowStockRules: DemoLowStockRule[],
  purchaseOrders: DemoPurchaseOrder[],
  dailyCloses: DemoDailyClose[],
  today: string
): DemoRestaurantSeed['operations'] {
  const sopTemplates: DemoSopTemplate[] = SOP_SPECS.map((template) => ({
    id: seatId(seat, 'sop_template', template.key),
    key: template.key,
    name: template.name,
    enabled: true,
    steps: template.steps.map((instruction, index) => ({
      id: seatId(seat, 'sop_step', `${template.key}_${index + 1}`),
      position: index + 1,
      instruction,
      evidenceRequired: index === template.steps.length - 1,
    })),
  }));
  const sopOccurrences: DemoSopOccurrence[] = [];
  const sopEvidence: DemoSopEvidence[] = [];

  sopTemplates.forEach((template, templateIndex) => {
    branches.forEach((branch, branchIndex) => {
      const assignee = staff.find(
        (person) => person.branchId === branch.id && person.role === 'SHIFT_SUPERVISOR'
      )!;
      const occurrenceId = seatId(seat, 'sop_occurrence', `${template.key}_${branch.key}`);
      const scheduledFor = localTimestamp(
        addDate(today, -(templateIndex + branchIndex)),
        9 + templateIndex * 6
      );
      sopOccurrences.push({
        id: occurrenceId,
        templateId: template.id,
        branchId: branch.id,
        assignedStaffId: assignee.id,
        scheduledFor,
        status: 'COMPLETED',
        completedAt: shiftIso(scheduledFor, 35 + branchIndex * 4),
      });
      const evidenceStep = template.steps[template.steps.length - 1]!;
      sopEvidence.push({
        id: seatId(seat, 'sop_evidence', `${template.key}_${branch.key}`),
        occurrenceId,
        stepId: evidenceStep.id,
        kind: 'NOTE',
        value: `Synthetic demo evidence: ${template.name} completed and supervisor signed off.`,
        capturedAt: shiftIso(scheduledFor, 30 + branchIndex * 4),
        isSynthetic: true,
      });
    });
  });

  const notifications: DemoNotification[] = [];
  branches.forEach((branch, branchIndex) => {
    const manager = staff.find(
      (person) => person.branchId === branch.id && person.role === 'BRANCH_MANAGER'
    )!;
    const lowStockRule = lowStockRules.find(
      (rule) => rule.branchId === branch.id && rule.triggered
    )!;
    const purchaseOrder = purchaseOrders.find((order) => order.branchId === branch.id)!;
    const correctedClose = dailyCloses.find(
      (close) => close.branchId === branch.id && close.corrections.length > 0
    )!;
    const occurrence = sopOccurrences.find((item) => item.branchId === branch.id)!;
    const notificationSpecs: Array<{
      type: DemoNotification['type'];
      title: string;
      body: string;
      subjectId: string;
    }> = [
      {
        type: 'LOW_STOCK',
        title: 'Chicken stock below threshold',
        body: 'On-hand quantity is below the configured reorder threshold.',
        subjectId: lowStockRule.id,
      },
      {
        type: 'PURCHASE_RECEIVED',
        title: 'Purchase receipt posted',
        body: `${purchaseOrder.purchaseOrderNumber} has a complete receipt history.`,
        subjectId: purchaseOrder.id,
      },
      {
        type: 'DAILY_CLOSE_CORRECTED',
        title: 'Daily close correction approved',
        body: 'Supervisor cash recount is recorded in the correction chain.',
        subjectId: correctedClose.id,
      },
      {
        type: 'SOP_COMPLETED',
        title: 'Opening SOP completed',
        body: 'Required checklist evidence was captured.',
        subjectId: occurrence.id,
      },
    ];
    notificationSpecs.forEach((item, index) => {
      notifications.push({
        id: seatId(seat, 'notification', `${branch.key}_${index + 1}`),
        branchId: branch.id,
        recipientStaffId: manager.id,
        ...item,
        createdAt: localTimestamp(
          addDate(today, index === 0 ? 0 : -index),
          8 + index * 3,
          branchIndex * 5
        ),
        read: index > 1,
      });
    });
  });

  return { sopTemplates, sopOccurrences, sopEvidence, notifications };
}

export function buildDemoRestaurantSeed(now: Date = new Date(), seat = 1): DemoRestaurantSeed {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const identity = demoSeatIdentity(seat);
  const today = resolveBusinessDate(now, DEMO_TIME_ZONE, '05:00');
  const latestBusinessDate = addDate(today, -1);
  const historicalBusinessDates = Array.from({ length: 90 }, (_, index) =>
    addDate(latestBusinessDate, index - 89)
  );
  const branches = buildBranches(seat);
  const menu = buildMenu(seat);
  const ingredients = buildIngredients(seat);
  const recipes = buildRecipes(seat, menu.products, ingredients);
  const purchasing = buildPurchasing(seat, branches, ingredients, latestBusinessDate);
  const inventoryState = buildInventoryState(
    seat,
    branches,
    ingredients,
    historicalBusinessDates[0]!,
    latestBusinessDate
  );
  const customers = buildCustomers(seat, today);
  const workforce = buildWorkforce(seat, branches, today);
  const promotion = buildPromotion(seat, branches, today);
  const historicalSales = buildHistoricalSales(
    seat,
    branches,
    menu,
    customers,
    promotion,
    historicalBusinessDates,
    workforce.staff
  );
  const liveSales = buildLiveSales(seat, now, branches, menu);
  const operations = buildOperations(
    seat,
    branches,
    workforce.staff,
    inventoryState.lowStockRules,
    purchasing.purchaseOrders,
    historicalSales.dailyCloses,
    today
  );

  return {
    identity,
    generatedAt: now.toISOString(),
    timeZone: DEMO_TIME_ZONE,
    currency: DEMO_CURRENCY,
    brand: { id: seatId(seat, 'brand', 'karahi_khaas'), name: 'Karahi Khaas' },
    historicalBusinessDates,
    branches,
    menu,
    inventory: {
      unitConversions: [
        {
          fromUnit: 'g',
          fromName: 'gram',
          toUnit: 'kg',
          toName: 'kilogram',
          factor: 0.001,
        },
        {
          fromUnit: 'ml',
          fromName: 'millilitre',
          toUnit: 'litre',
          toName: 'litre',
          factor: 0.001,
        },
        {
          fromUnit: 'piece',
          fromName: 'piece',
          toUnit: 'piece',
          toName: 'piece',
          factor: 1,
        },
      ],
      ingredients,
      recipes,
      ...inventoryState,
    },
    purchasing,
    sales: { ...historicalSales, ...liveSales },
    loyalty: { customers, promotions: [promotion] },
    workforce,
    operations,
  };
}

export function demoRestaurantSeedCounts(seed: DemoRestaurantSeed): DemoSeedCounts {
  const settlementCountByOrder = new Map<string, number>();
  seed.sales.settlements.forEach((settlement) =>
    settlementCountByOrder.set(
      settlement.orderId,
      (settlementCountByOrder.get(settlement.orderId) ?? 0) + 1
    )
  );

  return {
    branches: seed.branches.length,
    floors: seed.branches.reduce((sum, branch) => sum + branch.floors.length, 0),
    tables: seed.branches.reduce(
      (sum, branch) =>
        sum + branch.floors.reduce((floorSum, floor) => floorSum + floor.tables.length, 0),
      0
    ),
    modifierGroups: seed.menu.modifierGroups.length,
    modifierOptions: seed.menu.modifierGroups.reduce((sum, group) => sum + group.options.length, 0),
    products: seed.menu.products.length,
    ingredients: seed.inventory.ingredients.length,
    recipes: seed.inventory.recipes.length,
    recipeLines: seed.inventory.recipes.reduce((sum, recipe) => sum + recipe.lines.length, 0),
    suppliers: seed.purchasing.suppliers.length,
    purchaseOrders: seed.purchasing.purchaseOrders.length,
    purchaseReceipts: seed.purchasing.purchaseOrders.reduce(
      (sum, order) => sum + order.receipts.length,
      0
    ),
    stockBalances: seed.inventory.stockBalances.length,
    stockMovements: seed.inventory.stockMovements.length,
    stockCounts: seed.inventory.stockCounts.length,
    stockCountLines: seed.inventory.stockCounts.reduce((sum, count) => sum + count.lines.length, 0),
    lowStockRules: seed.inventory.lowStockRules.length,
    triggeredLowStockRules: seed.inventory.lowStockRules.filter((rule) => rule.triggered).length,
    historicalBusinessDates: seed.historicalBusinessDates.length,
    historicalOrders: seed.sales.historicalOrders.length,
    historicalOrderLines: seed.sales.historicalOrders.reduce(
      (sum, order) => sum + order.lines.length,
      0
    ),
    bills: seed.sales.bills.length,
    settlements: seed.sales.settlements.length,
    splitTenderOrders: [...settlementCountByOrder.values()].filter((count) => count > 1).length,
    refunds: seed.sales.refunds.length,
    dailyCloses: seed.sales.dailyCloses.length,
    dailyCloseCorrections: seed.sales.dailyCloses.reduce(
      (sum, close) => sum + close.corrections.length,
      0
    ),
    liveOrders: seed.sales.liveOrders.length,
    kdsTickets: seed.sales.kdsTickets.length,
    loyaltyCustomers: seed.loyalty.customers.length,
    promotions: seed.loyalty.promotions.length,
    staff: seed.workforce.staff.length,
    rosterShifts: seed.workforce.roster.length,
    sopTemplates: seed.operations.sopTemplates.length,
    sopSteps: seed.operations.sopTemplates.reduce(
      (sum, template) => sum + template.steps.length,
      0
    ),
    sopOccurrences: seed.operations.sopOccurrences.length,
    sopEvidence: seed.operations.sopEvidence.length,
    notifications: seed.operations.notifications.length,
  };
}
