"""Audit the deliberately restricted Dockerignore grammar without Docker/network.

Only `**` followed by literal file exceptions is accepted. Docker pattern escapes
are decoded here; glob rules/directories are rejected, keeping membership exact.
Excluded file contents are never opened. --root selects the audited source root.
"""
import argparse
import hashlib
import json
import stat
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


# Parse syntax only: never resolve, load or execute application modules. The
# project's existing TypeScript dependency is required; parser failure denies
# admission. Keep this inline so the source lane remains four files.
IMPORT_SCANNER = r"""
const ts = require('typescript');
const files = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const imports = [], errors = [];
for (const file of files) {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  const line = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const add = (node, spec) => {
    if (spec && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) {
      imports.push({path: file.path, line: line(node), import: spec.text});
    } else {
      errors.push({path: file.path, line: line(node), reason: 'nonliteral-module-reference'});
    }
  };
  for (const diagnostic of source.parseDiagnostics) {
    errors.push({path: file.path,
      line: source.getLineAndCharacterOfPosition(diagnostic.start || 0).line + 1,
      reason: 'source-parse-error', code: diagnostic.code});
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      add(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    } else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
       (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
process.stdout.write(JSON.stringify({imports, errors}));
"""


def scan_imports(files):
    if not files:
        return {'imports': [], 'errors': []}
    try:
        result = subprocess.run(
            ['node', '-e', IMPORT_SCANNER], input=json.dumps(files),
            text=True, capture_output=True, check=True, timeout=60,
            cwd=Path(__file__).resolve().parents[1],
        )
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return {'imports': [], 'errors': [{'reason': 'typescript-parser-unavailable-or-failed'}]}


def decode_literal(pattern):
    result = ''
    while pattern:
        if pattern[0] == '\\' and len(pattern) > 1:
            result += pattern[1]
            pattern = pattern[2:]
        elif pattern[0] in '*?[':
            raise ValueError('Nonliteral allowlist entry')
        else:
            result += pattern[0]
            pattern = pattern[1:]
    p = PurePosixPath(result)
    if p.is_absolute() or '..' in p.parts or str(p) != result or '\\' in result:
        raise ValueError('Unsafe allowlist path')
    return result


def load_allowlist(text):
    rules = [line for line in text.splitlines() if line and not line.startswith('#')]
    if not rules or rules.pop(0) != '**':
        raise ValueError('Default deny required')
    entries = set()
    for rule in rules:
        if not rule.startswith('!'):
            raise ValueError('Only exact file exceptions supported')
        path = decode_literal(rule[1:])
        if path in entries:
            raise ValueError('Duplicate allowlist entry')
        entries.add(path)
    for path in entries:
        if any(str(p) in entries for p in PurePosixPath(path).parents):
            raise ValueError('Directory exceptions would admit descendants')
    return entries


# Exact production routes whose names collide with generic artifact/test terms.
# No directory exception: payload descendants remain prohibited.
SOURCE_ROUTE_EXCEPTIONS = {
    'src/app/api/restaurant/sop/evidence/route.ts',
    'src/app/api/v1/spec/route.ts',
}

# Reviewed payload-free contracts, not a demo-directory exception.
SOURCE_GUARD_EXCEPTIONS = {
    'src/lib/demo/isolation.ts',
    'src/lib/tenancy/demo-identity.ts',
    'src/lib/tenancy/demo-isolation.ts',
}


def category(path):
    if path == 'patches/deepmerge@4.3.1.patch' or path in SOURCE_ROUTE_EXCEPTIONS | SOURCE_GUARD_EXCEPTIONS:
        return 'not-required'

    parts = PurePosixPath(path).parts
    lower = path.lower()
    if any(p.startswith('.env') for p in parts):
        return 'environment'
    if any(p in {'.git', '.agents', '.codex', '.aws', 'node_modules', '.next'} for p in parts):
        return 'local-state'
    if any(re.search(r'(^|[-_.])(test|tests|spec|fixtures?|demo|seed|seeds)([-_.]|$)', p) for p in parts) or 'test-support' in parts:
        return 'test-demo-seed'
    if any(p in {'uploads', 'private-uploads', 'evidence', 'archives', 'dumps'} for p in parts):
        return 'artifacts-uploads'
    if lower.endswith(('.patch', '.log', '.tar', '.gz', '.zip', '.sql', '.pem', '.key', '.p12', '.pfx')) or re.search(r'(^|/)(credentials|secrets?)([./]|$)', lower):
        return 'artifacts-credentials'
    return 'not-required'


