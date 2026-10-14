"""Verify an exact offline initializer context against an externally supplied hash.

Integrity check only: this does not authorize execution, baseline values, or DB access.
The manifest is external to the context to avoid a self-referential digest.
"""
import argparse
import hashlib
import json
import stat
from pathlib import Path, PurePosixPath

REQUIRED = {
    'package.json', 'bun.lock', 'prisma/schema.prisma', 'prisma/fresh-database-manifest.json',
    'prisma/fresh-database-runner.ts', 'prisma/fresh-database-adapter.ts',
    'prisma/fresh-database-observer.ts', 'prisma/fresh-database-fingerprint.ts',
    'prisma/fresh-database-baseline.ts', 'prisma/fresh-database-prep.ts',
    'prisma/fresh-database-migrate.config.ts', 'prisma/tsconfig.fresh-database.json',
    'prisma/production-bootstrap.ts', 'prisma/catalog-sync.ts',
    'src/generated/prisma/client.ts', 'node_modules/pg/package.json',
    'node_modules/@prisma/adapter-pg/package.json',
    'node_modules/@prisma/client/package.json', 'node_modules/tsx/package.json',
}


def audit(root, manifest, expected_sha256):
    data = manifest.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        return {'admitted': False, 'errors': ['manifest-hash-mismatch']}
    rows = json.loads(data)
    errors, seen = [], set()
    for item in rows:
        rel = item['path']
        path = PurePosixPath(rel)
        if path.is_absolute() or '..' in path.parts or str(path) != rel or '\\' in rel:
            errors.append('unsafe-path:' + rel)
            continue
        if rel in seen:
            errors.append('duplicate-path:' + rel)
        seen.add(rel)
        if any(part.startswith('.env') or part in {'.git', '.aws', 'credentials'} for part in path.parts):
            errors.append('private-path:' + rel)
            continue
        file = root / rel
        if any((root / Path(*path.parts[:i])).is_symlink() for i in range(1, len(path.parts) + 1)) or not file.is_file():
            errors.append('not-regular-file:' + rel)
            continue
        if (file.stat().st_size != item['bytes'] or
                format(stat.S_IMODE(file.stat().st_mode), '06o') != item['mode'] or
                hashlib.sha256(file.read_bytes()).hexdigest() != item['sha256']):
            errors.append('pin-mismatch:' + rel)
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() or p.is_symlink()}
    errors.extend('unlisted-path:' + p for p in sorted(actual - seen))
    errors.extend('required-path-missing:' + p for p in sorted(REQUIRED - seen))
    if sum(p.startswith('prisma/migrations/') and p.endswith('/migration.sql') for p in seen) != 127:
        errors.append('final-migration-count')
    if sum(p.startswith('src/generated/prisma/') for p in seen) != 459:
        errors.append('generated-client-count')
    return {'admitted': not errors, 'files': len(seen), 'errors': errors,
            'scope': 'offline context integrity only; no DB, Linux image or release acceptance'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    try:
        result = audit(args.root, args.manifest, args.sha256)
    except (OSError, ValueError, KeyError, TypeError) as error:
        result = {'admitted': False, 'errors': ['invalid-input:' + str(error)]}
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['admitted'] else 1)
