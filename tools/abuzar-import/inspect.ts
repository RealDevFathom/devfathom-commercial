import { readPreparedExport, sourceReport } from './prepared';

async function main() {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3)
    throw new Error('Usage: tsx tools/abuzar-import/inspect.ts <prepared-directory>');
  console.log(JSON.stringify(sourceReport(await readPreparedExport(directory)), null, 2));
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error && !('issues' in error) && !(error instanceof SyntaxError)
      ? error.message
      : 'Invalid prepared export manifest.'
  );
  process.exitCode = 1;
});
