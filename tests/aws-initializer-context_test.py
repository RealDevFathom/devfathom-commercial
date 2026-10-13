"""Focused integrity regressions; no initializer code execution."""
import hashlib
import importlib.util
import json
import os
from unittest.mock import patch
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('initializer_context', Path(__file__).parents[1] / 'scripts/aws-initializer-context.py')
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)


class IntegrityTests(unittest.TestCase):
    def audit(self, root, manifest, rows):
        manifest.write_text(json.dumps(rows))
        return context.audit(root, manifest, hashlib.sha256(manifest.read_bytes()).hexdigest())

    def test_full_permission_bits_are_pinned(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / 'root'
            paths = set(context.REQUIRED)
            paths.update(f'prisma/migrations/synthetic_{i}/migration.sql' for i in range(125))
            paths.update(f'src/generated/prisma/synthetic_{i}.ts' for i in range(458))
            for rel in paths:
                file = root / rel
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'')
                file.chmod(0o644)
            rows = [{'path':rel, 'bytes':0, 'mode':'000644',
                     'sha256':hashlib.sha256(b'').hexdigest()} for rel in sorted(paths)]
            manifest = Path(t) / 'manifest.json'
            self.assertTrue(self.audit(root, manifest, rows)['admitted'])
            file = root / 'package.json'
            original_stat = Path.stat
            # Some sandbox filesystems strip setuid/setgid on chmod. Supply real
            # stat_result values with only those mode bits changed to test the
            # comparison deterministically without requiring special privileges.
            for bit in (0o4000, 0o2000, 0o1000):
                with self.subTest(special_bit=oct(bit)):
                    def with_special_bits(path, *args, **kwargs):
                        result = original_stat(path, *args, **kwargs)
                        if path == file:
                            fields = list(result)
                            fields[0] |= bit
                            return os.stat_result(fields)
                        return result
                    with patch.object(Path, 'stat', with_special_bits):
                        self.assertEqual(file.stat().st_mode & 0o7777, 0o644 | bit)
                        result = self.audit(root, manifest, rows)
                    self.assertFalse(result['admitted'])
                    self.assertIn('pin-mismatch:package.json', result['errors'])
            file.chmod(0o644)
            self.assertTrue(self.audit(root, manifest, rows)['admitted'])

    def test_manifest_hash_is_external(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / 'manifest.json'
            p.write_text('[]')
            self.assertEqual(context.audit(Path(t), p, '0' * 64)['errors'], ['manifest-hash-mismatch'])

    def test_paths_cannot_escape(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t)
            for rel in ['../outside', '/absolute', 'a/../outside', 'a\\outside']:
                result = self.audit(p, p/'manifest.json', [{'path': rel}])
                self.assertIn('unsafe-path:' + rel, result['errors'])

    def test_symlink_is_not_read(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t)
            (p/'link').symlink_to('/missing-private-file')
            result = self.audit(p, p/'manifest.json', [{'path': 'link'}])
            self.assertIn('not-regular-file:link', result['errors'])

    def test_private_path_is_not_read(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t)
            result = self.audit(p, p/'manifest.json', [{'path': '.env.production'}])
            self.assertIn('private-path:.env.production', result['errors'])

    def test_missing_required_and_unlisted_files_fail(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t)
            (p/'unexpected').write_text('synthetic')
            result = self.audit(p, p/'manifest.json', [])
            self.assertIn('unlisted-path:unexpected', result['errors'])
            self.assertIn('required-path-missing:prisma/fresh-database-runner.ts', result['errors'])
            self.assertFalse(result['admitted'])

    def test_tamper_and_duplicate_are_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t)
            (p/'source.ts').write_text('synthetic')
            row = {'path':'source.ts', 'bytes':9, 'mode':format((p/'source.ts').stat().st_mode & 0o777, '06o'), 'sha256':'0'*64}
            result = self.audit(p, p/'manifest.json', [row, row])
            self.assertIn('pin-mismatch:source.ts', result['errors'])
            self.assertIn('duplicate-path:source.ts', result['errors'])


if __name__ == '__main__':
    unittest.main()
