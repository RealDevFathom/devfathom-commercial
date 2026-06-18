'use client';

import Link from 'next/link';
import { Key, Shield, Terminal, FileCode } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

export function ApiDocsContent() {
  return (
    <div className="max-w-3xl space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
          API Access
        </h1>
        <p className="text-muted-foreground mt-1.5 text-[15px]">
          Programmatic access to DevFathom for integrations, automation, and AI assistants like
          Claude Code.
        </p>
      </div>

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
          <p>
            Ask an admin to create a token for you, pick the scopes you need (e.g.{' '}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-mono">tasks:read</code>{' '}
            +{' '}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-mono">
              tasks:write
            </code>
            ), and they&apos;ll share the token with you. The full token is shown only once.
          </p>
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
            Returns a Markdown document optimized for LLM agents. Hand the URL + your token to
            Claude Code (or Cursor, or any agent) and it has everything it needs to operate the hub.
          </p>
        </CardContent>
      </Card>

      {/* Step 3 — Use with Claude Code */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-semibold flex items-center gap-2 text-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
              <Terminal className="h-3.5 w-3.5 text-primary" />
            </div>
            3 · Use with Claude Code
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Drop this in a{' '}
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono">CLAUDE.md</code> at the
            root of any project where you want to use the hub:
          </p>
          <pre className="rounded-xl border border-border bg-secondary/50 p-3 text-xs font-mono text-foreground overflow-x-auto">
            {`# DevFathom API

Token: \${DEVFATHOM_TOKEN}
Reference: ${baseUrl}/api/v1/spec

To use the hub, fetch the reference above with the token, then make
authenticated requests against ${baseUrl}/api/v1/* per the spec.

All changes I make are logged as the user this token is bound to.`}
          </pre>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Then export the token and start a session:
          </p>
          <pre className="rounded-xl border border-border bg-secondary/50 p-3 text-xs font-mono text-foreground overflow-x-auto">
            {`export DEVFATHOM_TOKEN="df_..."
claude`}
          </pre>
          <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3 text-[11px] text-blue-600 dark:text-blue-400">
            <strong>Attribution:</strong> The token acts as the user it was bound to. If
            Shehroz&apos;s token creates a task, the activity feed shows &ldquo;Shehroz created task
            X&rdquo; and it counts toward Shehroz&apos;s stats.
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
