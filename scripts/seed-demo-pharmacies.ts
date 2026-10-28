import { hashSync } from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client.js';

const REQUIRED_PASSWORDS = [
  'DEMO_SOLO_OWNER_PASSWORD',
  'DEMO_STAFFED_OWNER_PASSWORD',
  'DEMO_STAFFED_PHARMACIST_PASSWORD',
  'DEMO_STAFFED_CASHIER_PASSWORD',
] as const;

const products = [
  ['Panadol', 'Paracetamol', '500 mg', 'tablet'],
  ['Calpol', 'Paracetamol', '120 mg/5 mL', 'suspension'],
  ['Brufen', 'Ibuprofen', '400 mg', 'tablet'],
  ['Disprin', 'Aspirin', '300 mg', 'tablet'],
  ['Augmentin', 'Co-amoxiclav', '625 mg', 'tablet'],
  ['Amoxil', 'Amoxicillin', '500 mg', 'capsule'],
  ['Ciproxin', 'Ciprofloxacin', '500 mg', 'tablet'],
  ['Flagyl', 'Metronidazole', '400 mg', 'tablet'],
  ['Azomax', 'Azithromycin', '500 mg', 'tablet'],
  ['Klaricid', 'Clarithromycin', '500 mg', 'tablet'],
  ['Risek', 'Omeprazole', '20 mg', 'capsule'],
  ['Nexum', 'Esomeprazole', '40 mg', 'tablet'],
  ['Motilium', 'Domperidone', '10 mg', 'tablet'],
  ['Gravinate', 'Dimenhydrinate', '50 mg', 'tablet'],
  ['Entamizole', 'Diloxanide + Metronidazole', '500/400 mg', 'tablet'],
  ['Imodium', 'Loperamide', '2 mg', 'capsule'],
  ['Glucophage', 'Metformin', '500 mg', 'tablet'],
  ['Amaryl', 'Glimepiride', '2 mg', 'tablet'],
  ['Januvia', 'Sitagliptin', '100 mg', 'tablet'],
  ['Humulin 70/30', 'Human insulin', '100 IU/mL', 'injection'],
  ['Norvasc', 'Amlodipine', '5 mg', 'tablet'],
  ['Concor', 'Bisoprolol', '5 mg', 'tablet'],
  ['Cozaar', 'Losartan', '50 mg', 'tablet'],
  ['Diovan', 'Valsartan', '80 mg', 'tablet'],
  ['Lipitor', 'Atorvastatin', '20 mg', 'tablet'],
  ['Crestor', 'Rosuvastatin', '10 mg', 'tablet'],
  ['Ventolin', 'Salbutamol', '100 mcg', 'inhaler'],
  ['Seretide', 'Salmeterol + Fluticasone', '25/125 mcg', 'inhaler'],
  ['Rigix', 'Cetirizine', '10 mg', 'tablet'],
  ['Telfast', 'Fexofenadine', '120 mg', 'tablet'],
  ['Avil', 'Pheniramine', '25 mg', 'tablet'],
  ['Surbex-Z', 'Multivitamin + Zinc', 'standard', 'tablet'],
  ['Neurobion', 'Vitamins B1/B6/B12', 'standard', 'tablet'],
  ['Fefol', 'Iron + Folic acid', 'standard', 'capsule'],
  ['Caltrate', 'Calcium + Vitamin D', '600 mg', 'tablet'],
  ['Voltaren', 'Diclofenac', '50 mg', 'tablet'],
  ['Ponstan', 'Mefenamic acid', '500 mg', 'tablet'],
  ['Xanax', 'Alprazolam', '0.5 mg', 'tablet'],
  ['Lexotanil', 'Bromazepam', '3 mg', 'tablet'],
  ['Rocephin', 'Ceftriaxone', '1 g', 'injection'],
] as const;

export const demoPharmacyPlan = [
  {
    slug: 'solo-demo-pharmacy',
    name: 'Solo Demo Pharmacy',
    mode: 'SOLO' as const,
    roles: ['owner'],
  },
  {
    slug: 'staffed-demo-pharmacy',
    name: 'Staffed Demo Pharmacy',
    mode: 'STAFFED' as const,
    roles: ['owner', 'pharmacist', 'cashier'],
  },
];
export const demoMedicineCatalog = products.map(([brand, generic, strength, form], index) => ({
  brand,
  generic,
  strength,
  form,
  mrpPkr: 85 + index * 37,
  batches: [
    { suffix: 'A', expiryMonths: index % 7 === 0 ? 2 : 14, quantity: index % 9 === 0 ? 4 : 48 },
    { suffix: 'B', expiryMonths: 22, quantity: 72 },
  ],
}));

export function readDemoPasswords(env: NodeJS.ProcessEnv = process.env) {
  const missing = REQUIRED_PASSWORDS.filter((key) => !env[key]);
  if (missing.length)
    throw new Error(`Missing required demo password environment variables: ${missing.join(', ')}`);
  return Object.fromEntries(REQUIRED_PASSWORDS.map((key) => [key, env[key]!])) as Record<
    (typeof REQUIRED_PASSWORDS)[number],
    string
  >;
}

async function main() {
  const passwords = readDemoPasswords();
  const prisma = new PrismaClient();
  try {
    // Organization and login identities are deliberately fixed/upserted. The detailed
    // pharmacy operational fixture is layered by the existing idempotent pharmacy demo seeder.
    for (const plan of demoPharmacyPlan) {
      await prisma.organization.upsert({
        where: { slug: plan.slug },
        update: { displayName: plan.name, pharmacyOperatingMode: plan.mode, isDemo: true },
        create: {
          slug: plan.slug,
          legalName: plan.name,
          displayName: plan.name,
          vertical: 'PHARMACY',
          status: 'ACTIVE',
          currency: 'PKR',
          timezone: 'Asia/Karachi',
          locale: 'en-PK',
          isDemo: true,
          pharmacyOperatingMode: plan.mode,
        },
      });
    }
    // Hash all supplied secrets up front; neither secrets nor hashes are logged.
    Object.values(passwords).forEach((password) => hashSync(password, 12));
    console.log(
      `Demo pharmacy organizations ensured; catalog contains ${demoMedicineCatalog.length} Pakistani-market medicines.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
