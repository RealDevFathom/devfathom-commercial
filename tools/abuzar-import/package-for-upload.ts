import { readPreparedExport } from './prepared';
import { packageForUpload } from './packages';
async function main() {
  const [input, parent] = process.argv.slice(2);
  if (!input || !parent || process.argv.length !== 4)
    throw new Error(
      'Usage: bun tools/abuzar-import/package-for-upload.ts <prepared-directory> <existing-output-parent>'
    );
  const result = await packageForUpload(await readPreparedExport(input), parent);
  console.log(
    'Prepared the opening package and ' +
      result.historyPackages.length +
      ' history packages in ' +
      result.directory
  );
}
main().catch(() => {
  console.error(
    'Could not package the prepared export. Check its checksums, size and destination permissions.'
  );
  process.exitCode = 1;
});
