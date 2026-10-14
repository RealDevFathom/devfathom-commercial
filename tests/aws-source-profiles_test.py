"""Root/profile boundary checks; optional exact source roots contain no runtime actions."""
import shutil
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLING = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('context', TOOLING / 'scripts/aws-context.py')
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)
spec = importlib.util.spec_from_file_location('integrity', TOOLING / 'scripts/aws-initializer-context.py')
integrity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integrity)


class ProfileBoundaryTests(unittest.TestCase):
    def test_registry_identities_are_distinct_and_fixed127(self):
        old = context.initializer_profile('initializer-final127')
        current = context.initializer_profile('initializer-final127-catalog')
        self.assertNotEqual(old['sourcePinsSha256'], current['sourcePinsSha256'])
        self.assertNotEqual(old['executableManifestSha256'], current['executableManifestSha256'])
        self.assertEqual(old['schemaSha256'], current['schemaSha256'])
        for item in [old, current]:
            self.assertEqual((item['sourceCount'], item['migrationCount'], item['generatedCount'], item['executableCount']), (159, 127, 459, 1820))

    def test_unknown_and_application_profiles_fail(self):
        for name in ['', 'unknown', 'application132', '0' * 64]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'non-initializer'):
                context.initializer_profile(name)

    def test_registry_tamper_fails(self):
        with patch.object(context, 'SOURCE_PROFILES_SHA256', '0' * 64):
            with self.assertRaisesRegex(ValueError, 'registry mismatch'):
                context.initializer_profile('initializer-final127')

    def test_target_policy_is_never_read(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            (root / 'source-profiles.json').write_text('{"profiles":{"evil":{}}}')
            with patch.object(Path, 'cwd', return_value=root):
                self.assertEqual(context.initializer_profile('initializer-final127')['migrationCount'], 127)
                with self.assertRaises(ValueError):
                    context.initializer_profile('evil')

    def test_missing_root_never_falls_back(self):
        with tempfile.TemporaryDirectory() as t, self.assertRaises(FileNotFoundError):
            context.selected_root(Path(t) / 'missing')

    def test_relative_control_resolves_only_inside_selected_root(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            (root / 'manifest.json').write_text('[]')
            self.assertEqual(context.control_file(root, 'manifest.json'), root / 'manifest.json')
            self.assertEqual(context.control_file(root, root / 'manifest.json'), root / 'manifest.json')

    def test_traversal_absolute_escape_and_control_symlinks_fail_before_read(self):
        with tempfile.TemporaryDirectory() as t:
            parent = Path(t); root = parent / 'root'; root.mkdir()
            outside = parent / 'outside'; outside.write_text('synthetic sentinel')
            (root / 'link').symlink_to(outside)
            (root / 'directory').symlink_to(parent, target_is_directory=True)
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('outside bytes read')):
                for name in ['../outside', outside, 'link', 'directory/outside', 'x/../outside']:
                    with self.subTest(name=str(name)), self.assertRaises(ValueError):
                        context.control_file(root, name)

    def test_all_controls_validated_before_any_source_read(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            for name in ['production-source-manifest.json', 'initializer-source-pins.json', 'prisma/fresh-database-manifest.json']:
                f = root / name; f.parent.mkdir(parents=True, exist_ok=True); f.write_text('[]')
            (root / 'initializer-context-manifest.json').symlink_to(root.parent / 'outside')
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('premature content read')):
                with self.assertRaisesRegex(ValueError, 'symlink'):
                    context.initializer_audit(root, Path('initializer-context-manifest.json'))

    def test_private_controls_are_rejected_before_any_content_read(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            for name in ['production-source-manifest.json', 'initializer-source-pins.json', 'prisma/fresh-database-manifest.json']:
                f = root / name; f.parent.mkdir(parents=True, exist_ok=True); f.write_text('[]')
            names = ['.env.synthetic', '.aws/credentials', 'node_modules/manifest.json',
                     'fixtures/manifest.json', 'uploads/manifest.json', 'dump.sql']
            for name in names:
                f = root / name; f.parent.mkdir(parents=True, exist_ok=True); f.write_text('synthetic sentinel')
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('private content read')), \
                    patch.object(Path, 'read_text', side_effect=AssertionError('private content read')):
                for name in names:
                    with self.subTest(path=name), self.assertRaisesRegex(ValueError, 'Prohibited control'):
                        context.initializer_audit(root, Path(name))

    def test_scanner_cwd_is_trusted_tooling(self):
        completed = subprocess.CompletedProcess([], 0, '{"imports":[],"errors":[]}', '')
        with patch.object(context.subprocess, 'run', return_value=completed) as run:
            context.scan_imports([{'path':'a.ts','text':'export {};'}])
            self.assertEqual(run.call_args.kwargs['cwd'], TOOLING)

    def test_guard_uses_selected_cwd_and_rejects_sibling_and_symlink_modules(self):
        with tempfile.TemporaryDirectory() as t:
            parent = Path(t); root = parent / 'initializer'; root.mkdir()
            sibling = parent / 'application'; sibling.mkdir()
            for extension in ['cjs', 'mjs']:
                (root / ('inside.' + extension)).write_text('console.log("INSIDE");')
                (sibling / ('outside.' + extension)).write_text('console.log("OUTSIDE_SENTINEL");')
                (root / ('link.' + extension)).symlink_to(sibling / ('outside.' + extension))
                for name, expected in [('inside', 0), ('link', 1), ('../application/outside', 1)]:
                    relative = './' + name + '.' + extension
                    code = ('require(' + json.dumps(relative) + ');' if extension == 'cjs'
                            else 'await import(' + json.dumps(relative) + ');')
                    command = [shutil.which('node'), '--require', str(TOOLING / 'scripts/aws-initializer-offline-guard.cjs')]
                    probe = root / ('probe.' + extension)
                    probe.write_text(code)
                    result = subprocess.run(command + [str(probe)], cwd=root, timeout=10, text=True, capture_output=True,
                                            env={'PATH':os.environ.get('PATH', '/usr/bin:/bin'), 'TMPDIR':t,
                                                 'CONTEXT_TRACE':str(parent / 'trace.json')})
                    with self.subTest(extension=extension, name=name):
                        self.assertEqual(result.returncode, expected, result.stderr)
                        self.assertNotIn('OUTSIDE_SENTINEL', result.stdout)
                        self.assertIn('INSIDE' if expected == 0 else 'outside executable context',
                                      result.stdout if expected == 0 else result.stderr)

    def test_fully_manifested132_or460_still_denied(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / 'context'; root.mkdir(); manifest = Path(t) / 'manifest.json'
            paths = set(integrity.REQUIRED)
            paths.update(f'prisma/migrations/synthetic_{i}/migration.sql' for i in range(132))
            paths.update(f'src/generated/prisma/synthetic_{i}.ts' for i in range(459))
            rows = []
            for name in sorted(paths):
                f = root / name; f.parent.mkdir(parents=True, exist_ok=True); f.write_bytes(b'')
                rows.append({'path':name,'sha256':hashlib.sha256(b'').hexdigest(),'bytes':0,'mode':format(f.stat().st_mode & 0o7777, '06o')})
            manifest.write_text(json.dumps(rows))
            result = integrity.audit(root, manifest, hashlib.sha256(manifest.read_bytes()).hexdigest())
            self.assertFalse(result['admitted'])
            self.assertIn('final-migration-count', result['errors'])
            self.assertIn('generated-client-count', result['errors'])


@unittest.skipUnless(os.environ.get('INITIALIZER_SOURCE_ROOT') and os.environ.get('LEGACY_INITIALIZER_SOURCE_ROOT'),
                     'Exact preserved initializer source profiles were not supplied')
class PreservedProfileTests(unittest.TestCase):
    def setUp(self):
        self.root = context.selected_root(os.environ['INITIALIZER_SOURCE_ROOT'])
        self.legacy = context.selected_root(os.environ['LEGACY_INITIALIZER_SOURCE_ROOT'])

    def audit(self, root=None, name='initializer-final127-catalog'):
        return context.initializer_audit(root or self.root, Path('initializer-context-manifest.json'), name)

    def test_both_exact_profiles_pass_and_cross_profile_fails(self):
        for root, name, other in [(self.root, 'initializer-final127-catalog', 'initializer-final127'),
                                  (self.legacy, 'initializer-final127', 'initializer-final127-catalog')]:
            with self.subTest(profile=name):
                result = self.audit(root, name)
                self.assertTrue(result['admitted'], result['errors'])
                self.assertEqual((result['includedCount'], result['generatedCount']), (159, 459))
                with self.assertRaisesRegex(ValueError, 'source pins mismatch'):
                    self.audit(root, other)

    def test_explicit_empty_profile_never_downgrades_to_source_only(self):
        with self.assertRaisesRegex(ValueError, 'non-initializer'):
            self.audit(name='')
        command = [sys.executable, '-B', str(TOOLING / 'scripts/aws-context.py'), '--context', 'initializer',
                   '--root', str(self.root), '--initializer-profile', '']
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)['admitted'])

    def test_schema_and_generated_bytes_tamper_fail(self):
        original = Path.read_bytes
        for name in ['prisma/schema.prisma', 'src/generated/prisma/client.ts']:
            file = self.root / name
            def read(p):
                return original(p) + (b'changed' if p == file else b'')
            with self.subTest(path=name), patch.object(Path, 'read_bytes', read):
                result = self.audit()
                self.assertFalse(result['admitted'])
                self.assertIn({'path':name,'reason':'pin-mismatch'}, result['errors'])

    def test_generated_missing_or_symlink_file_fails(self):
        original = Path.is_file
        target = self.root / 'src/generated/prisma/client.ts'
        with patch.object(Path, 'is_file', lambda p: False if p == target else original(p)):
            self.assertIn({'path':'src/generated/prisma/client.ts','reason':'not-regular-file'}, self.audit()['errors'])
        original_link = Path.is_symlink
        with patch.object(Path, 'is_symlink', lambda p: True if p == target else original_link(p)):
            self.assertIn({'path':'src/generated/prisma/client.ts','reason':'not-regular-file'}, self.audit()['errors'])

    def test_generated_manifest_tamper_fails(self):
        original = Path.read_bytes; target = self.root / 'generated-client-manifest.json'
        with patch.object(Path, 'read_bytes', lambda p: b'[]' if p == target else original(p)):
            with self.assertRaisesRegex(ValueError, 'generated client manifest mismatch'):
                self.audit()

    def test_cli_explicit_root_ignores_conflicting_cwd_and_missing_does_not_fallback(self):
        with tempfile.TemporaryDirectory() as t:
            app = Path(t); (app / 'prisma').mkdir(); (app / 'prisma/schema.prisma').write_text('conflicting application')
            command = [sys.executable, '-B', str(TOOLING / 'scripts/aws-context.py'), '--context', 'initializer',
                       '--initializer-profile', 'initializer-final127-catalog', '--root']
            result = subprocess.run(command + [str(self.root)], cwd=app, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['root'], str(self.root))
            result = subprocess.run(command + [str(app / 'missing')], cwd=self.root, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(result.stdout)['admitted'])
            result = subprocess.run(command + [str(self.root), '--sha256', '0' * 64], cwd=app, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
