import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Restaurant demo | DevFathom',
  description: 'Enter an isolated DevFathom restaurant demonstration workspace.',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function DemoLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
