async function main() {
  const { default: ts } = await import('typescript');
  const path = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const files = JSON.parse(await readFile(path.join(__dirname, 'map.json'), 'utf8')).map((x) =>
    path.resolve(x.file)
  );
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const program = ts.createProgram([...files, path.resolve('vitest.setup.ts')], {
    ...parsed.options,
    incremental: false,
    noEmit: true,
  });
  const diagnostics = [
    ...(config.error ? [config.error] : []),
    ...parsed.errors,
    ...program.getOptionsDiagnostics(),
    ...files.flatMap((file) => {
      const source = program.getSourceFile(file);
      if (!source) throw Error('Missing source: ' + file);
      return [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source),
      ];
    }),
  ];
  console.log(
    JSON.stringify(
      {
        scope: files,
        diagnostics: diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
        count: diagnostics.length,
      },
      null,
      2
    )
  );
  process.exitCode = diagnostics.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
