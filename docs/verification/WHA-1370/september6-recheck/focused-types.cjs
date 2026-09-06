const ts = require(process.cwd() + '/node_modules/typescript');
const path = require('node:path');
const files = require('./map.json').map(x => path.resolve(x.file));
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram([...files, path.resolve('vitest.setup.ts')], {...parsed.options, incremental:false, noEmit:true});
const diagnostics = [...(config.error ? [config.error] : []), ...parsed.errors, ...program.getOptionsDiagnostics(), ...files.flatMap(file => { const source = program.getSourceFile(file); if (!source) throw Error('Missing source: ' + file); return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]; })];
console.log(JSON.stringify({scope:files, diagnostics:diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), count:diagnostics.length}, null, 2));
process.exitCode = diagnostics.length ? 1 : 0;
