import type { Metadata } from 'next';
import { BrandShowcase } from './brand-showcase';

export const metadata: Metadata = {
  title: 'Brand',
  description: 'The DevFathom brand — the mark, colour, typography, and motion principles.',
};

export default function BrandPage() {
  return <BrandShowcase />;
}
