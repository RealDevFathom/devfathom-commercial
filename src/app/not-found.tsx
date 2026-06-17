import Link from 'next/link';
import { LogoIcon } from '@/components/brand/logo';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="text-center">
        <LogoIcon className="h-16 w-16 mx-auto opacity-20" variant="auto" />
        <h1 className="font-display text-6xl font-bold text-foreground mt-6">404</h1>
        <p className="mt-2 text-lg text-muted-foreground">Page not found</p>
        <p className="mt-1 text-sm text-muted-foreground">The page you&apos;re looking for doesn&apos;t exist or has been moved.</p>
        <Link
          href="/dashboard"
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-[#FF4C29] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#E63E1C] active:scale-[0.98] transition-all"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}
