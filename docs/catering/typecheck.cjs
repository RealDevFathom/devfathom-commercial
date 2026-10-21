const ts = require(process.cwd() + '/node_modules/typescript');
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent({ ...config.config, include: [], files: [] }, ts.sys, process.cwd());
const files = [
  'src/types/next-auth.d.ts',
  'src/lib/restaurant/catering-money.ts',
  'src/lib/restaurant/catering-money.test.ts',
  'src/lib/restaurant/catering-money.db.test.ts',
  'src/lib/restaurant/catering-operations.test.ts',
  'src/lib/restaurant/catering-operations.ts',
  'src/server/routers/restaurant-catering.ts',
  'src/lib/restaurant/catering-money-routes.ts',
  'src/app/api/restaurant/catering/money/route.ts',
  'src/lib/restaurant/catering-runtime.db.test.ts',
  'src/lib/restaurant/catering-endpoints.db.test.ts',
];
const program = ts.createProgram(files, {
  ...parsed.options,
  noEmit: true,
  incremental: false,
  skipLibCheck: true,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log(
  ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (p) => p,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  })
);
console.log('Scoped root files:', files.join(', '), 'diagnostics:', diagnostics.length);
process.exitCode = diagnostics.length ? 1 : 0;
