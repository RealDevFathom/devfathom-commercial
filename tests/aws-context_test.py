"""Focused filesystem and literal Dockerignore contract checks; no external calls."""
import hashlib
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
import json
import os
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('aws_context', Path(__file__).parents[1] / 'scripts/aws-context.py')
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)


def initializer_root():
    # A composed application may evolve separately from the fixed127 initializer.
    # An explicitly selected missing root must fail rather than fall back.
    return context.selected_root(os.environ.get('INITIALIZER_SOURCE_ROOT', Path(__file__).parents[1]))


class ContextTests(unittest.TestCase):
    def test_dependency_patch_is_allowed_but_arbitrary_patches_are_not(self):
        self.assertEqual(context.category("patches/deepmerge@4.3.1.patch"), "not-required")
        self.assertEqual(context.category("patches/other.patch"), "artifacts-credentials")

    def test_comments_strings_templates_and_regex_are_not_imports(self):
        source = r'''// import x from '@/missing-comment';
/* import('@/missing-block'); require('@/missing-require'); */
const a = "import x from '@/missing-string'";
const b = 'require("@/missing-single")';
const c = `import('@/missing-template') ${"from '@/missing-expression-text'"}`;
const d = /import\('missing-regex'\)/;
const e = { from: '@/missing-property', import: '@/missing-key' };
'''
        self.assertEqual(context.scan_imports([{'path': 'src/a.ts', 'text': source}]),
                         {'imports': [], 'errors': []})

    def test_all_module_syntax_and_multiline_line_numbers(self):
        source = '''import './side-effect';
import type {
  Thing
} from './types';
export { value } from './reexport';
export type { Other } from './export-type';
const a = import(
  './dynamic'
);
const b = require /* comment */ ('./required');
import legacy = require('./legacy');
type T = import('./type-query').T;
const c = `text ${import('./inside-template')}`;
const d = import(`./literal-template`);
'''
        result = context.scan_imports([{'path': 'src/a.ts', 'text': source}])
        self.assertEqual(result['errors'], [])
        self.assertEqual([(i['import'], i['line']) for i in result['imports']], [
            ('./side-effect', 1), ('./types', 2), ('./reexport', 5),
            ('./export-type', 6), ('./dynamic', 7), ('./required', 10),
            ('./legacy', 11), ('./type-query', 12), ('./inside-template', 13),
            ('./literal-template', 14),
        ])

    def test_real_missing_modules_fail_after_comment_noise_is_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'src').mkdir()
            (root / 'src/app.ts').write_text('''/* import x from './comment'; */
import './present';
import type { Missing } from './absent-type';
const load = () => import('./absent-runtime');
''')
            (root / 'src/present.ts').write_text('export {};\n')
            result = context.audit(root, {'src/app.ts', 'src/present.ts'})
            self.assertFalse(result['admitted'])
            self.assertEqual([(e['import'], e['line']) for e in result['errors']],
                             [('./absent-type', 3), ('./absent-runtime', 4)])

    def test_parser_failure_denies_admission(self):
        with patch.object(context.subprocess, 'run', side_effect=FileNotFoundError):
            self.assertEqual(context.scan_imports([{'path': 'src/a.ts', 'text': ''}])['errors'],
                             [{'reason': 'typescript-parser-unavailable-or-failed'}])

    def test_malformed_and_computed_imports_fail_closed(self):
        for source, reason in [("import {", 'source-parse-error'),
                               ('import(moduleName)', 'nonliteral-module-reference'),
                               ('require(`./${name}`)', 'nonliteral-module-reference')]:
            with self.subTest(source=source):
                result = context.scan_imports([{'path': 'src/a.ts', 'text': source}])
                self.assertIn(reason, [e['reason'] for e in result['errors']])

    def test_exact_membership_and_escaped_route(self):
        entries = context.load_allowlist('**\n!src/app/\\[id\\]/page.tsx\n!public/icon.svg\n')
        self.assertIn('src/app/[id]/page.tsx', entries)
        for path in ['src/app/i/page.tsx', 'public/new.svg', 'public/icon.svg/secret', '.env', '.env.example', 'src/.env.production', 'node_modules/a.js', '.git/config', '.agents/a', '.codex/a', '.aws/credentials', 'tests/demo.ts', 'prisma/seed.ts', 'public/uploads/a.png', 'private-uploads/a', 'source.patch', 'evidence/report.json', 'backup.tar.gz', 'dump.sql', 'credentials.json']:
            self.assertNotIn(path, entries, path)

    def test_reject_nonliteral_or_unsafe_rules(self):
        for text in ['!src/app.ts', '**\n!src/**', '**\n!../escape', '**\n!/absolute', '**\n!src\n!src/a.ts', '**\n!a\n!a']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                context.load_allowlist(text)

    def test_real_files_excluded_without_reading(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'public').mkdir()
            (root / 'public/icon.svg').write_text('<svg/>')
            (root / '.env').mkdir()  # Even a non-file forbidden path is never read.
            (root / 'public/upload.png').write_text('inert fixture')
            result = context.audit(root, {'public/icon.svg'})
            self.assertTrue(result['admitted'])
            self.assertEqual(result['includedCount'], 1)
            self.assertEqual(result['excludedCount'], 1)
            self.assertEqual(result['included'][0]['bytes'], 6)

    def test_symlink_and_missing_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'linked.ts').symlink_to('missing.ts')
            result = context.audit(root, {'linked.ts', 'absent.ts'})
            self.assertFalse(result['admitted'])
            self.assertEqual({e['reason'] for e in result['errors']}, {'missing', 'not-regular-file'})

    def test_forbidden_exception_rejected_before_content_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.env.example').write_text('inert')
            result = context.audit(root, {'.env.example'})
            self.assertEqual(result['included'], [])
            self.assertEqual(result['errors'][0]['reason'], 'prohibited-category')

    def test_import_closure_detects_excluded_demo_and_allows_generated_prisma(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'src').mkdir()
            (root / 'src/app.ts').write_text("import { x } from '@/lib/demo/personas';\nimport { Prisma } from '@/generated/prisma/client';\n")
            result = context.audit(root, {'src/app.ts'})
            self.assertFalse(result['admitted'])
            self.assertEqual(len(result['errors']), 1)
            self.assertEqual(result['errors'][0]['import'], '@/lib/demo/personas')

    def test_composition_default_never_silently_selects_production(self):
        clean = {'errors': [], 'admitted': True}
        self.assertFalse(context.select_composition(copy.deepcopy(clean), 'existing-demo')['admitted'])
        self.assertTrue(context.select_composition(copy.deepcopy(clean), 'production-safe')['admitted'])
        dirty = {'errors': [{'reason': 'local-import-excluded-or-unresolved'}], 'admitted': False}
        self.assertFalse(context.select_composition(dirty, 'production-safe')['admitted'])
        with self.assertRaises(ValueError):
            context.select_composition(clean, 'auto')

    def test_both_compositions_retain_forbidden_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.env.synthetic').write_text('inert')
            for mode in ['production-safe', 'existing-demo']:
                result = context.select_composition(context.audit(root, {'.env.synthetic'}), mode)
                self.assertFalse(result['admitted'])
                self.assertIn('prohibited-category', [e['reason'] for e in result['errors']])

    def test_route_exceptions_do_not_admit_neighbor_payloads(self):
        for path in context.SOURCE_ROUTE_EXCEPTIONS:
            self.assertEqual(context.category(path), 'not-required')
            self.assertNotEqual(context.category(path + '.fixture.ts'), 'not-required')
        for path in ['src/app/api/v1/spec/payload.json', 'src/app/api/restaurant/sop/evidence/raw.json']:
            self.assertNotEqual(context.category(path), 'not-required')

    def test_root_configuration_imports_are_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'next.config.ts').write_text("import './missing-config';")
            result = context.audit(root, {'next.config.ts'})
            self.assertEqual(result['errors'][0]['import'], './missing-config')

    def test_guard_exceptions_are_exact_and_payloads_stay_forbidden(self):
        for path in context.SOURCE_GUARD_EXCEPTIONS:
            self.assertEqual(context.category(path), 'not-required')
            for suffix in ['.fixture.ts', '/payload.json', '.test.ts']:
                self.assertNotEqual(context.category(path + suffix), 'not-required')
        for path in ['src/lib/demo/isolation-payload.ts', 'src/lib/demo/personas.ts',
                     'src/lib/tenancy/demo-payload.ts',
                     'src/lib/restaurant/menu-import-fixture-runtime.ts']:
            self.assertNotEqual(context.category(path), 'not-required')

    def test_emitted_js_specifiers_resolve_source_but_missing_still_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'caller.ts').write_text("import './present.js'; import './absent.js';")
            (root / 'present.ts').write_text('export {};')
            errors = context.import_errors(root, [{'path': p} for p in ['caller.ts', 'present.ts']])
            self.assertEqual([e['import'] for e in errors], ['./absent.js'])

    def test_initializer_rejects_manifest_omission_and_pin_tampering(self):
        import json
        root = initializer_root()
        with tempfile.TemporaryDirectory(dir=root) as tmp:
            manifest = Path(tmp) / 'manifest.json'
            records = json.loads((root / 'initializer-context-manifest.json').read_text())
            manifest.write_text(json.dumps(records[:-1]))
            self.assertFalse(context.initializer_audit(root, manifest)['admitted'])
        with patch.object(context, 'INITIALIZER_SOURCE_PINS_SHA256', '0' * 64):
            with self.assertRaisesRegex(ValueError, 'source pins mismatch'):
                context.initializer_audit(root, root / 'initializer-context-manifest.json')

    def test_initializer_source_closure_does_not_ignore_missing_imports(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'guard.ts').write_text("export { writer } from './missing-writer.js';")
            errors = context.import_errors(root, [{'path': 'guard.ts'}])
            self.assertEqual(errors[0]['reason'], 'local-import-excluded-or-unresolved')

    def test_generated_prisma_exception_has_directory_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'app.ts').write_text("import '@/generated/prisma-imposter';")
            self.assertFalse(context.audit(root, {'app.ts'})['admitted'])

    def test_initializer_pins_preserve_demo_named_ddl(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = 'prisma/migrations/20260101_demo/migration.sql'
            file = root / path
            file.parent.mkdir(parents=True)
            file.write_text('-- inert synthetic DDL\n')
            record = {'path': path, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                      'bytes': file.stat().st_size, 'mode': format(file.stat().st_mode & 0o777, '06o')}
            self.assertTrue(context.validate_pinned_files(root, [record], [record])['admitted'])
            self.assertFalse(context.audit(root, {path})['admitted'])
            self.assertFalse(context.validate_pinned_files(root, [], [record])['admitted'])
            file.write_text('-- changed\n')
            self.assertFalse(context.validate_pinned_files(root, [record], [record])['admitted'])

    def test_initializer_symlink_and_path_escape_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / 'migration.sql'
            file.symlink_to('absent.sql')
            for path in ['migration.sql', '../migration.sql']:
                record = {'path': path}
                self.assertFalse(context.validate_pinned_files(root, [record], [record])['admitted'])

    def test_final_database_pins_reject_historical_and_final_set_tampering(self):
        root = initializer_root()
        expected = json.loads((root / 'initializer-source-pins.json').read_text())
        historical = [r for r in json.loads((root / 'production-source-manifest.json').read_text())
                      if r['path'].startswith('prisma/migrations/')]
        final = json.loads((root / 'prisma/fresh-database-manifest.json').read_text())
        context.validate_final_database_pins(expected, historical, final)
        old_sql = next(r['path'] for r in historical if r['path'].endswith('/migration.sql'))
        variants = []
        for path in [old_sql, 'prisma/schema.prisma']:
            variants.append([{**r, 'sha256': '0' * 64} if r['path'] == path else r for r in expected])
        variants.append([r for r in expected if r['path'] != old_sql])
        variants.append(expected + [{**next(r for r in expected if r['path'] == old_sql),
                                     'path': 'prisma/migrations/unapproved/migration.sql'}])
        variants.append(expected + [expected[0]])
        for changed in variants:
            with self.subTest(paths=len(changed)), self.assertRaises(ValueError):
                context.validate_final_database_pins(changed, historical, final)

    def test_current_initializer_manifest_and_font_notices(self):
        root = initializer_root()
        result = context.initializer_audit(root, root / 'initializer-context-manifest.json')
        self.assertTrue(result['admitted'], result['errors'])
        self.assertEqual(sum(i['path'].endswith('/migration.sql') for i in result['included']), 127)
        entries = context.load_allowlist((Path(__file__).parents[1] / 'Dockerfile.aws.dockerignore').read_text())
        self.assertEqual(sum(p.endswith('.woff2') for p in entries), 17)
        self.assertEqual(sum(p.startswith('public/licenses/') and p.endswith('-OFL.txt') for p in entries), 2)

    def test_repository_allowlist_has_no_directory_or_prohibited_exceptions(self):
        root = Path(__file__).parents[1]
        entries = context.load_allowlist((root / 'Dockerfile.aws.dockerignore').read_text())
        self.assertGreater(len(entries), 0)
        for path in entries:
            self.assertTrue((root / path).is_file(), path)
            self.assertEqual(context.category(path), 'not-required', path)


if __name__ == '__main__':
    unittest.main()
