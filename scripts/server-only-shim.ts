// CLI entrypoints run trusted server code outside Next.js, where Next's virtual
// `server-only` module alias is unavailable. The scripts-specific tsconfig maps
// only those CLI executions to this no-op marker; application builds retain
// Next.js's client-import guard.
export {};
