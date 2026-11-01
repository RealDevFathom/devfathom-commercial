/**
 * The liveness probe: this process is up and answering HTTP. It reads nothing.
 *
 * A load balancer health check decides which tasks the orchestrator replaces,
 * not only where traffic goes, so it must not fail for a reason every task
 * shares. `/api/ready` reads the database: during a failover, a maintenance
 * window or a migration that stopped part-way it fails on every task at once,
 * and ECS would then replace healthy processes in a loop while the cause sits
 * in the database. Readiness stays a deploy-time check (docs/deploy/aws.md);
 * `/api/health` proves a connection opens.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
