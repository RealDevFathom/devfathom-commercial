import type { Metadata } from 'next';
import { SubstitutionConsole } from '@/components/pharmacy/dispensing/substitution-console';
export const metadata: Metadata = { title: 'Pharmacy substitution' };
export default function SubstitutionPage() {
  return <SubstitutionConsole />;
}
