"""Run the unchanged fixed-127 source tests against their exact preserved Git bytes.

The evolving application is not an approved initializer. Never regenerate its
frozen pins to make these tests pass, execute captured code, or contact a DB.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE_REVISION = '96969faa8e0451bb4058cf6f77d7d0405eaeb388'
SOURCE_PINS_SHA256 = '3b801fd6974fa2b774c39255e7bb8fb82f16034539830ddb3f081d1a183d1a16'


def git_bytes(relative):
    return subprocess.run(
        ['git', 'show', f'{SOURCE_REVISION}:{relative}'], cwd=ROOT,
        check=True, capture_output=True,
    ).stdout


def materialize(destination):
    pins = git_bytes('initializer-source-pins.json')
    if hashlib.sha256(pins).hexdigest() != SOURCE_PINS_SHA256:
        raise ValueError('Preserved initializer pin identity mismatch')
    records = json.loads(pins)
    if len(records) != 159 or len({record['path'] for record in records}) != 159:
        raise ValueError('Preserved initializer source membership mismatch')
    for record in records:
        relative = Path(record['path'])
        if relative.is_absolute() or '..' in relative.parts or relative.as_posix() != record['path']:
            raise ValueError('Unsafe preserved source path')
        content = git_bytes(record['path'])
        if len(content) != record['bytes'] or hashlib.sha256(content).hexdigest() != record['sha256']:
            raise ValueError(f'Preserved source pin mismatch: {record["path"]}')
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        target.chmod(int(record['mode'], 8))
    for control in ['initializer-source-pins.json', 'initializer-context-manifest.json',
                    'production-source-manifest.json']:
        (destination / control).write_bytes(git_bytes(control))
    # The actual unchanged auditor checks its independently pinned control hashes,
    # all source bytes/modes, exact migration membership and literal import closure.


def main():
    with tempfile.TemporaryDirectory(prefix='initializer-source-tests-') as directory:
        destination = Path(directory)
        materialize(destination)
        result = subprocess.run(
            [sys.executable, '-B', 'tests/aws-context_test.py'], cwd=ROOT,
            env={**os.environ, 'INITIALIZER_SOURCE_ROOT': str(destination),
                 'PYTHONDONTWRITEBYTECODE': '1'},
        )
        return result.returncode


if __name__ == '__main__':
    sys.exit(main())