def audit(root, entries):
    included, excluded, errors = [], {}, []
    found = set()
    for directory, dirs, files in os.walk(root, followlinks=False):
        # Names only for excluded trees; never traverse local stores or links.
        dirs[:] = [d for d in dirs if d not in {'.git', 'node_modules', '.next'}]
        for name in files + [d for d in dirs if (Path(directory) / d).is_symlink()]:
            p = Path(directory) / name
            rel = p.relative_to(root).as_posix()
            if rel not in entries:
                key = category(rel)
                excluded[key] = excluded.get(key, 0) + 1
                continue
            found.add(rel)
            if any((root / Path(*PurePosixPath(rel).parts[:i])).is_symlink()
                   for i in range(1, len(PurePosixPath(rel).parts) + 1)) or not p.is_file():
                errors.append({'path': rel, 'reason': 'not-regular-file'})
                continue
            if category(rel) != 'not-required':
                errors.append({'path': rel, 'reason': 'prohibited-category'})
                continue
            data = p.read_bytes()
            included.append({'path': rel, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    errors += [{'path': p, 'reason': 'missing'} for p in sorted(entries - found)]
    errors.extend(import_errors(root, included))
    return {'included': sorted(included, key=lambda x: x['path']), 'includedCount': len(included), 'excludedCount': sum(excluded.values()), 'excludedCategories': excluded, 'errors': errors, 'admitted': not errors, 'scope': 'source context only; no image/build/runtime acceptance'}


def import_errors(root, included):
    """Syntax-only local closure, shared by web and pinned initializer sources."""
    errors = []
    sources = []
    for item in included:
        rel = item['path']
        if not rel.endswith(('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts')):
            continue
        sources.append({'path': rel, 'text': (root / rel).read_text()})
    scanned = scan_imports(sources)
    errors.extend(scanned['errors'])
    included_paths = {item['path'] for item in included}
    for reference in scanned['imports']:
        rel, spec = reference['path'], reference['import']
        if spec.startswith('@/'):
            target = 'src/' + spec[2:]
        elif spec.startswith('.'):
            target = os.path.normpath(str(PurePosixPath(rel).parent / spec))
        else:
            continue
        if target.startswith('src/generated/prisma/'):
            continue  # Generated inside Linux builder, never copied from host.
        candidates = [target] + [target + ext for ext in ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '/index.ts', '/index.tsx', '/index.js')]
        # TypeScript source may use emitted JS specifiers (NodeNext convention).
        for emitted, source_exts in {'.js': ('.ts', '.tsx'), '.mjs': ('.mts',), '.cjs': ('.cts',)}.items():
            if target.endswith(emitted):
                candidates.extend(target[:-len(emitted)] + ext for ext in source_exts)
        if not any(c in included_paths for c in candidates):
            errors.append({**reference, 'reason': 'local-import-excluded-or-unresolved'})
    return errors


FROZEN_PRODUCTION_MANIFEST_SHA256 = 'e7ae5ef79fa373354c68be89681541b32cca6142523a3b2a5d299710673ae34e'
INITIALIZER_SOURCE_PINS_SHA256 = '3b801fd6974fa2b774c39255e7bb8fb82f16034539830ddb3f081d1a183d1a16'
FINAL_DATABASE_MANIFEST_SHA256 = 'd4c5a91ff1f51b6c2bc9151e6fff6aa32016d7454e2e487284d3bbdcef74ff50'
SOURCE_PROFILES_SHA256 = 'e2ca19a782c4bde1b617dd3f4740fcf464a0c48e3ca0f869f85ed42d8054fec8'


def validate_pinned_files(root, records, expected):
    """Initializer-only exact pin check; never execute SQL/bootstrap code."""
    errors, included = [], []
    if records != expected:
        return {'included': [], 'errors': [{'reason': 'initializer-manifest-mismatch'}], 'admitted': False}
    for item in records:
        rel = item['path']
        path = PurePosixPath(rel)
        if path.is_absolute() or '..' in path.parts or str(path) != rel:
            errors.append({'path': rel, 'reason': 'unsafe-path'})
            continue
        file = root / rel
        if any((root / Path(*path.parts[:i])).is_symlink() for i in range(1, len(path.parts) + 1)) or not file.is_file():
            errors.append({'path': rel, 'reason': 'not-regular-file'})
            continue
        data = file.read_bytes()
        if (hashlib.sha256(data).hexdigest() != item['sha256'] or len(data) != item['bytes']
                or (stat.S_IMODE(file.stat().st_mode)) != int(item['mode'], 8)):
            errors.append({'path': rel, 'reason': 'pin-mismatch'})
        else:
            included.append(item)
    return {'included': included, 'includedCount': len(included), 'errors': errors, 'admitted': not errors,
            'scope': 'initializer schema/migration bytes only; no executable initializer or DB acceptance'}


def validate_final_database_pins(expected, historical, final):
    """Preserve every historical SQL/lock pin and require the exact final schema/set."""
    if any(item not in expected for item in historical):
        raise ValueError('Historical migration pins changed')
    by_path = {item['path']: item for item in expected}
    if len(by_path) != len(expected):
        raise ValueError('Duplicate initializer source pin')
    if by_path.get('prisma/schema.prisma', {}).get('sha256') != final['schemaSha256']:
        raise ValueError('Final schema pin mismatch')
    approved = {'prisma/migrations/' + item['name'] + '/migration.sql': item['sha256']
                for item in final['migrations']}
    actual = {path: item['sha256'] for path, item in by_path.items()
              if path.startswith('prisma/migrations/') and path.endswith('/migration.sql')}
    if len(approved) != 127 or len(final['migrations']) != 127 or actual != approved:
        raise ValueError('Expected exact approved 127 migration pins')


def selected_root(root):
    # Canonicalize only the caller-selected root, never substitute cwd or a sibling.
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError('Selected root is not a directory')
    return root


def control_file(root, name):
    """Reject traversal and symlink components before reading a control file."""
    raw = Path(name)
    if '..' in raw.parts or '\\' in str(raw):
        raise ValueError('Unsafe control file path')
    path = raw if raw.is_absolute() else root / raw
    try:
        rel = path.relative_to(root)
    except ValueError:
        raise ValueError('Control file must belong to selected root') from None
    if category(rel.as_posix()) != 'not-required':
        raise ValueError('Prohibited control file category')
    if not rel.parts or any((root / Path(*rel.parts[:i])).is_symlink()
                            for i in range(1, len(rel.parts) + 1)):
        raise ValueError('Control file symlink or unsafe path')
    if not path.is_file():
        raise ValueError('Control file must be a regular file')
    return path


def initializer_profile(name):
    # Policy belongs to this trusted tool, not the untrusted audited source tree.
    tooling = Path(__file__).resolve().parents[1]
    data = control_file(tooling, 'source-profiles.json').read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_PROFILES_SHA256:
        raise ValueError('Approved source profile registry mismatch')
    registry = json.loads(data)
    if registry['version'] != 1:
        raise ValueError('Unsupported source profile registry version')
    profile = registry['profiles'].get(name)
    if not profile or profile['kind'] != 'initializer':
        raise ValueError('Unknown or non-initializer source profile')
    return profile


def initializer_audit(root, manifest, profile_name=None):
    root = selected_root(root)
    profile = initializer_profile(profile_name) if profile_name is not None else None
    # Validate every supplied/control path before reading any of their bytes.
    controls = {name: control_file(root, name) for name in [
        'production-source-manifest.json', 'initializer-source-pins.json',
        'prisma/fresh-database-manifest.json', manifest,
        *(['generated-client-manifest.json'] if profile else []),
    ]}
    source = controls['production-source-manifest.json'].read_bytes()
    if hashlib.sha256(source).hexdigest() != FROZEN_PRODUCTION_MANIFEST_SHA256:
        raise ValueError('Frozen production manifest mismatch')
    historical = [i for i in json.loads(source) if i['path'].startswith('prisma/migrations/')]
    if sum(i['path'].endswith('/migration.sql') for i in historical) != 125:
        raise ValueError('Expected all 125 historical migrations')
    pins = controls['initializer-source-pins.json'].read_bytes()
    pins_digest = profile['sourcePinsSha256'] if profile else INITIALIZER_SOURCE_PINS_SHA256
    if hashlib.sha256(pins).hexdigest() != pins_digest:
        raise ValueError('Approved initializer source pins mismatch')
    expected = json.loads(pins)
    final = controls['prisma/fresh-database-manifest.json'].read_bytes()
    if hashlib.sha256(final).hexdigest() != FINAL_DATABASE_MANIFEST_SHA256:
        raise ValueError('Approved final database manifest mismatch')
    validate_final_database_pins(expected, historical, json.loads(final))
    result = validate_pinned_files(root, json.loads(controls[manifest].read_text()), expected)
    if result['admitted']:
        result['errors'].extend(import_errors(root, result['included']))
    if profile:
        generated_data = controls['generated-client-manifest.json'].read_bytes()
        if hashlib.sha256(generated_data).hexdigest() != profile['generatedManifestSha256']:
            raise ValueError('Approved generated client manifest mismatch')
        generated = json.loads(generated_data)
        if (len(expected) != profile['sourceCount'] or len(generated) != 459
                or profile['generatedCount'] != 459 or profile['migrationCount'] != 127
                or json.loads(final)['schemaSha256'] != profile['schemaSha256']
                or any(not item['path'].startswith('src/generated/prisma/') for item in generated)
                or len({item['path'] for item in generated}) != 459):
            raise ValueError('Initializer profile shape mismatch')
        generated_result = validate_pinned_files(root, generated, generated)
        result['errors'].extend(generated_result['errors'])
        result['generatedCount'] = generated_result['includedCount']
        result['profile'] = profile_name
        result['executableManifestSha256'] = profile['executableManifestSha256']
    result['root'] = str(root)
    result['admitted'] = not result['errors']
    result['scope'] = ('initializer source and pinned generated client only; full executable integrity and DB execution remain separate'
                       if profile else 'initializer source bundle and literal closure only; no executable initializer, generated client, runtime adapter or DB acceptance')
    return result


def select_composition(result, composition):
    if composition not in {'existing-demo', 'production-safe'}:
        raise ValueError('Explicit supported composition required')
    result['composition'] = composition
    result['productSelection'] = 'unselected; explicit production-safe is an audit request, not product approval'
    if composition == 'existing-demo':
        result['errors'].append({'reason': 'existing-demo-composition-not-supplied',
                                 'owner': 'packaging source composer',
                                 'detail': 'Restricted AWS context excludes legacy demo payloads; preserve existing deployment default.'})
    result['admitted'] = not result['errors']
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--initializer-profile', help='Trusted initializer identity from source-profiles.json')
    parser.add_argument('--context', choices=['web', 'initializer'], default='web')
    parser.add_argument('--composition', choices=['existing-demo', 'production-safe'], default='existing-demo')
    parser.add_argument('--initializer-manifest', type=Path, default=Path('initializer-context-manifest.json'))
    args = parser.parse_args()
    try:
        root = selected_root(args.root)
        if args.initializer_profile is not None and args.context != 'initializer':
            raise ValueError('Initializer profile requires initializer context')
        if args.context == 'initializer':
            result = initializer_audit(root, args.initializer_manifest, args.initializer_profile)
        else:
            result = select_composition(audit(root, load_allowlist(control_file(root, 'Dockerfile.aws.dockerignore').read_text())), args.composition)
    except (OSError, ValueError, KeyError, TypeError) as error:
        result = {'admitted': False, 'errors': [{'reason': 'invalid-context-input', 'detail': str(error)}]}
    print(json.dumps(result, indent=2))
    sys.exit(0 if result['admitted'] else 1)
