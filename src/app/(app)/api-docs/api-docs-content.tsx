import { headers } from 'next/headers';
import Link from 'next/link';
import { Key, Shield, Terminal, FileCode } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';

export async function ApiDocsContent({
  vertical,
}: { vertical?: string | null } = {}) {
  // Task scopes belong to the agency workspace; a pharmacy never licenses them.
  const showTaskScopeExample = vertical !== 'PHARMACY';
  let baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!baseUrl) {
    const headersList = await headers();
    const host = headersList.get('host') ?? 'localhost:3000';
    const protocol = headersList.get('x-forwarded-proto') ?? 'http';
    baseUrl = `${protocol}://${host}`;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        className="mb-0"
        eyebrow="SYSTEM"
        heading="API Access"
        description="Programmatic access to DevFathom for integrations, automation, and AI assistants."
      />

      {/* Step 1 — Get a token */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/10">
              <Key className="h-3.5 w-3.5 text-blue-500" />
            </div>
            1 · Get an API token
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>
            API tokens are issued by an admin from{' '}
            <Link href="/settings" className="text-primary hover:underline">
              Settings → API Tokens
            </Link>
            . Each token is bound to a specific user — every change made with it is logged to the
            activity feed and counted in stats <em>under that user</em>.
          </p>
          {showTaskScopeExample ? (
            <p>
              Ask an admin to create a token for you, pick the scopes you need (e.g.{' '}
              <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-mono">
                tasks:read
              </code>{' '}
              +{' '}
              <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-mono">
                tasks:write
              </code>
              ), and they&apos;ll share the token with you. The full token is shown only once.
            </p>
          ) : (
            <p>
              Ask an admin to create a token for you with the scopes your integration needs, and
              they&apos;ll share the token with you. The full token is shown only once.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Step 2 — Get the full reference */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10">
              <FileCode className="h-3.5 w-3.5 text-emerald-500" />
            </div>
            2 · Fetch the full API reference
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            The full machine-readable spec — every endpoint, every field, every scope, plus common
            workflow recipes — lives at a single URL and requires your token to access:
          </p>
          <pre className="rounded-xl border border-border bg-secondary/50 p-3 text-xs font-mono text-foreground overflow-x-auto">
            {`curl ${baseUrl}/api/v1/spec \\
  -H "Authorization: Bearer df_your_token_here"`}
          </pre>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Returns a Markdown document optimized for automation and AI agents. Hand the URL and
            your token to your integration and it has everything it needs to call the API.
          </p>
        </CardContent>
      </Card>

      {/* Step 3 — Use from an integration */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
              <Terminal className="h-3.5 w-3.5 text-primary" />
            </div>
            3 · Use from an integration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Give your integration or assistant these instructions, for example in its project
            notes:
          </p>
          <pre className="rounded-xl border border-border bg-secondary/50 p-3 text-xs font-mono text-foreground overflow-x-auto">
            {`# DevFathom API

Token: \${DEVFATHOM_TOKEN}
Reference: ${baseUrl}/api/v1/spec

Fetch the reference above with the token, then make
authenticated requests against ${baseUrl}/api/v1/* per the spec.

All changes I make are logged as the user this token is bound to.`}
          </pre>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Then provide the token through an environment variable:
          </p>
          <pre className="rounded-xl border border-border bg-secondary/50 p-3 text-xs font-mono text-foreground overflow-x-auto">
            {`export DEVFATHOM_TOKEN="df_..."`}
          </pre>
          <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3 text-[11px] text-blue-600 dark:text-blue-400">
            <strong>Attribution:</strong> The token acts as the user it was bound to. Every change
            made with a member&apos;s token is recorded in the activity feed under that member.
          </div>
        </CardContent>
      </Card>

      {/* Security */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/10">
              <Shield className="h-3.5 w-3.5 text-violet-500" />
            </div>
            Security
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground leading-relaxed">
          <p>
            Treat tokens like passwords. Never commit them. Store them in env vars or a secrets
            manager.
          </p>
          <p>
            If you suspect a token is exposed, ask an admin to revoke it from{' '}
            <Link href="/settings" className="text-primary hover:underline">
              Settings → API Tokens
            </Link>
            . Revocation is immediate.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
